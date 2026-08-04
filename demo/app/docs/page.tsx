import "../landing/landing.css";
import { displaySerif, bodySans, uiSans, utilityMono } from "../landing/fonts";
import Topbar from "../landing/Topbar";
import Footer from "../landing/Footer";

export const metadata = {
  title: "RivoKit — documentation",
  description:
    "One page: the tech stack, the repository layout, the code that matters, and a complete integration path for RivoKit on Arc.",
};

const GH = "https://github.com/0xsheyn/RivoKit/blob/main";

/**
 * This page is a map, not a second source of truth. Anything with a number in
 * it — test counts, proven hashes, corridor minimums — stays in the Markdown
 * documents and is linked to rather than copied, because a figure restated in
 * two places is a figure that will disagree with itself.
 */
function Section({ id, number, title, children }: { id: string; number: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mx-auto w-full max-w-[1000px] scroll-mt-20 px-5 py-10 md:px-8">
      <div className="mb-8 flex items-baseline justify-between border-b border-[color:var(--ash)]/20 pb-3">
        <span className="eyebrow">
          {number} —— {title}
        </span>
      </div>
      {children}
    </section>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="my-4 overflow-x-auto rounded-sm border border-[color:var(--ash)]/20 bg-[var(--ink-raised)] p-4">
      <code className="f-mono text-[12px] leading-relaxed text-[var(--bone)]/85">{children}</code>
    </pre>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mb-4 max-w-[70ch] text-[14px] leading-relaxed text-[var(--bone)]/75">{children}</p>;
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 mt-8 text-[17px] text-[var(--bone)] md:text-[19px]">{children}</h3>;
}

const STACK: Array<{ layer: string; items: string; why: string }> = [
  {
    layer: "Language & runtime",
    items: "TypeScript 5.9 · Node ≥ 20 · ESM only",
    why: "Money is bigint minor units end to end; `exactOptionalPropertyTypes` is on.",
  },
  {
    layer: "Chain access",
    items: "viem 2.38 · wagmi 2.17",
    why: "viem ships `arcTestnet`; wagmi drives the browser wallet through EIP-6963 discovery.",
  },
  {
    layer: "Circle — swap, bridge, balance",
    items: "@circle-fin/app-kit 1.10 · adapter-viem-v2 · adapter-circle-wallets",
    why: "StableFX is reached through App Kit `swap`, not a separate FX contract. Also Gateway unified balance and CCTP.",
  },
  {
    layer: "Circle — contracts & wallets",
    items: "@circle-fin/smart-contract-platform 10.8",
    why: "Deploys the pinned Commerce Payments Protocol artifacts and runs the operator's developer-controlled wallet.",
  },
  {
    layer: "Off-ramp crypto",
    items: "jose 6.2",
    why: "JWE encryption for CPN beneficiary data; EIP-712 witness signing is done with viem.",
  },
  {
    layer: "Persistence",
    items: "Supabase (supabase-js 2.58) · Postgres",
    why: "Invariants live as CHECK constraints, not only as application code. Migrations ship inside the package.",
  },
  {
    layer: "Demo app",
    items: "Next.js 15.5 · React 19.1 · Tailwind 4.3 · shadcn · @base-ui/react",
    why: "App Router with server actions. The demo is proof of function, not the product.",
  },
  { layer: "Tests", items: "vitest 3.2", why: "Unit tests need no credentials; anything touching a chain is a live-proof script instead." },
];

export default function DocsPage() {
  return (
    <div
      id="top"
      className={`rivo-landing ${displaySerif.variable} ${bodySans.variable} ${uiSans.variable} ${utilityMono.variable}`}
    >
      <Topbar />

      <header className="mx-auto w-full max-w-[1000px] px-5 pb-4 pt-14 md:px-8">
        <p className="eyebrow mb-3">DOCUMENTATION</p>
        <h1 className="f-display text-[38px] leading-tight text-[var(--bone)] sm:text-[52px]">
          Everything, on one page.
        </h1>
        <p className="mt-4 max-w-[70ch] text-[15px] leading-relaxed text-[var(--bone)]/75">
          What RivoKit is built out of, how the repository is laid out, the code that actually matters, and a complete
          path from <span className="f-mono text-[var(--bone)]">npm install</span> to euros leaving escrow for a bank
          account. Deeper reference lives in four Markdown documents, linked where each one takes over.
        </p>

        <nav aria-label="On this page" className="mt-8 flex flex-wrap gap-x-5 gap-y-2 border-t border-[color:var(--ash)]/20 pt-5">
          {[
            ["#what", "What it is"],
            ["#stack", "Tech stack"],
            ["#layout", "Repository"],
            ["#code", "The code that matters"],
            ["#integrate", "Integration"],
            ["#bank", "Bank payout"],
            ["#scripts", "Scripts"],
            ["#reference", "Reference"],
          ].map(([href, label]) => (
            <a key={href} href={href} className="link-step f-mono text-[12px] uppercase tracking-[0.08em] text-[var(--bone)]/70">
              {label}
            </a>
          ))}
        </nav>
      </header>

      <Section id="what" number="01" title="WHAT IT IS">
        <P>
          An embeddable cross-border settlement SDK on Arc. USDC arrives from any supported chain, sits in a Commerce
          Payments Protocol escrow, and leaves as either floored EURC on Arc or a local-currency bank payout through
          Circle Payments Network — decided per order by <span className="f-mono text-[var(--bone)]">payoutTo</span>.
        </P>
        <P>
          Three properties hold everywhere and are worth knowing before reading any code. Funds live in the escrow
          contract and never on a server. Money is an integer in minor units, never a float. Every FX swap carries a{" "}
          <span className="f-mono text-[var(--bone)]">stopLimit</span> equal to the promised price, so the recipient
          gets at least what was promised or nothing moves at all.
        </P>
        <P>
          The fiat leg is the honest edge: CPN reporting <span className="f-mono text-[var(--sodium)]">COMPLETED</span>{" "}
          means the network says the payout finished, not that anyone watched money land in a real account. That ceiling
          is stated in full in <a className="link-step text-[var(--bone)]" href={`${GH}/LIMITATIONS.md`}>LIMITATIONS.md</a>.
        </P>
      </Section>

      <Section id="stack" number="02" title="TECH STACK">
        <P>Every runtime dependency, and why it is here rather than something else.</P>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <thead>
              <tr className="border-b border-[color:var(--ash)]/25">
                <th className="eyebrow py-2 pr-4">Layer</th>
                <th className="eyebrow py-2 pr-4">Packages</th>
                <th className="eyebrow py-2">Why</th>
              </tr>
            </thead>
            <tbody>
              {STACK.map((s) => (
                <tr key={s.layer} className="hover-step border-b border-[color:var(--ash)]/15 align-top">
                  <td className="py-3 pr-4 text-[13px] text-[var(--bone)]/85">{s.layer}</td>
                  <td className="f-mono py-3 pr-4 text-[12px] text-[var(--verdigris)]">{s.items}</td>
                  <td className="py-3 text-[13px] leading-relaxed text-[var(--bone)]/70">{s.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <P>
          The package itself stays <span className="f-mono text-[var(--bone)]">private</span> — nothing here is audited
          and the MOCK payout instruction must not reach the public registry by accident. Git and{" "}
          <span className="f-mono text-[var(--bone)]">file:</span> installs work regardless; a{" "}
          <span className="f-mono text-[var(--bone)]">prepare</span> hook builds{" "}
          <span className="f-mono text-[var(--bone)]">dist/</span>.
        </P>
      </Section>

      <Section id="layout" number="03" title="REPOSITORY">
        <P>One package, no monorepo. New code is confined to five directories; everything else wraps something proven.</P>
        <Code>{`rivokit/
├── src/
│   ├── sdk/            # RivoKit facade — the composition root
│   ├── orchestrator/   # order state machine (new code)
│   ├── settlement-fx/  # quote-lock + stopLimit swap + rebate (new code)
│   ├── ramp/           # CPN off-ramp: client · encrypt · sign · state (new code)
│   ├── payout/         # PayoutRail seam · CPN rail · MOCK instruction (new code)
│   ├── funding/        # App Kit unified balance / bridge
│   ├── escrow/         # Commerce Payments Protocol + gasless ERC-3009
│   ├── events/         # webhooks + signature verification + compliance
│   ├── constants/      # verified Arc addresses & chain config
│   └── lib/            # RPC rotation, Circle DNS pinning
├── contracts/          # pinned CPP artifacts + provenance & verification recipe
├── infra/supabase/     # order-store migrations (shipped with the package)
├── scripts/            # setup · health checks · live proofs · API probes
└── demo/               # Next.js marketplace + /sdk state-machine page`}</Code>
        <P>
          The escrow itself is <em>not</em> written here. It is the Commerce Payments Protocol — deployed from pinned
          artifacts as RivoKit&apos;s own instance, then source-verified on the explorer. The module map and the
          reasoning behind each boundary are in{" "}
          <a className="link-step text-[var(--bone)]" href={`${GH}/ARCHITECTURE.md`}>ARCHITECTURE.md</a>.
        </P>
      </Section>

      <Section id="code" number="04" title="THE CODE THAT MATTERS">
        <P>
          <span className="f-mono text-[var(--bone)]">createRivoKit</span> is a composition root, not a service. It
          holds no keys and opens no connections. Every dependency needing a credential is injected — that is what keeps
          the SDK out of custody of both funds and secrets.
        </P>
        <Code>{`import {
  createRivoKit, createEscrow, createSettlementFx, createBridge,
  createOrderStore, createComplianceGate, createCircleScreener,
  ARC_TESTNET_CHAIN_ID, USDC_ADDRESS,
} from "rivokit";

const kit = createRivoKit({
  store:  createOrderStore(SUPABASE_URL, SUPABASE_SECRET_KEY),
  escrow: createEscrow({ escrowAddress, publicClient, operator: operatorSender }),
  fx:     createSettlementFx({ kitKey, circleApiKey, circleEntitySecret }),
  bridge: createBridge(appKit),
  fund,                    // FundExecutor — moves the payer's USDC into escrow
  payRebate,               // optional: returns the payer's surplus
  compliance: gate,        // optional but strongly recommended
  operatorGas,             // optional: () => Promise<bigint>
  payoutRail,              // optional: required for payoutTo: "bank"
  config: {
    chainId: ARC_TESTNET_CHAIN_ID,
    escrowAddress,
    operator:          OPERATOR_ADDRESS,
    token:             USDC_ADDRESS,
    refundCollector:   REFUND_COLLECTOR_ADDRESS,
    settlementAddress: MERCHANT_ADDRESS,   // receives capture, runs the swap
    screeningChain:    "ARC-TESTNET",
    feeBps: 25, feeReceiver: OPERATOR_ADDRESS,
    minOperatorGasWei: 500_000n * 10n ** 12n,
  },
});`}</Code>

        <H3>The three injections that decide custody</H3>
        <P>
          <span className="f-mono text-[var(--bone)]">escrow.operator</span> — a{" "}
          <span className="f-mono text-[var(--bone)]">Sender</span> that submits escrow calls. In the demo it is a
          Circle developer-controlled wallet, polled to settlement.
        </P>
        <P>
          <span className="f-mono text-[var(--bone)]">fund</span> — a{" "}
          <span className="f-mono text-[var(--bone)]">FundExecutor</span>. It moves the payer&apos;s USDC onto Arc and
          authorizes it into escrow. Injected because it needs the payer&apos;s signature and the funding rail, both of
          which live in your environment. Build the typed data with{" "}
          <span className="f-mono text-[var(--bone)]">receiveAuthorizationTypedData</span> and hand it to the browser —
          that is the entire gasless path. The buyer signs, the operator pays Arc gas, and the operator fee grossed{" "}
          <em>onto</em> the payer is what reimburses it. The seller&apos;s floor is never funded out of.
        </P>
        <Code>{`const fund = async ({ paymentInfo, hash, signature }) => {
  const state = await escrow.getPaymentState(hash);
  if (state.hasCollectedPayment) return { authorizeTxHash: "0xalready" };  // idempotent

  // Either relay a browser-wallet signature, or sign server-side (demo only).
  const sig = signature ?? await buyerWallet.signTypedData(
    receiveAuthorizationTypedData({
      paymentInfo, chainId: ARC_TESTNET_CHAIN_ID,
      escrowAddress: ESCROW, tokenCollector: TOKEN_COLLECTOR, usdcAddress: USDC_ADDRESS,
    }),
  );

  const auth = await escrow.authorize(paymentInfo, paymentInfo.maxAmount, TOKEN_COLLECTOR, sig);
  return { authorizeTxHash: auth.txHash };
};`}</Code>
        <P>
          <span className="f-mono text-[var(--bone)]">payRebate</span> — returns the settlement surplus to the payer,
          and <strong className="text-[var(--bone)]">it must read `token`</strong>. A wallet-path surplus is EURC held
          by the merchant; a bank-path surplus is USDC held by the seller. Ignoring that field sends the wrong asset out
          of the wrong wallet, and only fails when the merchant happens to be short.
        </P>
        <Code>{`const payRebate = async ({ to, amountMinor, token }) => {
  if (token === "USDC") return sendSellerUsdc(to, amountMinor);
  return sendMerchantEurc(to, amountMinor);
};`}</Code>
        <p className="my-5 max-w-[70ch] border-l-2 border-[color:var(--sodium)] pl-4 text-[13px] leading-relaxed text-[var(--bone)]/80">
          <span className="text-[var(--bone)]">Server-side only.</span>{" "}
          <span className="f-mono">CIRCLE_API_KEY</span>, <span className="f-mono">CIRCLE_ENTITY_SECRET</span>,{" "}
          <span className="f-mono">KIT_KEY</span> and <span className="f-mono">CIRCLE_CPN_KEY</span> must never reach a
          browser bundle. The one thing safe client-side is the payer&apos;s own signing — the ERC-3009 typed data, and
          the funding rails that need nothing but the payer&apos;s wallet.
        </p>
      </Section>

      <Section id="integrate" number="05" title="INTEGRATION">
        <H3>1 — Install</H3>
        <Code>{`npm i github:0xsheyn/RivoKit     # or file:../rivokit for a local checkout
npm run setup                    # idempotent: deploys escrow + operator/merchant wallets`}</Code>
        <P>
          Credentials, the escrow deploy, and running the demo are covered step by step in{" "}
          <a className="link-step text-[var(--bone)]" href={`${GH}/STARTED.md`}>STARTED.md</a>. The environment names
          the code actually reads are listed there — several plausible-looking ones (
          <span className="f-mono">RIVOKIT_RPC_URL</span>, <span className="f-mono">ESCROW_ADDRESS</span>) are read by
          nothing.
        </P>

        <H3>2 — The order lifecycle</H3>
        <Code>{`const order = await kit.createOrder({
  payer, receiver,
  priceEURMinor: 2_500_000n,      // €25.00 guaranteed — minor units, always bigint
  receivingChain: "ARC-TESTNET",  // where a refund goes back to
  wedge: "delivery_confirmed",
  mode: "escrow",                 // or "direct" for an atomic charge
  bufferBps: 150,                 // overpay to absorb rate drift; returned as rebate
});

await kit.fund(order.id);                       // or { signature } from the browser
await kit.release(order.id, { kind: "delivery_confirmed", ... });

const state = await kit.status(order.id);       // → "released" | "paid_out" | …`}</Code>
        <P>Subscribe rather than poll:</P>
        <Code>{`kit.on("released",       ({ orderId, eurcOutMinor, rebateMinor }) => { … });
kit.on("payout_pending", ({ orderId, paymentId }) => { … });   // BROADCAST, not delivered
kit.on("paid_out",       ({ orderId }) => { … });              // terminal`}</Code>
        <P>
          There is no timeout parameter. It is derived from <span className="f-mono text-[var(--bone)]">wedge</span>:
          strong evidence resolves to auto-capture and favours the seller, weak evidence to reclaim and favours the
          buyer. When nobody can prove delivery, the default must not be to simply pay the seller.
        </P>

        <H3>3 — The invariants you inherit</H3>
        <ol className="mb-4 max-w-[70ch] list-decimal space-y-2 pl-5 text-[14px] leading-relaxed text-[var(--bone)]/75 marker:text-[var(--ash)]">
          <li>The recipient receives ≥ <span className="f-mono text-[var(--bone)]">priceEURMinor</span>, or the swap reverts with funds safe.</li>
          <li>Refunds always return to the recorded <span className="f-mono text-[var(--bone)]">receivingChain</span>.</li>
          <li><span className="f-mono text-[var(--bone)]">rebate = max(0, actualOutput − priceEURMinor)</span>.</li>
          <li>ERC-3009 nonces are single-use.</li>
          <li>Money is integer minor units — never a float.</li>
          <li>Illegal state sequences are unrepresentable: a capture on an unfunded order is refused before it can reach escrow and revert.</li>
          <li>A CPN payment only moves forward; a duplicate or late webhook after a terminal state is ignored, not replayed.</li>
        </ol>
      </Section>

      <Section id="bank" number="06" title="BANK PAYOUT">
        <P>
          Add a <span className="f-mono text-[var(--bone)]">payoutRail</span> and set{" "}
          <span className="f-mono text-[var(--bone)]">payoutTo: &quot;bank&quot;</span>. Without a rail,{" "}
          <span className="f-mono text-[var(--bone)]">payoutTo: &quot;bank&quot;</span> is refused at{" "}
          <span className="f-mono text-[var(--bone)]">createOrder</span> — the default build stays free of payout
          capability rather than half-wired.
        </P>
        <Code>{`const payoutRail = createCpnPayoutRail({
  ramp, corridor, destinationCountry, senderAddress, details, signIntent,
});
// limits · estimate · ready (approve Permit2 first) · quote · submit (IRREVERSIBLE) · status`}</Code>
        <P>
          Two consequences are easy to get wrong. CPN accepts <strong className="text-[var(--bone)]">USDC only</strong> as
          a source currency, so a bank-bound order skips the EURC swap entirely — the CPN quote is what pins the euro
          amount, exactly as <span className="f-mono text-[var(--bone)]">stopLimit</span> pins EURC on the wallet path.
          And a bank-bound order must pay the wallet that <em>signs</em> Permit2, not the merchant, because the payout
          spends the captured USDC from that address.
        </P>
        <P>
          Size a bank order from{" "}
          <span className="f-mono text-[var(--bone)]">PayoutRail.estimate()</span>, never from an FX spread. Corridor
          fees are not proportional — USD/WIRE charges a flat fee of roughly 25 USDC, which is brutal on a small order
          and is the real reason its minimum sits where it does.
        </P>
      </Section>

      <Section id="scripts" number="07" title="SCRIPTS">
        <P>
          Anything that moves money is gated behind an explicit{" "}
          <span className="f-mono text-[var(--bone)]">CONFIRM=</span> environment variable.{" "}
          <span className="f-mono text-[var(--bone)]">probe-*</span> scripts fund nothing and cost nothing.
        </P>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-left">
            <tbody>
              {[
                ["Setup / health", "preflight (read-only) · setup (idempotent deploy) · check-cpp · check-hash · check-operator · sync-env"],
                ["Live proofs", "live-sdk · live-sdk-bank · live-demo-bank · live-payout-reconcile · live-wallet-rails · live-webhook-attribution · live-refund · live-charge · live-compliance · …"],
                ["API probes", "probe-cpn-source · probe-cpn-lifecycle · probe-cpn-status · probe-swap · probe-mint* · probe-wallet-rails"],
                ["Demo utils", "demo-topup · reset-demo"],
              ].map(([group, items]) => (
                <tr key={group} className="hover-step border-b border-[color:var(--ash)]/15 align-top">
                  <td className="whitespace-nowrap py-3 pr-6 text-[13px] text-[var(--bone)]/85">{group}</td>
                  <td className="f-mono py-3 text-[12px] leading-relaxed text-[var(--verdigris)]">{items}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Code>{`npm test          # vitest — no credentials needed
npm run typecheck # tsc --noEmit
npm run dev       # the demo
npm run build:lib # SDK → dist/ (ESM + .d.ts)`}</Code>
        <P>
          A Foundry fork proves nothing for Arc: USDC-as-gas and the precompile blocklist do not exist on a local EVM.
          That is why anything touching a contract is verified by a live script against Arc Testnet rather than by a
          fork test.
        </P>
      </Section>

      <Section id="reference" number="08" title="REFERENCE">
        <P>Where each document takes over from this page.</P>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ["STARTED.md", "Install, credentials, deploying your escrow, running the demo, webhooks, going to production, troubleshooting."],
            ["ARCHITECTURE.md", "Module map, the composition root, the two settlement paths, the PayoutRail seam, security model, and the traps that already cost time."],
            ["PROOFS.md", "Every claim with the hash or payment id behind it — and the negative results kept next to them."],
            ["LIMITATIONS.md", "The ceiling on every fiat claim, what the tests do not guard, economic and operational limits, deliberate non-goals."],
          ].map(([file, blurb]) => (
            <a
              key={file}
              href={`${GH}/${file}`}
              className="hover-step rounded-sm border border-[color:var(--ash)]/15 p-4 transition-colors hover:border-[color:var(--ash)]/35"
            >
              <p className="f-mono mb-2 text-[13px] text-[var(--verdigris)]">{file}</p>
              <p className="text-[13px] leading-relaxed text-[var(--bone)]/70">{blurb}</p>
            </a>
          ))}
        </div>
      </Section>

      <Footer />
    </div>
  );
}
