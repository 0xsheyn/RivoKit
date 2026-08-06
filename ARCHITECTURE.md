# Architecture

Why RivoKit is shaped the way it is — the seams, the constraints that forced
them, and the traps that cost real time and real USDC to find.

- [The problem](#the-problem)
- [Module map](#module-map)
- [The composition root](#the-composition-root)
- [The two settlement paths](#the-two-settlement-paths)
- [The PayoutRail seam](#the-payoutrail-seam)
- [State and persistence](#state-and-persistence)
- [Deployed contracts](#deployed-contracts)
- [Security model](#security-model)
- [Arc-specific behaviour](#arc-specific-behaviour)
- [Traps that already cost time](#traps-that-already-cost-time)
- [Testing strategy](#testing-strategy)
- [Repository layout](#repository-layout)

---

## The problem

Three frictions that converge on one point:

- **The payer's balance is scattered; the recipient does not want crypto.** A
  crypto-native business holds USDC across many chains; a European contractor
  wants euros in a bank account. Bridging that today means manual off-ramps,
  opaque FX and slow settlement.
- **The recipient needs certainty, not a rate.** A guaranteed local amount on a
  date — not exposure to whatever FX does between checkout and settlement. "Best
  effort" is not a payment.
- **Platforms must assemble the plumbing themselves.** "Pay in USDC, receive
  local" means stitching bridging + escrow + FX + payout across four protocols,
  each with its own failure mode, none of them the platform's core competency.

The design consequence worth naming: the guarantee is enforced **on-chain**, not
in TypeScript. The swap carries `stopLimit = priceEUR`, so a bad rate reverts the
transaction and leaves the funds in escrow. There is no code path in which the
recipient quietly receives less.

## Module map

The only genuinely new code is `orchestrator`, `settlement-fx`, `ramp` and
`payout`. The rest is calls into App Kit and protocol contracts.

```text
┌──────────────┐   call SDK    ┌─────────────────────────────────────┐
│  Host App    │──────────────►│      RivoKit SDK (TypeScript)       │
│ (marketplace │               │  orchestrator (state machine)       │
│  / payout)   │◄──── events ──│  funding · escrow · settlement-fx   │
└──────────────┘               │  ramp · payout · events             │
                               └──────────────┬──────────────────────┘
                                              ▼
                        ┌──────────────────────────────────────────┐
                        │              Arc Testnet                  │
                        │  App Kit (Gateway/CCTP) · CPP escrow ·    │
                        │  Swap (stopLimit)                         │
                        └──────────────────┬───────────────────────┘
                                           ▼
                        ┌──────────────────────────────────────────┐
                        │   CPN — fiat settlement to bank rails     │
                        └──────────────────────────────────────────┘
```

| Module | Responsibility | Source |
|---|---|---|
| `orchestrator` | Order state machine, retries, reconciliation | **New code** |
| `settlement-fx` | Quote-lock + floored swap + rebate math | **New code** (App Kit Swap) |
| `ramp` | CPN off-ramp: quote, PII encryption, intent signing, lifecycle reducer | **New code** (CPN) |
| `payout` | `PayoutRail` seam + CPN rail; **MOCK** instruction when no rail is wired | **New code** |
| `funding` | Multi-chain USDC → Arc | App Kit Unified Balance / Bridge |
| `escrow` | authorize / capture / void / refund / reclaim | Commerce Payments Protocol |
| `events` | Webhooks, signature verification, compliance screening | Circle webhooks + SCP |

**On-chain vs off-chain.** Escrowed funds, the FX conversion, the off-ramp's
Permit2 transfer and release state live **on-chain** (Arc). Order metadata, UI
status, notifications and release-hook logic live **off-chain** (host). Bank
settlement, KYB/AML and the OFI licence sit with **CPN and the licensed host**.

## The composition root

`createRivoKit` holds no keys and opens no connections. Every dependency that
needs a credential is injected. This is not a testability preference — it is what
keeps the SDK out of custody of both funds *and* secrets, and it is why the
package can be embedded by a host that must remain the party of record.

Three injections carry the weight:

- **`fund` (`FundExecutor`)** — needs the payer's signature and a funding rail.
  Both live in the host's environment. Returns the escrow authorize tx.
- **`payRebate` (`RebatePayer`)** — moves EURC or USDC out of a settlement
  wallet, so it needs that wallet's signer. Omit it and the rebate is still
  computed, stored and reported; the seller simply keeps the surplus.
- **`payoutRail`** — every off-ramp needs a payout API key, the funds owner's
  signer, and the beneficiary's PII. Three things RivoKit must not hold. Omit it
  and `payoutTo: "bank"` is refused at `createOrder`, keeping the default build
  free of payout capability rather than half-wired.

`demo/lib/rivokit.server.ts` is the reference composition; `scripts/live-sdk.mjs`
runs the same one against Arc Testnet.

## The two settlement paths

Where the money ends up is the order's choice, fixed once at `createOrder`.

**`payoutTo: "wallet"`** (default) — capture, then a floored swap USDC→EURC with
`stopLimit = €P`, ending at EURC on Arc. Cashing out is then the recipient's own
decision, made later over an accumulated balance, driven independently through
`createCpnRamp`.

**`payoutTo: "bank"`** — capture, then the off-ramp, in one call. **The EURC swap
is skipped**, and not as a shortcut:

- CPN sources **only USDC** — `sourceCurrencies: ["USDC"]`, verified against the
  live API. EURC cannot be off-ramped at all.
- So converting first would pay a spread to reach a currency that is immediately
  spent to reach another one.
- The CPN quote pins the euro the seller receives, exactly as `stopLimit` did.

The floor survives either way. On the wallet path the chain enforces it; on the
bank path RivoKit refuses to broadcast a quote that delivers less than the
guaranteed price. **That check stays in the SDK.** A host-supplied rail quotes
and broadcasts; it never decides whether the seller was paid enough.

Two consequences that are easy to miss:

- **A bank order must pay the wallet that signs Permit2.** The off-ramp spends
  the USDC that capture produced, so `receiver` is the seller's EOA, not the
  merchant wallet.
- **`payRebate` must read `token`.** Wallet-path surplus is EURC held by the
  merchant; bank-path surplus is USDC held by the seller. Ignoring the field
  sends the wrong asset from the wrong wallet, and fails only if the merchant
  happens to be short.

## The PayoutRail seam

```ts
type PayoutRail = {
  id: string; corridor: string;
  limits():   Promise<PayoutLimits>;     // read live — thresholds drift with FX
  estimate(): Promise<…>;                // sizes the order
  ready():    Promise<…>;                // approve Permit2 first
  quote():    Promise<PayoutQuote>;
  submit():   Promise<PayoutSubmission>; // IRREVERSIBLE
  status():   Promise<PayoutStatus>;
};
```

**Why `estimate()` exists.** A buffer computed against the StableFX spread does
not cover CPN's spread *and* its fees, and the shortfall surfaces only after the
escrow has been captured — the worst possible moment. Bank-bound orders are sized
by the thing that will actually execute them.

**Why `limits()` is a live read.** CPN rejects from the **destination** side
(`290100`), so the USDC threshold that clears moves with FX. 11 USDC was refused
on a corridor that accepted 12 the same day. A constant here would be wrong on a
schedule nobody controls.

**Why the fee model matters structurally.** The CPN USD/WIRE fee is **flat**, not
a spread: `BFI_TRANSACTION_FEE` measured 25.018594 USDC on a 62 USDC payment and
the identical figure on a 42 USDC quote. That is what really explains the ~61
USDC minimum (not the exchange rate), why the corridor's apparent "rate" looks
absurd (0.404–0.642) while EUR/SEPA looks normal, and why a percentage buffer can
never be the sizing strategy for a bank order.

`createCpnPayoutRail` implements this over CPN. Implement `PayoutRail` yourself
to reach anywhere else.

## State and persistence

```text
created → funding_pending → funded → settlement_pending → shipped → released
                                                                      ↓
                                                              payout_pending
                                                                      ↓
                                                                  paid_out
        refund_pending → refunded                                  failed
```

`payout_pending` means **broadcast, not delivered** — the fiat leg is
asynchronous. `paid_out` is terminal and deliberately has **no edge back to
`refund_pending`**: money in a beneficiary's bank is beyond anything an
operator-funded refund can reach, so the type system should not pretend
otherwise.

`settlement_pending` means **captured, but not yet in the promised currency**.
The escrow is already empty and the USDC sits with the receiver, which is why
there is no edge back to `funded` — that state would claim the funds are still
in escrow. The way forward is `retrySettlement()`, which re-runs only the part
that failed: the swap on the wallet path, the quote-and-broadcast on the bank
path. It never re-enters `release()`, because `release()` starts by capturing.

The lifecycle has **no self-loops**, and that is load-bearing here: a retry that
fails again cannot re-enter `settlement_pending`, so its reason is recorded as an
event rather than a transition. `order.failureReason` carries the reason from the
attempt that put it there.

**Timeout is not a parameter.** It is derived from `wedge`, because the strength
of the available proof is what should decide who an expiry favours: strong proof
(B2B, digital) → `auto_capture`; weak proof (physical goods) → `reclaim`.

**The invariants live in the database, not only in comments.** The migrations in
`infra/supabase/migrations/` carry them as constraints — `confirmed_has_tx`
refuses to mark a payout confirmed without an on-chain hash. This is load-bearing
because of an unavoidable ordering fact: `submitTransaction` returns *before* the
transfer is mined, so the Arc hash does not exist at write time. The row is
genuinely born `pending`. What closes it is a second read — `refreshPayout`, a
webhook, or `scripts/live-payout-reconcile.mjs`. The hash surfaces in exactly one
place: CPN's `onChainTransactions[].transactionHash`.

## Deployed contracts

RivoKit's **own** Commerce Payments Protocol instances, pinned to
`base/commerce-payments@3f77761`, built with solc `0.8.29`, `via_ir`,
`optimizer_runs=100000`, `evm_version=cancun`. All four are **source-verified,
full match** — on-chain creation bytecode reproduces byte-for-byte.

| Contract | Address |
|---|---|
| `AuthCaptureEscrow` | [`0x6bfd1895…700253`](https://testnet.arcscan.app/address/0x6bfd1895d519d2ec936038824b8c7ab4ff700253) |
| `ERC3009PaymentCollector` | [`0x1a9cb462…fb77b0`](https://testnet.arcscan.app/address/0x1a9cb4622e0b2985a6e2a6a3f5be613309fb77b0) |
| `OperatorRefundCollector` | [`0x6d6d512e…70ab32`](https://testnet.arcscan.app/address/0x6d6d512e3a0d26d22a69127b98460001ef70ab32) |
| `TokenStore` (deployed by the escrow) | [`0x5f903018…52997D`](https://testnet.arcscan.app/address/0x5f9030187dc31551E7B37d5343207FaeC752997D) |

RivoKit writes no Solidity of its own — `contracts/` holds compiled artifacts,
provenance and the re-verification recipe ([`contracts/README.md`](contracts/README.md)).

Collectors bind the escrow as an `immutable`. One pointed at the wrong escrow
**still deploys** and is then permanently useless, which is why `check-cpp.mjs`
asserts the wiring instead of assuming it.

## Security model

- **Non-custodial** — funds are held by the escrow contract. The operator only
  submits transactions and earns a fee; it **cannot redirect funds**.
- **Floor guarantee** — `stopLimit` ensures ≥ €P or a safe revert, enforced by
  the chain rather than by application code.
- **Anti-replay** — single-use ERC-3009 authorization nonces; unique idempotency
  keys off-chain.
- **Injected signing** — no module holds a key. Both money-moving steps
  (`FundExecutor`, `ramp.submit`) take the signer from the host, so broadcasting
  is always an explicit decision, never a side effect.
- **PII never travels in the clear** — travel-rule and beneficiary data are
  JWE-encrypted to the quote's certificate key before leaving the process.
- **Unverified webhooks reach nothing** — the signature is checked before any
  reducer sees a body, and reducers refuse to regress out of a terminal state.
- **Server-side policy** — validation and compliance screening run on the server.
  `CIRCLE_CPN_KEY` is server-only and must never be imported into a client
  component.
- **Separated authority** — deployer, operator and merchant are three distinct
  wallets; the hot operator key holds no deploy authority.
- **The operator fee pays for the relay, and never eats the floor.** It is
  grossed *onto* the payer (`netOfFee(grossUpForFee(x)) ≥ x`, tested as a
  round-trip) and split at capture.

## Arc-specific behaviour

- **USDC is the gas token** — 18 decimals as gas, 6 as ERC-20. Factor `1e12`.
  This is the source of more arithmetic bugs than anything else in the codebase.
- **Public RPCs rate-limit hard**, around the third call. `src/lib/rpc.ts`
  rotates over `ARC_TESTNET_RPC_FALLBACKS`; scripts are written to be
  *resumable*, not *repeatable*.
- **Meta-transactions that fully drain a nonce-zero account revert** — which
  touches the premise of the gasless path at its edge.
- **Foundry fork tests prove nothing here.** Arc's USDC-as-gas and its compliance
  precompiles do not exist on a local EVM, so a fork test of those paths passes
  without testing anything.
- **Arc is a Circle Mint deposit chain — for EUR.** The earlier assumption that a
  CCTP bridge was required was wrong: `GET /v1/businessAccount/wallets/addresses/deposit`
  returns an `EUR ARC` row. Old code filtered on `currency === "USD"` and never
  saw it. Do not filter by currency before looking at the whole route set.

## Traps that already cost time

Each of these was found the expensive way.

**One provider-backed adapter cannot serve both sides of a cross-chain move.**
`createViemAdapterFromProvider` takes its chain *from the provider*, so passing
the same adapter as `fromAdapter` and `toAdapter` sends the destination
transaction on the source chain — and it fails **after** the burn has landed,
stranding funds. Verified live: 2 USDC stuck, recovered by
`scripts/live-gateway-recover.mjs`. The fix is `pinnedTo()` in
`demo/app/wallet-rails.ts` — two chain-scoped views of one wallet, each calling
`wallet_switchEthereumChain` before signing. Applies equally to real MetaMask.

**A Gateway spend whose burn already landed must be resumed, never retried.**
Retrying burns twice. The error carries `recoverability: 'RESUMABLE'` plus the
attestation and signature; call `gatewayMint(...)` at `GATEWAY_MINTER_ADDRESS`.
Simulate first — the attestation is single-use, so a failing simulation means it
has already been redeemed.

**Every `*.circle.com` host is DNS-hijacked on some networks — including the
documentation.** Verified 2026-07-28: `api-sandbox.circle.com` *and*
`developers.circle.com` both resolve to `36.86.63.185` presenting a
`CN=internetpositif.id` certificate expired 2026-06-04, surfacing as a bare
`fetch failed` or a misleading `CERT_HAS_EXPIRED`. Route through
`installCircleDnsPinning()` (DoH via `1.1.1.1`, TLS still verified). Appending
`.md` to a docs URL returns raw markdown. **Never** disable TLS verification.

**The webhook public-key endpoint differs per product.** Same signature scheme,
different path: Wallets/Contracts/Gateway at `/v2/notifications/publicKey/{id}`,
**CPN at `/v2/cpn/notifications/publicKey/{id}`**. The wrong one returns 404, so
every CPN webhook is refused `401 unverifiable` while the code still looks
correct. Both authenticate with `CIRCLE_API_KEY`; `CIRCLE_CPN_KEY` is 403 there.

**Circle v2 validates a subscription URL with `HEAD`**, not an SNS handshake
(that is v1/Mint). A route exporting only `POST` answers 405 and is refused
before hosting is a question. Also: the `webhooks.test` fired at a brand-new
subscription carries no `cpn.` prefix while its key id belongs to the CPN
subscription — inferring the product from the body alone rejects the very first
thing Circle ever sends, and repeated rejections disable the subscription.

**Attribution needs the competing writer removed, not out-raced.** Two things
wrote `cpn_payments`: the webhook route, and a 12×3s poll loop inside
`broadcastPayment` calling `persistStatus`. That loop is server-side and keeps
running whether or not a browser tab is open — so "close the tab" was never a
valid experiment. The valid one broadcasts from a path that writes no status at
all (`scripts/live-webhook-attribution.mjs`) and then only reads.

**A sandbox Mint account starts in Console `default-deny` with zero policies.**
Every payout returns `transaction_denied` + `policyEvaluation: {status:
"rejected"}` — four times in a row before the cause was found. Distinguish it
from `riskEvaluation`, which appears only when the *risk* engine rejects and
carries a readable `reason`. Its absence means policy stopped it before risk ever
scored. Configured in the Console, not the API.

**SEPA payouts are far slower than USD wires** — ~8–12 minutes versus ~50
seconds. The balance debits immediately at `201` while the status stays `pending`
for a long time, so a script with a 5-minute window reports a healthy payout as
stuck. Allow at least 20 minutes.

**CPN async magic values take ~115 seconds, not "a few seconds."** Measured
2026-08-02: `AsyncFailed` → `FAILED` (`TRAVEL_RULE_FAILED`) and `Expired` →
`FAILED` (`ONCHAIN_SETTLEMENT_CUTOFF_TIME_EXCEEDED`), both at t+115s. A 20-second
polling window reports both as hung.

**CPN quotes expire in ~30–60 seconds.** Prepare-then-hesitate →
`PAYMENT_EXPIRED` (`PM09000`). `submit` cannot be cancelled past `BROADCASTED`.
The sender must approve Permit2 first or the broadcast fails.

**The operator's USDC allowance is bound to the refund collector address.**
Redeploy the collector → allowance is 0 → `refund` reverts. Re-run
`node scripts/check-operator.mjs` after any redeploy.

## Testing strategy

Three layers, deliberately unequal.

- **Unit** (`npm test`) — 488 green / 28 files, no credentials. State machines,
  unit conversion, quote/rebate math, the fee gross-up round-trip, facade
  composition, compliance gating, webhook ECDSA verification, ERC-3009
  sign+recover, the whole CPN layer.
- **Live proofs** (`scripts/live-*.mjs`) — against Arc Testnet itself. This is
  where anything touching a chain or a network is actually verified.
- **API probes** (`scripts/probe-*.mjs`) — map real service behaviour instead of
  assuming it: CPN response shapes, per-corridor requirements, sandbox magic
  values, the corridor catalog.

The split is honest about its own gap. The unit tests are weighted toward pure
logic; the network-facing modules have no direct tests and the facade tests mock
them. That gap is enumerated in [LIMITATIONS.md](LIMITATIONS.md) — and it is not
theoretical: two real defects lived exactly there and passed every test.

## Repository layout

```text
rivokit/
├── src/
│   ├── sdk/            # RivoKit facade
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
├── demo/               # Next.js marketplace + /sdk state-machine page
└── .live-state/        # resume state for live scripts (gitignored, see below)
```

`.live-state/` is what lets an interrupted live run **continue** rather than
start again — the sharp case being a CCTP bridge whose burn has landed but whose
mint has not, where starting over burns a second amount instead of recovering
the first. Written through `scripts/lib/state.mjs`, which anchors the path to the
checkout rather than the CWD: a bare relative path meant the same script run from
a subdirectory kept a second, always-empty state file, and an empty state file
does not fail — it silently redoes work that costs money.

### Scripts

| Group | Scripts |
|---|---|
| **Setup / health** | `preflight` (read-only, Arc) · `check-source-chains` (read-only, the four chains a buyer funds FROM — USDC *and* native gas, which is not USDC there) · `check-resilience` (read-only, which failure paths the stored data can currently reach, and which listing is buyable at all) · `setup` (idempotent deploy) · `check-cpp` (8 wiring assertions) · `check-hash` (off-chain vs on-chain payment hash) · `check-operator` (refund allowance) · `sync-env` |
| **Live proofs** | `live-sdk` (full flow through the facade) · `live-sdk-bank` · `live-demo-bank` · `live-payout-reconcile` · `live-cashout-reconcile` (standalone cash-out rows no order owns) · `live-order-reconcile` (orders whose funding result was never written back) · `live-wallet-rails` · `live-gateway-recover` · `live-cpn-to-mint` · `live-webhook-attribution` · `live-bridge` · `live-refund` · `live-recovery` · `live-charge` · `live-compliance` · `live-scenario` · `live-ramp*` · `live-mint-arc-deposit` · `live-cpn-subscribe` |
| **API probes** | `probe-cpn-source` (source currencies + corridor catalog) · `probe-cpn-lifecycle` (every state reachable without a broadcast) · `probe-cpn-status` · `probe-circle-eoa-sign` (can a Circle wallet sign so a counterparty can recover?) · `probe-circle-multichain` (does one wallet carry one address across chains?) · `probe-swap` · `probe-mint*` · `probe-wallet-rails` |
| **Demo utils** | `demo-topup` · `demo-expire` (age an unpaid order so the expiry branch can be walked without waiting an hour) · `reset-demo` |

The three reconciliation sweeps are siblings and cover disjoint ground —
`live-order-reconcile` for an order stuck in `funding_pending`,
`live-payout-reconcile` for a payout's ledger row, `live-cashout-reconcile` for
a `cpn_payments` row no order owns. All three are idempotent, and none of them
can close what it cannot verify: a `refund_pending` order is reported, never
marked refunded, because escrow state says nothing about the origin-chain leg.

Everything that spends sits behind an explicit `CONFIRM=` environment variable —
22 of the 30 `live-*` scripts — except two allowance writes, named below.
`probe-*` and `check-*` scripts fund nothing and cost nothing.

The eight ungated scripts, and why:

| Script | Why it is ungated |
|---|---|
| `live-ramp` | Stops before submit by design — quote and prepare only |
| `live-ramp-preflight` | Reads |
| `live-payout-reconcile` · `live-cashout-reconcile` · `live-order-reconcile` · `live-compliance` | Touch status rows, not funds. `live-order-reconcile` is given an escrow sender that throws, so "read-only against the chain" is enforced rather than intended |
| `live-ramp-approve` · `live-ramp-revoke` | On-chain allowance writes — real, but bounded and fully reversible, and `revoke` is `approve`'s undo. A prompt here would be ceremony |

`demo-expire` writes no money either, and its guards are of a different kind:
`pre_approval_expiry` is hashed into a payment's on-chain identity, so it
refuses any order that is not `created` and any order that already has a
payment row. On an unfunded order there is no on-chain payment to disagree with,
which is the only reason the edit is safe at all.

Two gates are placed on the **first** run rather than on the script.
`live-bridge` and `live-bridge-amoy` skip the check once a burn has been
attempted, because a resumed run must stay cheap — make recovery annoying and
the operator reaches for `--reset`, which burns a second amount instead of
recovering the first.

`live-cpn-to-mint` is not gated but **refuses outright**, needing
`CONFIRM=REPEAT-KNOWN-DEAD-END`. Its question — does a CPN payment credit a
Circle Mint EUR balance? — is answered, and the answer is no; the sandboxes are
not connected. It cost 12 USDC to learn. A confirmation prompt is the wrong
shape when the finding is already in hand, and the file is kept because deleting
it would lose the method behind a claim [LIMITATIONS.md](LIMITATIONS.md) leans
on.
