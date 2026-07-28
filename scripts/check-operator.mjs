/**
 * Can the Circle Developer-Controlled operator wallet actually call contracts?
 *
 * DEPLOYMENT.md §2 says the operator should be a Circle DCW, which means every
 * escrow call goes through Circle's contractExecution API rather than viem.
 * Before committing the money path to that, prove it works — using a call we
 * need anyway: the USDC allowance that OperatorRefundCollector requires to pull
 * refunds from the operator.
 *
 *   node scripts/check-operator.mjs
 */
import { createPublicClient, erc20Abi, formatUnits, getAddress, maxUint256 } from "viem";
import { arcTestnet } from "viem/chains";
import { createCircleClient } from "./lib/circle.mjs";
import { arcTransport, sleep } from "../src/lib/rpc.ts";
import { USDC_ADDRESS } from "../src/constants/arc.ts";
import { installCircleDnsPinning } from "../src/lib/circle-dns.ts";
import { readEnv } from "./lib/env.mjs";

// Without this, api.circle.com resolves to an ISP interception host here and
// every Circle call dies as a bare "fetch failed".
installCircleDnsPinning();

const env = readEnv();

const OPERATOR = getAddress(env.OPERATOR_ADDRESS);
const REFUND_COLLECTOR = getAddress(env.NEXT_PUBLIC_RIVO_REFUND_COLLECTOR_ADDRESS);

const client = createPublicClient({ chain: arcTestnet, transport: arcTransport() });
const circle = createCircleClient({
  apiKey: env.CIRCLE_API_KEY,
  entitySecret: env.CIRCLE_ENTITY_SECRET,
});

const allowance = () =>
  client.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "allowance",
    args: [OPERATOR, REFUND_COLLECTOR],
  });

console.log("Circle DCW operator path test\n");
console.log(`  operator          ${OPERATOR}`);
console.log(`  refund collector  ${REFUND_COLLECTOR}`);
console.log(`  USDC balance      ${formatUnits(
  await client.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [OPERATOR],
  }),
  6,
)}`);
console.log(`  initial allowance  ${formatUnits(await allowance(), 6)}\n`);

let tx;
try {
  tx = await circle.contractExecution({
    walletId: env.OPERATOR_WALLET_ID,
    contractAddress: USDC_ADDRESS,
    abiFunctionSignature: "approve(address,uint256)",
    abiParameters: [REFUND_COLLECTOR, maxUint256.toString()],
  });
  console.log(`  contractExecution accepted — id ${tx.id}, state ${tx.state}`);
} catch (e) {
  console.error("  FAILED contractExecution:", e.message);
  console.error("\n  => The Circle DCW path cannot be used for the operator.");
  process.exit(1);
}

// Poll until Circle reports the transaction settled.
let final = null;
for (let i = 0; i < 40; i++) {
  await sleep(3000);
  const t = await circle.getTransaction(tx.id);
  const state = t.transaction?.state;
  if (["COMPLETE", "CONFIRMED", "FAILED", "CANCELLED", "DENIED"].includes(state)) {
    final = t.transaction;
    break;
  }
  if (i % 3 === 0) console.log(`    ...state ${state}`);
}

if (!final) {
  console.error("  FAILED: timed out waiting for the transaction.");
  process.exit(1);
}

console.log(`  final state        ${final.state}`);
console.log(`  txHash            ${final.txHash ?? "(none)"}`);
if (final.errorReason) console.log(`  errorReason       ${final.errorReason}`);

await sleep(1000);
const after = await allowance();
const granted = after > 0n;
console.log(`  final allowance   ${after === maxUint256 ? "unlimited" : formatUnits(after, 6)}`);

console.log(
  `\n${granted ? "SUCCESS — a Circle DCW operator can call the contract." : "FAILED — the allowance did not change."}`,
);
process.exit(granted ? 0 : 1);
