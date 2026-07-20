import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_RPC_URL,
  EURC_ADDRESS,
  GATEWAY_WALLET_ADDRESS,
  PERMIT2_ADDRESS,
  USDC_ADDRESS,
} from "../../src/constants/arc";

const CONSTANTS: Array<[string, string]> = [
  ["Chain ID", String(ARC_TESTNET_CHAIN_ID)],
  ["RPC", ARC_TESTNET_RPC_URL],
  ["Explorer", ARC_TESTNET_EXPLORER_URL],
  ["USDC", USDC_ADDRESS],
  ["EURC", EURC_ADDRESS],
  ["Gateway Wallet", GATEWAY_WALLET_ADDRESS],
  ["Permit2 (StableFX prerequisite)", PERMIT2_ADDRESS],
];

export default function Page() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <p className="mb-3 inline-block rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-300">
        Phase 0 — scaffold only. No SDK surface implemented yet.
      </p>

      <h1 className="text-3xl font-semibold tracking-tight">RivoKit</h1>
      <p className="mt-2 text-neutral-400">
        Cross-border settlement on Arc — multi-chain USDC in, floored EURC out.
      </p>

      <div className="mt-6 rounded border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-200">
        <strong className="font-semibold">Testnet only — unaudited.</strong> The
        fiat leg (EURC→EUR) is mocked and belongs to a licensed host. Do not use
        real funds or mainnet private keys.
      </div>

      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Arc Testnet constants
      </h2>
      <p className="mt-1 text-sm text-neutral-500">
        Verified 2026-07-21 against docs.arc.io. Re-verify before each demo —
        testnet addresses can change.
      </p>

      <dl className="mt-4 divide-y divide-neutral-800 border-y border-neutral-800">
        {CONSTANTS.map(([label, value]) => (
          <div
            key={label}
            className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-4"
          >
            <dt className="w-64 shrink-0 text-sm text-neutral-400">{label}</dt>
            <dd className="break-all font-mono text-sm text-neutral-200">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Next
      </h2>
      <p className="mt-2 text-sm text-neutral-400">
        Phase 0 continues: Supabase schema, then{" "}
        <code className="rounded bg-neutral-900 px-1 py-0.5 font-mono text-xs">
          npm run setup
        </code>{" "}
        to deploy the Commerce Payments Protocol escrow via Circle SCP. The
        split-panel buyer/seller demo with the Execution Inspector arrives in
        Phase 5.
      </p>
    </main>
  );
}
