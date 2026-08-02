/**
 * An EIP-1193 provider backed by a local key — a stand-in for MetaMask in Node.
 *
 * WHY THIS EXISTS
 *
 * `demo/app/wallet-rails.ts` builds its App Kit adapter with
 * `createViemAdapterFromProvider({ provider })`, while every proven script uses
 * `createViemAdapterFromPrivateKey`. Those are different code paths inside App
 * Kit, and only the second had ever run. A rail can be "proven" through one and
 * still be broken through the other — the adapter is where chain selection,
 * signing and transaction submission are actually decided.
 *
 * So this implements the same interface a browser wallet exposes, and nothing
 * more: `request({ method, params })`, an account, a switchable current chain.
 * Reads are proxied to real RPCs, signatures and transactions are produced
 * locally. Anything App Kit asks for that a real wallet would answer, this
 * answers the same way.
 *
 * WHAT IT DOES AND DOES NOT PROVE
 *
 * It proves the provider-based adapter path end-to-end on-chain: the calls App
 * Kit makes, the chain switches it requests, the payloads it asks to be signed.
 * It does NOT prove MetaMask's own UI, its popup approval flow, or its
 * particular quirks. It proves the contract, not one implementation of it.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, avalancheFuji } from "viem/chains";
import { arcTransport } from "../../src/lib/rpc.ts";

/** Methods a wallet answers itself rather than forwarding to a node. */
const LOCAL = new Set([
  "eth_accounts",
  "eth_requestAccounts",
  "eth_chainId",
  "net_version",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "eth_sendTransaction",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "personal_sign",
  "eth_sign",
]);

const hexToBigInt = (v) => (v === undefined || v === null ? undefined : BigInt(v));

/**
 * @param privateKey  the key the "wallet" holds
 * @param chains      supported chains; the first is the one the wallet starts on
 */
export function createLocalEip1193Provider(privateKey, chains = [avalancheFuji, arcTestnet]) {
  const account = privateKeyToAccount(privateKey);

  // Arc's public RPC rate-limits hard, so it gets the rotating transport the
  // rest of the repo uses; the source chain is fine on a plain one.
  const transportFor = (chain) => (chain.id === arcTestnet.id ? arcTransport() : http());

  const clients = new Map(
    chains.map((chain) => [
      chain.id,
      {
        chain,
        pub: createPublicClient({ chain, transport: transportFor(chain) }),
        wallet: createWalletClient({ account, chain, transport: transportFor(chain) }),
      },
    ]),
  );

  let currentId = chains[0].id;
  const current = () => clients.get(currentId);

  /** Calls made, in order — the record of what App Kit actually asked for. */
  const calls = [];

  async function request({ method, params = [] }) {
    calls.push(method);

    if (!LOCAL.has(method)) {
      // Everything else is a node read. A real wallet forwards these too.
      return current().pub.request({ method, params });
    }

    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [account.address];

      case "eth_chainId":
        return `0x${currentId.toString(16)}`;

      case "net_version":
        return String(currentId);

      case "wallet_switchEthereumChain": {
        const target = Number(params[0]?.chainId ?? 0);
        if (!clients.has(target)) {
          // Shape matters: EIP-3085 says 4902 means "unrecognized chain", and
          // callers branch on it to offer wallet_addEthereumChain.
          const err = new Error(`Unrecognized chain ID 0x${target.toString(16)}`);
          err.code = 4902;
          throw err;
        }
        currentId = target;
        return null;
      }

      case "wallet_addEthereumChain": {
        const target = Number(params[0]?.chainId ?? 0);
        if (!clients.has(target)) {
          const err = new Error(`This stand-in wallet only carries: ${[...clients.keys()].join(", ")}`);
          err.code = 4902;
          throw err;
        }
        currentId = target;
        return null;
      }

      case "eth_sendTransaction": {
        const tx = params[0] ?? {};
        const { wallet } = current();
        // Hex in, bigint out — and omit anything absent so viem estimates it,
        // exactly as a wallet would fill in gas and fees the dapp left blank.
        return wallet.sendTransaction({
          ...(tx.to ? { to: tx.to } : {}),
          ...(tx.data ? { data: tx.data } : {}),
          ...(tx.value ? { value: hexToBigInt(tx.value) } : {}),
          ...(tx.gas ? { gas: hexToBigInt(tx.gas) } : {}),
          ...(tx.maxFeePerGas ? { maxFeePerGas: hexToBigInt(tx.maxFeePerGas) } : {}),
          ...(tx.maxPriorityFeePerGas ? { maxPriorityFeePerGas: hexToBigInt(tx.maxPriorityFeePerGas) } : {}),
          ...(tx.nonce !== undefined ? { nonce: Number(tx.nonce) } : {}),
        });
      }

      case "eth_signTypedData":
      case "eth_signTypedData_v3":
      case "eth_signTypedData_v4": {
        // params = [address, json]. Wallets accept a string; some dapps pass
        // the object already parsed, so handle both.
        const raw = params[1];
        const typed = typeof raw === "string" ? JSON.parse(raw) : raw;
        const { EIP712Domain: _unused, ...types } = typed.types ?? {};
        return account.signTypedData({
          domain: typed.domain,
          types,
          primaryType: typed.primaryType,
          message: typed.message,
        });
      }

      case "personal_sign": {
        // params = [data, address] for personal_sign; eth_sign reverses them.
        const data = params[0];
        return account.signMessage({ message: { raw: data } });
      }

      case "eth_sign": {
        const data = params[1];
        return account.signMessage({ message: { raw: data } });
      }

      default:
        throw new Error(`local provider: unhandled method ${method}`);
    }
  }

  return {
    request,
    address: account.address,
    /** Which chain the "wallet" is currently on — the thing a user switches. */
    get chainId() {
      return currentId;
    },
    /** Every method App Kit asked for, in order. */
    calls,
  };
}
