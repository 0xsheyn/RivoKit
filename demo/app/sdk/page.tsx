import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  EURC_ADDRESS,
  USDC_ADDRESS,
} from "../../../src/constants/arc";
import DemoPanels from "../DemoPanels";

const ARC_TX = (h: string) => `${ARC_TESTNET_EXPLORER_URL}/tx/${h}`;
const SEP_TX = (h: string) => `https://sepolia.etherscan.io/tx/${h}`;

// The public SDK surface (src/sdk/rivokit.ts) — the one object the whole flow
// runs through (Phase 5 exit criterion).
const SDK_API: Array<[string, string]> = [
  ["createOrder(params)", "Kunci kuotasi FX, hitung usdcAmount, screening alamat, simpan order."],
  ["fund(orderId)", "USDC lintas-chain → Arc (unified balance / bridge) → authorize ke escrow."],
  ["release(orderId, proof)", "Capture → swap ber-floor (≥ €P) → instruksi payout MOCK."],
  ["refund(orderId)", "void / refund → bridge-back ke receivingChain (invariant 5)."],
  ["status(orderId)", "Ambil order terkini."],
  ["on(event, handler)", "Langganan event status: funded / released / refunded / …"],
];

const LIFECYCLE = [
  "created",
  "funding_pending",
  "funded",
  "released",
  "refunded",
];

// Real testnet transactions from the live proofs (scripts/live-*.mjs).
type Leg = { label: string; hash: string; url: (h: string) => string };
type Flow = { title: string; result: string; tone: "ok" | "mock"; legs: Leg[] };

const FLOWS: Flow[] = [
  {
    title: "Funding — unified balance (jalur primer)",
    result: "Gateway → escrow Arc · order funded",
    tone: "ok",
    legs: [
      { label: "deposit (Sepolia → Gateway)", hash: "0x2d60f17670dfed44b58dbf48f82908c1e5abe3803a732a7c16ef13f09e062ba6", url: SEP_TX },
      { label: "spend / mint (Arc)", hash: "0x556d1940e50319b2e6d61ae2fd1500640cf7a78740be8f1b2fc507a21b172f97", url: ARC_TX },
    ],
  },
  {
    title: "Funding — bridge (fallback CCTP)",
    result: "Ethereum Sepolia → escrow Arc · order funded",
    tone: "ok",
    legs: [
      { label: "burn (Sepolia)", hash: "0x196514bb1b8666689fb4810502d91034dcb4b8b713c5746bed2f0547e715ffb6", url: SEP_TX },
      { label: "mint (Arc)", hash: "0xcaf10d325e3d7312d6c913d49c507c0bbb4b9ce77e44c46fceeb7d5f33b382e8", url: ARC_TX },
    ],
  },
  {
    title: "Settlement — release (hanya lewat SDK)",
    result: "capture → swap ber-floor · €1.50 dijamin → 1.528018 EURC (rebate 0.028) · order released",
    tone: "ok",
    legs: [
      { label: "swap USDC→EURC (Arc)", hash: "0x04b8fdefc7f9351f025af2b4f9de816184a6afa88e7c997c7e74b136a49620d0", url: ARC_TX },
    ],
  },
  {
    title: "Refund — bridge-back ke chain asal",
    result: "escrow Arc → Ethereum Sepolia · order refunded (invariant 5)",
    tone: "ok",
    legs: [
      { label: "void (Arc)", hash: "0x43f769c504a6a033dccae7223e4894c27ea4326dbcc78d42f7140d2239a0e41c", url: ARC_TX },
      { label: "burn (Arc)", hash: "0x6d929603780e3d397b30789599330d8d73f7bcfea7bc78dd5efb03651fb3bd60", url: ARC_TX },
      { label: "mint (Sepolia)", hash: "0x84a9b075edb182f176cb5fc9d26f2d2b40620cdc89ba0e78fc3644cfcaf38ee3", url: SEP_TX },
    ],
  },
];

const PHASES = [
  ["0 · Setup", "Escrow CPP ter-deploy via Circle SCP", true],
  ["1 · Escrow lifecycle", "fund → capture → refund di Arc", true],
  ["2 · Settlement-FX", "USDC→EURC ber-floor (≥ €P)", true],
  ["3 · Funding multi-chain", "unified balance + bridge + refund-back", true],
  ["4 · Events & compliance", "screening live + status sinkron + payout MOCK", true],
  ["5 · SDK & demo", "permukaan SDK + demo ini", true],
] as const;

// The two B2B/payout wedges the demo targets (src/orchestrator/policy.ts).
const SCENARIOS: Array<{ title: string; wedge: string; trigger: string; timeout: string; note: string }> = [
  {
    title: "Kontraktor / payout B2B",
    wedge: "contractor_payout",
    trigger: "release() saat milestone di-approve pihak pembayar",
    timeout: "auto_capture (pro-seller)",
    note: "Milestone disetujui = bukti kuat. Pembayar melepas dana secara eksplisit; timeout menguntungkan penerima.",
  },
  {
    title: "Digital goods / SaaS",
    wedge: "digital_goods",
    trigger: "release() saat akses diberikan (bisa otomatis)",
    timeout: "auto_capture (pro-seller)",
    note: "Pemberian akses deterministik & terobservasi host = bukti kuat. Lisensi/akun langsung terbit.",
  },
];

function short(h: string) {
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

export default function Page() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">RivoKit</h1>
      <p className="mt-2 text-neutral-400">
        Settlement lintas-batas di Arc — USDC multi-chain masuk, EURC ber-floor keluar.
        Non-custodial: dana selalu di escrow Commerce Payments Protocol, tak pernah di server.
      </p>

      <div className="mt-6 rounded border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-200">
        <strong className="font-semibold">Testnet only — unaudited.</strong> Leg fiat
        (EURC→EUR) di-<span className="font-mono">mock</span> dan milik host berlisensi.
        Jangan pakai dana riil atau private key mainnet.
      </div>

      <div className="mt-10">
        <DemoPanels />
      </div>

      {/* SDK surface */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Permukaan SDK
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Seluruh alur berjalan hanya lewat objek <code className="font-mono text-neutral-300">RivoKit</code>.
        </p>
        <dl className="mt-4 divide-y divide-neutral-800 border-y border-neutral-800">
          {SDK_API.map(([sig, desc]) => (
            <div key={sig} className="flex flex-col gap-1 py-3 sm:flex-row sm:gap-6">
              <dt className="w-64 shrink-0 font-mono text-sm text-emerald-300">{sig}</dt>
              <dd className="text-sm text-neutral-300">{desc}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Lifecycle */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Siklus hidup order
        </h2>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          {LIFECYCLE.map((s, i) => (
            <span key={s} className="flex items-center gap-2">
              <span className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-neutral-200">
                {s}
              </span>
              {i < LIFECYCLE.length - 1 && <span className="text-neutral-600">→</span>}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Floor tak tercapai → <span className="font-mono">settlement_pending</span> (dana aman, retry).
          Refund bisa dari <span className="font-mono">funded</span> maupun <span className="font-mono">released</span>.
        </p>
      </section>

      {/* Gasless */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Gasless — buyer bayar 0 gas
        </h2>
        <p className="mt-2 text-sm text-neutral-400">
          Buyer <span className="text-neutral-200">menandatangani otorisasi ERC-3009</span>{" "}
          <code className="rounded bg-neutral-900 px-1 py-0.5 font-mono text-xs text-emerald-300">receiveWithAuthorization</code>{" "}
          secara off-chain (tanpa transaksi). Operator me-<span className="text-neutral-200">relay</span>{" "}
          pengumpulan on-chain lewat <span className="font-mono text-xs">ERC3009PaymentCollector</span> dan membayar gas-nya.
          USDC buyer berpindah; buyer tak pernah butuh token gas native.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-300">buyer tanda tangan (off-chain, 0 gas)</span>
          <span className="text-neutral-600">→</span>
          <span className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-300">operator relay (bayar gas)</span>
          <span className="text-neutral-600">→</span>
          <span className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-300">USDC masuk escrow</span>
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Operator-relay, bukan paymaster generik — nonce = hash payer-agnostik (sekali pakai, anti-replay).
          Satu sumber: <code className="font-mono">src/escrow/erc3009.ts</code>.
        </p>
      </section>

      {/* Scenarios */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Skenario demo
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Wedge B2B/payout — bukti kuat. Ritel fisik = demo naratif saja (oracle problem).
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {SCENARIOS.map((s) => (
            <div key={s.wedge} className="rounded border border-neutral-800 bg-neutral-900/40 p-4">
              <h3 className="text-sm font-medium text-neutral-100">{s.title}</h3>
              <p className="mt-0.5 font-mono text-xs text-emerald-300">{s.wedge}</p>
              <dl className="mt-3 space-y-1.5 text-xs">
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-neutral-500">rilis</dt>
                  <dd className="text-neutral-300">{s.trigger}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-neutral-500">timeout</dt>
                  <dd className="text-neutral-300">{s.timeout}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-neutral-500">{s.note}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Execution Inspector */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Execution Inspector — bukti live di Arc Testnet
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Transaksi sungguhan dari <code className="font-mono text-neutral-300">scripts/live-*.mjs</code>. Klik untuk verifikasi di explorer.
        </p>
        <div className="mt-4 space-y-4">
          {FLOWS.map((flow) => (
            <div key={flow.title} className="rounded border border-neutral-800 bg-neutral-900/40 p-4">
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="text-sm font-medium text-neutral-100">{flow.title}</h3>
                <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
                  ✓ terbukti
                </span>
              </div>
              <p className="mt-1 text-xs text-neutral-400">{flow.result}</p>
              <ul className="mt-3 space-y-1.5">
                {flow.legs.map((leg) => (
                  <li key={leg.hash} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                    <span className="w-52 shrink-0 text-xs text-neutral-400">{leg.label}</span>
                    <a
                      href={leg.url(leg.hash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all font-mono text-xs text-sky-400 hover:text-sky-300 hover:underline"
                    >
                      {short(leg.hash)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Mock payout — clearly labeled */}
        <div className="mt-4 rounded border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-medium text-amber-100">Instruksi payout (leg fiat EURC→EUR)</h3>
            <span className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-200">
              MOCK
            </span>
          </div>
          <p className="mt-1 text-xs text-amber-200/80">
            RivoKit tidak mengeksekusi leg fiat. Instruksi terstruktur diserahkan ke host untuk
            dijalankan lewat off-ramp berlisensi. KYB/AML &amp; settlement fiat = tanggung jawab host.
          </p>
        </div>
      </section>

      {/* Phase status */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Status fase
        </h2>
        <ul className="mt-4 divide-y divide-neutral-800 border-y border-neutral-800">
          {PHASES.map(([name, desc, done]) => (
            <li key={name} className="flex items-center gap-3 py-2.5 text-sm">
              <span className={done ? "text-emerald-400" : "text-neutral-600"}>{done ? "✓" : "○"}</span>
              <span className="w-48 shrink-0 text-neutral-200">{name}</span>
              <span className="text-neutral-400">{desc}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-12 border-t border-neutral-800 pt-6 text-xs text-neutral-600">
        Arc Testnet · chain {ARC_TESTNET_CHAIN_ID} · USDC <span className="font-mono">{USDC_ADDRESS.slice(0, 10)}…</span>{" "}
        · EURC <span className="font-mono">{EURC_ADDRESS.slice(0, 10)}…</span> · 196 tes unit hijau
      </footer>
    </main>
  );
}
