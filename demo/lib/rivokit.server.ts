/**
 * Server-only RivoKit wiring for the demo.
 *
 * This is the SAME composition scripts/live-sdk.mjs proves — store, escrow (with
 * a Circle operator relay), settlement-fx, bridge, compliance, and an injected
 * gasless FundExecutor — built once and driven by the demo's server actions.
 *
 * It must NEVER be imported from a client component: it reads server-only
 * secrets (Circle API key, the demo buyer's private key, the Supabase service
 * key). The demo signs on the buyer's behalf with a testnet key from .env.local
 * — a demo shortcut. In production the buyer signs in their own wallet; the
 * gasless authorization (src/escrow/erc3009.ts) is designed for exactly that.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppKit, BridgeChain } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, sepolia } from "viem/chains";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { createCircleClient } from "../../scripts/lib/circle.mjs";
import { installCircleDnsPinning } from "../../src/lib/circle-dns.ts";
import { arcTransport, sleep } from "../../src/lib/rpc.ts";
import { ARC_TESTNET_CHAIN_ID, EURC_ADDRESS, USDC_ADDRESS } from "../../src/constants/arc.ts";
import { receiveAuthorizationTypedData } from "../../src/escrow/erc3009.ts";
import { ESCROW_SIGNATURES } from "../../src/escrow/abi.ts";
import { createEscrow } from "../../src/escrow/operations.ts";
import { createSettlementFx } from "../../src/settlement-fx/swap.ts";
import { createBridge } from "../../src/funding/bridge.ts";
import { createUnifiedBalance } from "../../src/funding/unified-balance.ts";
import { createOrderStore } from "../../src/orchestrator/order-store.ts";
import { createComplianceGate, createCircleScreener } from "../../src/events/compliance.ts";
import { createRivoKit, paymentInfoFromRecord } from "../../src/sdk/rivokit.ts";

// Next loads .env from the app dir (demo/), but the credentials live in the
// repo-root .env.local. Load it here so the same file drives scripts and demo.
function loadRootEnv() {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    const key = m?.[1];
    const val = m?.[2];
    if (key && val && process.env[key] == null) process.env[key] = val;
  }
}
loadRootEnv();

const need = (key: string): string => {
  const v = process.env[key];
  if (v == null || v === "") throw new Error(`env ${key} kosong — cek .env.local`);
  return v;
};

// This network hijacks Circle's DNS — pin before any SDK call.
installCircleDnsPinning();

let cached: ReturnType<typeof build> | null = null;

function build() {
  const ESCROW = getAddress(need("NEXT_PUBLIC_RIVO_ESCROW_ADDRESS"));
  const TOKEN_COLLECTOR = getAddress(need("NEXT_PUBLIC_RIVO_TOKEN_COLLECTOR_ADDRESS"));
  const REFUND_COLLECTOR = getAddress(need("NEXT_PUBLIC_RIVO_REFUND_COLLECTOR_ADDRESS"));
  const OPERATOR = getAddress(need("OPERATOR_ADDRESS"));
  const MERCHANT = getAddress(need("MERCHANT_ADDRESS"));
  const buyer = privateKeyToAccount(need("BUYER_PRIVATE_KEY") as Hex);

  const arcClient = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
  const buyerWallet = createWalletClient({ account: buyer, chain: arcTestnet, transport: arcTransport() });
  const circle = createCircleClient({ apiKey: need("CIRCLE_API_KEY"), entitySecret: need("CIRCLE_ENTITY_SECRET") });
  const store = createOrderStore(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SECRET_KEY"));

  const toTuple = (pi: Record<string, unknown>) => [
    pi.operator, pi.payer, pi.receiver, pi.token, String(pi.maxAmount),
    String(pi.preApprovalExpiry), String(pi.authorizationExpiry), String(pi.refundExpiry),
    String(pi.minFeeBps), String(pi.maxFeeBps), pi.feeReceiver, String(pi.salt),
  ];

  const operatorSender = async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
    const tx = await circle.contractExecution({
      walletId: need("OPERATOR_WALLET_ID"),
      contractAddress: ESCROW,
      abiFunctionSignature: ESCROW_SIGNATURES[functionName as keyof typeof ESCROW_SIGNATURES],
      abiParameters: args.map((a) =>
        a && typeof a === "object" && "operator" in a ? toTuple(a as Record<string, unknown>) : typeof a === "bigint" ? a.toString() : a,
      ),
    });
    for (let i = 0; i < 60; i++) {
      await sleep(3000);
      const t = await circle.getTransaction(tx.id);
      const s = t.transaction?.state;
      if (s && ["COMPLETE", "CONFIRMED"].includes(s)) return { txHash: t.transaction!.txHash as Hex };
      if (s && ["FAILED", "CANCELLED", "DENIED"].includes(s)) {
        throw new Error(`${functionName} ${s}: ${t.transaction?.errorReason ?? "tanpa alasan"}`);
      }
    }
    throw new Error(`${functionName}: timeout`);
  };

  const escrow = createEscrow({ escrowAddress: ESCROW, publicClient: arcClient as never, operator: operatorSender });
  const fx = createSettlementFx({
    kitKey: need("KIT_KEY"), circleApiKey: need("CIRCLE_API_KEY"), circleEntitySecret: need("CIRCLE_ENTITY_SECRET"),
  });

  // Funding rails share one App Kit. The buyer's adapters let the demo move USDC
  // onto Arc from Sepolia (bridge) or Gateway (unified balance) before authorize.
  const appKit = new AppKit();
  const bridge = createBridge(appKit);
  const ub = createUnifiedBalance(appKit);
  const KIT_KEY = need("KIT_KEY");
  const BUYER_PK = need("BUYER_PRIVATE_KEY") as Hex;
  // `chain` is honoured at runtime (proven in scripts/live-*.mjs) but absent from
  // the adapter's published type, hence the cast.
  const arcAdapter = createViemAdapterFromPrivateKey({ privateKey: BUYER_PK, chain: BridgeChain.Arc_Testnet } as never);
  const sepAdapter = createViemAdapterFromPrivateKey({ privateKey: BUYER_PK, chain: BridgeChain.Ethereum_Sepolia } as never);

  const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238" as const;
  const sepoliaClient = createPublicClient({ chain: sepolia, transport: http() });
  const erc20Balance = (client: typeof arcClient, token: Address, owner: string) =>
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner as Address] });

  /** Live wallet balances for the marketplace header (before/after transactions). */
  async function balances() {
    const [buyerArcUsdc, buyerSepUsdc, sellerEurc] = await Promise.all([
      erc20Balance(arcClient, USDC_ADDRESS, buyer.address),
      sepoliaClient.readContract({ address: SEPOLIA_USDC, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] }),
      erc20Balance(arcClient, EURC_ADDRESS, MERCHANT),
    ]);
    let gateway = 0n;
    try { gateway = (await ub.getBalance(sepAdapter)).confirmedMinor; } catch { /* Gateway unreachable — show 0 */ }
    return {
      buyerArcUsdc: buyerArcUsdc.toString(),
      buyerSepUsdc: (buyerSepUsdc as bigint).toString(),
      buyerGatewayUsdc: gateway.toString(),
      sellerEurc: sellerEurc.toString(),
    };
  }

  const gate = createComplianceGate(
    createCircleScreener((path, body) => circle.request("POST", path, body), () => randomUUID()),
  );

  /** Build the exact ERC-3009 typed data a buyer signs to authorize an order. */
  const authTypedData = (paymentInfo: Record<string, unknown>) =>
    receiveAuthorizationTypedData({
      paymentInfo: paymentInfo as never, chainId: ARC_TESTNET_CHAIN_ID, escrowAddress: ESCROW,
      tokenCollector: TOKEN_COLLECTOR, usdcAddress: USDC_ADDRESS,
    });

  // Gasless same-chain funding: the payer already holds USDC on Arc. Either the
  // buyer signs in their own wallet (browser) and we relay `signature`, or — the
  // demo default — the server signs with a testnet key. Operator relays either
  // way; idempotent so a re-fund is a no-op.
  const fund = async ({ paymentInfo, hash, signature }: { paymentInfo: Record<string, unknown>; hash: Hex; signature?: Hex }) => {
    const ps = await escrow.getPaymentState(hash);
    if (ps.hasCollectedPayment) return { authorizeTxHash: "0xsudah" };
    const sig = signature ?? (await buyerWallet.signTypedData(authTypedData(paymentInfo) as never));
    const auth = await escrow.authorize(paymentInfo as never, (paymentInfo as { maxAmount: bigint }).maxAmount, TOKEN_COLLECTOR, sig);
    return { authorizeTxHash: auth.txHash };
  };

  const kit = createRivoKit({
    store, escrow, fx, bridge, fund: fund as never, compliance: gate,
    config: {
      chainId: ARC_TESTNET_CHAIN_ID, escrowAddress: ESCROW, operator: OPERATOR, token: USDC_ADDRESS as Address,
      refundCollector: REFUND_COLLECTOR, settlementAddress: MERCHANT,
      screeningChain: process.env.CIRCLE_BLOCKCHAIN || "ARC-TESTNET",
    },
  });

  /** Arc USDC balance of an arbitrary address (for a connected browser wallet). */
  const addrArcUsdc = async (address: string) =>
    (await erc20Balance(arcClient, USDC_ADDRESS, getAddress(address))).toString();

  /**
   * The ERC-3009 typed data for a stored order, ready for a browser wallet to sign.
   * `from` is the order's payer — a connected wallet only signs its own orders.
   */
  const authTypedDataFor = async (orderId: string) => {
    const record = await store.get(orderId);
    if (!record) throw new Error("order tak ada");
    return authTypedData(paymentInfoFromRecord(record) as unknown as Record<string, unknown>);
  };

  return {
    kit, store, balances, addrArcUsdc, authTypedDataFor,
    addresses: { buyer: buyer.address as string, merchant: MERCHANT as string },
    funding: {
      bridge, ub, arcAdapter, sepAdapter, buyer: buyer.address as string, kitKey: KIT_KEY,
      chains: { arc: BridgeChain.Arc_Testnet, sepolia: BridgeChain.Ethereum_Sepolia },
    },
  };
}

export function getRivoKit() {
  if (!cached) cached = build();
  return cached;
}
