import { RiCheckboxCircleLine, RiExternalLinkLine } from "@remixicon/react";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  EURC_ADDRESS,
  USDC_ADDRESS,
} from "../../../src/constants/arc";
import DemoPanels from "../DemoPanels";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ToneBadge } from "../_ui";
import {
  Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";

const ARC_TX = (h: string) => `${ARC_TESTNET_EXPLORER_URL}/tx/${h}`;
const SEP_TX = (h: string) => `https://sepolia.etherscan.io/tx/${h}`;

// The public SDK surface (src/sdk/rivokit.ts) — the one object the whole flow
// runs through (Phase 5 exit criterion).
const SDK_API: Array<[string, string]> = [
  ["createOrder(params)", "Lock the FX quote, derive usdcAmount, screen the addresses, store the order. `payoutTo` decides the shape of everything after it."],
  ["fund(orderId)", "Cross-chain USDC → Arc (unified balance / bridge) → authorize into escrow."],
  ["release(orderId, proof)", "wallet: capture → floored swap (≥ €P) → MOCK instruction. bank: capture → CPN quote pinned to €P → broadcast."],
  ["refreshPayout(orderId)", "Re-read the rail and settle the ledger row with its Arc hash — the same path a webhook takes."],
  ["refund(orderId)", "void / refund → bridge back to receivingChain (invariant 5)."],
  ["status(orderId)", "Read the current order."],
  ["on(event, handler)", "Subscribe to status events: funded / released / payout_pending / paid_out / refunded / …"],
];

const LIFECYCLE = ["created", "funding_pending", "funded", "released", "payout_pending", "paid_out"];

// Real testnet transactions from the live proofs (scripts/live-*.mjs).
type Leg = { label: string; hash: string; url: (h: string) => string };
type Flow = { title: string; result: string; legs: Leg[] };

const FLOWS: Flow[] = [
  {
    title: "Funding — unified balance (primary rail)",
    result: "Gateway → Arc escrow · order funded",
    legs: [
      { label: "deposit (Sepolia → Gateway)", hash: "0x2d60f17670dfed44b58dbf48f82908c1e5abe3803a732a7c16ef13f09e062ba6", url: SEP_TX },
      { label: "spend / mint (Arc)", hash: "0x556d1940e50319b2e6d61ae2fd1500640cf7a78740be8f1b2fc507a21b172f97", url: ARC_TX },
    ],
  },
  {
    title: "Funding — bridge (CCTP fallback)",
    result: "Ethereum Sepolia → Arc escrow · order funded",
    legs: [
      { label: "burn (Sepolia)", hash: "0x196514bb1b8666689fb4810502d91034dcb4b8b713c5746bed2f0547e715ffb6", url: SEP_TX },
      { label: "mint (Arc)", hash: "0xcaf10d325e3d7312d6c913d49c507c0bbb4b9ce77e44c46fceeb7d5f33b382e8", url: ARC_TX },
    ],
  },
  {
    title: "Settlement — release (through the SDK only)",
    result: "capture → floored swap · €1.50 guaranteed → 1.528018 EURC (rebate 0.028) · order released",
    legs: [
      { label: "swap USDC→EURC (Arc)", hash: "0x04b8fdefc7f9351f025af2b4f9de816184a6afa88e7c997c7e74b136a49620d0", url: ARC_TX },
    ],
  },
  {
    title: "Refund — bridge back to the source chain",
    result: "Arc escrow → Ethereum Sepolia · order refunded (invariant 5)",
    legs: [
      { label: "void (Arc)", hash: "0x43f769c504a6a033dccae7223e4894c27ea4326dbcc78d42f7140d2239a0e41c", url: ARC_TX },
      { label: "burn (Arc)", hash: "0x6d929603780e3d397b30789599330d8d73f7bcfea7bc78dd5efb03651fb3bd60", url: ARC_TX },
      { label: "mint (Sepolia)", hash: "0x84a9b075edb182f176cb5fc9d26f2d2b40620cdc89ba0e78fc3644cfcaf38ee3", url: SEP_TX },
    ],
  },
];

const PHASES = [
  ["0 · Setup", "CPP escrow deployed via Circle SCP"],
  ["1 · Escrow lifecycle", "fund → capture → refund on Arc"],
  ["2 · Settlement-FX", "floored USDC→EURC (≥ €P)"],
  ["3 · Multi-chain funding", "unified balance + bridge + refund-back"],
  ["4 · Events & compliance", "live screening + synced status + MOCK payout"],
  ["5 · SDK & demo", "the SDK surface plus this demo"],
] as const;

// The two B2B/payout wedges the demo targets (src/orchestrator/policy.ts).
const SCENARIOS: Array<{ title: string; wedge: string; trigger: string; timeout: string; note: string }> = [
  {
    title: "Contractor / B2B payout",
    wedge: "contractor_payout",
    trigger: "release() when the payer approves the milestone",
    timeout: "auto_capture (pro-seller)",
    note: "An approved milestone is strong proof. The payer releases explicitly; the timeout favours the recipient.",
  },
  {
    title: "Digital goods / SaaS",
    wedge: "digital_goods",
    trigger: "release() when access is granted (can be automatic)",
    timeout: "auto_capture (pro-seller)",
    note: "Granting access is deterministic and observed by the host — strong proof. The licence or account issues immediately.",
  },
];

function short(h: string) {
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">{children}</h2>;
}

export default function Page() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-14">
      <h1 className="text-3xl font-semibold tracking-tight">RivoKit</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Cross-border settlement on Arc — multi-chain USDC in, floored EURC out. Non-custodial: funds always sit in the
        Commerce Payments Protocol escrow, never on a server.
      </p>

      <Alert variant="destructive" className="mt-6">
        <AlertTitle>Testnet only — unaudited</AlertTitle>
        <AlertDescription>
          A <span className="font-mono">wallet</span> order stops at EURC on Arc and hands the host a
          <span className="font-mono"> MOCK</span> payout instruction — no fiat moves. A
          <span className="font-mono"> bank</span> order really does broadcast to a payment network and cannot be
          recalled. Do not use real funds or mainnet private keys.
        </AlertDescription>
      </Alert>

      <div className="mt-10">
        <DemoPanels />
      </div>

      {/* SDK surface */}
      <section className="mt-12">
        <SectionTitle>SDK surface</SectionTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          The whole flow runs through the single <code className="font-mono text-foreground">RivoKit</code> object.
        </p>
        <dl className="mt-4 divide-y border-y">
          {SDK_API.map(([sig, desc]) => (
            <div key={sig} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-6">
              <dt className="w-64 shrink-0 font-mono text-sm text-muted-foreground">{sig}</dt>
              <dd className="text-sm text-foreground">{desc}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Lifecycle */}
      <section className="mt-12">
        <SectionTitle>Order lifecycle</SectionTitle>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          {LIFECYCLE.map((s, i) => (
            <span key={s} className="flex items-center gap-2">
              <span className="border bg-muted px-2 py-1 font-mono text-foreground">{s}</span>
              {i < LIFECYCLE.length - 1 && <span className="text-muted-foreground">→</span>}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Floor missed → <span className="font-mono">settlement_pending</span> (funds safe, retryable).
          Refund is reachable from <span className="font-mono">funded</span> and <span className="font-mono">released</span>.
        </p>
      </section>

      {/* Gasless */}
      <section className="mt-12">
        <SectionTitle>Gasless — the buyer pays no gas</SectionTitle>
        <p className="mt-2 text-sm text-muted-foreground">
          The buyer <span className="font-medium text-foreground">signs an ERC-3009 authorization</span>{" "}
          <code className="bg-muted px-1 py-0.5 font-mono text-xs">receiveWithAuthorization</code>{" "}
          off-chain (no transaction). The operator <span className="font-medium text-foreground">relays</span>{" "}
          the on-chain collection through <span className="font-mono text-xs">ERC3009PaymentCollector</span> and pays the gas.
          The buyer's USDC moves; the buyer never needs a native gas token.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="border bg-muted px-2 py-1 text-foreground">buyer signs (off-chain, no gas)</span>
          <span className="text-muted-foreground">→</span>
          <span className="border bg-muted px-2 py-1 text-foreground">operator relays (pays gas)</span>
          <span className="text-muted-foreground">→</span>
          <span className="border bg-muted px-2 py-1 text-foreground">USDC into escrow</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Operator relay, not a generic paymaster — the nonce is a payer-agnostic hash (single use, replay-proof).
          One source: <code className="font-mono">src/escrow/erc3009.ts</code>.
        </p>
      </section>

      {/* Scenarios */}
      <section className="mt-12">
        <SectionTitle>Demo scenarios</SectionTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          B2B/payout wedges — strong proof. Physical retail is narrative demo only (the oracle problem).
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {SCENARIOS.map((s) => (
            <Card key={s.wedge}>
              <CardHeader>
                <CardTitle className="text-sm">{s.title}</CardTitle>
                <CardDescription className="font-mono">{s.wedge}</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="space-y-1.5 text-xs">
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-muted-foreground">release</dt>
                    <dd className="text-foreground">{s.trigger}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-muted-foreground">timeout</dt>
                    <dd className="text-foreground">{s.timeout}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">{s.note}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Execution Inspector */}
      <section className="mt-12">
        <SectionTitle>Execution Inspector — live proof on Arc Testnet</SectionTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Real transactions from <code className="font-mono text-foreground">scripts/live-*.mjs</code>. Click through to verify on the explorer.
        </p>
        <div className="mt-4 space-y-4">
          {FLOWS.map((flow) => (
            <Card key={flow.title}>
              <CardHeader>
                <CardTitle className="text-sm">{flow.title}</CardTitle>
                <CardDescription>{flow.result}</CardDescription>
                <CardAction>
                  <ToneBadge tone="success">
                    <RiCheckboxCircleLine /> proven
                  </ToneBadge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {flow.legs.map((leg) => (
                    <li key={leg.hash} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                      <span className="w-52 shrink-0 text-xs text-muted-foreground">{leg.label}</span>
                      <a href={leg.url(leg.hash)} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 break-all font-mono text-xs text-primary underline-offset-4 hover:underline">
                        {short(leg.hash)}<RiExternalLinkLine className="size-3" />
                      </a>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Mock payout — clearly labeled */}
        <Alert className="mt-4">
          <AlertTitle className="flex items-baseline justify-between gap-2">
            <span>Payout instruction (the EURC→EUR fiat leg)</span>
            <ToneBadge tone="warning">MOCK</ToneBadge>
          </AlertTitle>
          <AlertDescription>
            RivoKit does not execute the fiat leg. It hands the host a structured instruction to run through a
            licensed off-ramp. KYB/AML and fiat settlement are the host&apos;s responsibility.
          </AlertDescription>
        </Alert>
      </section>

      {/* Phase status */}
      <section className="mt-12">
        <SectionTitle>Phase status</SectionTitle>
        <ul className="mt-4 divide-y border-y">
          {PHASES.map(([name, desc]) => (
            <li key={name} className="flex items-center gap-3 py-2.5 text-sm">
              <RiCheckboxCircleLine className="size-4 text-muted-foreground" />
              <span className="w-48 shrink-0 font-medium text-foreground">{name}</span>
              <span className="text-muted-foreground">{desc}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-12 border-t pt-6 text-xs text-muted-foreground">
        Arc Testnet · chain {ARC_TESTNET_CHAIN_ID} · USDC <span className="font-mono">{USDC_ADDRESS.slice(0, 10)}…</span>{" "}
        · EURC <span className="font-mono">{EURC_ADDRESS.slice(0, 10)}…</span> · 261 unit tests green
      </footer>
    </main>
  );
}
