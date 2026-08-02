<div align="center">

# RivoKit

### An embeddable cross-border settlement SDK on Arc — multi-chain USDC in, local-currency out.

![chain](https://img.shields.io/badge/chain-Arc%20Testnet%20(5042002)-blue) ![contracts](https://img.shields.io/badge/contracts-verified%20on%20Arc-success) ![tests](https://img.shields.io/badge/tests-424%20passing-brightgreen) ![status](https://img.shields.io/badge/status-mvp%20%C2%B7%20testnet-orange) ![stack](https://img.shields.io/badge/stack-TypeScript%20%2B%20App%20Kit-3178c6) ![node](https://img.shields.io/badge/node-%3E%3D20-339933) ![license](https://img.shields.io/badge/license-Apache--2.0-green)

[Overview](#overview) · [Problem](#the-problem-it-solves) · [Why](#why-rivokit) · [How it works](#how-it-works) · [Architecture](#architecture) · [Quickstart](#quickstart) · [Contracts](#deployed-contracts-arc-testnet) · [API](#api) · [Corridors](#cpn-corridors-on-arc) · [Security](#security-model) · [Limitations](#limitations--honest-boundaries)

</div>

> ⚠️ **Testnet only, unaudited.** Do not use real funds or mainnet keys.
> `release()` reaches a bank for orders created with `payoutTo: "bank"`; orders
> left on the default `"wallet"` still end at EURC on Arc and hand the host a
> labelled `MOCK` instruction. What is proven and what is not is stated exactly in
> [Proven live vs not](#proven-live-vs-not) — read that before believing anything here.

`README_v0.md` keeps the previous long-form README (full integration
walk-through, per-step code samples).

---

## Overview

RivoKit is a **money-orchestration layer** that a marketplace, payout app or
invoicing system embeds into its checkout. It moves value from *"the payer pays
USDC from any chain"* to *"the recipient is paid"* — with a locked FX quote,
optional escrow, automatic refunds, gasless UX, and a fiat exit.

Two legs, normally bought separately:

1. **Settlement on Arc** — multi-chain USDC → escrow → floored USDC→EURC swap,
   so the recipient is guaranteed **≥ €P** on-chain.
2. **Fiat off-ramp** — USDC on Arc → a beneficiary's bank account in EUR, BRL,
   MXN or USD through the Circle Payments Network (CPN).

**What actually runs today**, not a roadmap:

- Its **own** Commerce Payments Protocol instances deployed on Arc Testnet —
  all four contracts [source-verified, full match](#deployed-contracts-arc-testnet).
- The escrow lifecycle, the floored swap, multi-chain funding and refund
  bridge-back, all **proven against the real chain**, not a fork.
- A **25 bps operator fee** grossed onto the payer and split at capture without
  ever touching the recipient's floor — proven in tx `0x7910f1…037420`.
- **Both target CPN corridors reached `COMPLETED`** — EUR/SEPA twice (15 USDC →
  12.92 EUR) and USD/WIRE once, wallet-signed (62 USDC → 36.96 USD). Real USDC
  left real wallets on Arc, so the fiat leg is no longer a mock — but
  `COMPLETED` is Circle *reporting* the fiat leg finished, not anyone watching
  euros arrive. See [Two legs, two grades of evidence](#two-legs-two-grades-of-evidence--read-this-before-the-table).
- **A second, independent fiat exit, wired all the way back to Arc**: the
  seller's EURC goes straight from Arc into a Circle Mint balance — Circle
  exposes an EUR deposit address on Arc, so there is no bridge and no detour
  through dollars — and Mint redeem then reached `complete` for EUR → SEPA
  (twice) and USD → wire. Two rails now reach a bank, which is what stops the
  fiat story resting on one integration.
- **A cash-out the server cannot forge.** A connected wallet signs the CPN
  intent itself and the server only broadcasts it; no key for that address
  exists server-side. Proven from a *zero* Permit2 allowance: approve 15 USDC,
  spend it on a 15 USDC → 12.95 EUR payout, allowance back to 0.
- **Webhooks that are verified, not trusted.** Circle delivers to the route over
  HTTPS, each event is checked against the live `X-Circle-Signature` using its
  product's key endpoint, a body edited by one digit is refused, and verified
  events fold into the stored cash-out — duplicates and out-of-order arrivals
  writing nothing.
- **424 unit tests** across 24 files, runnable with no credentials at all.

RivoKit is **not** a marketplace, wallet, custodian, or licensed institution. It
orchestrates; the **licensed host** that embeds it stays the party of record.
It writes no primitives from scratch — it composes App Kit (bridge/swap/unified
balance), the Commerce Payments Protocol (escrow) and CPN (fiat) behind one API.

## The problem it solves

Three frictions that all converge on the same point:

- **The payer's balance is scattered; the recipient doesn't want crypto.** A
  crypto-native business holds USDC across many chains, while a European
  contractor only wants euros in a bank account. Bridging that today means
  manual off-ramps, opaque FX, and slow settlement.
- **The recipient needs certainty, not a rate.** They want a *guaranteed* local
  amount on a date — not exposure to whatever FX does between checkout and
  settlement. "Best effort" is not a payment.
- **Platforms must assemble the plumbing themselves.** Offering "pay in USDC,
  receive local" means stitching bridging + escrow + FX + payout across four
  protocols, each with its own failure mode, none of them the platform's
  core competency.

RivoKit closes all three: the payer pays from any chain, the recipient is
guaranteed **≥ €P** in EURC on Arc and can cash out to their own bank, and the
platform calls a handful of functions instead of becoming a payment company.

The design consequence worth naming: the guarantee is enforced **on-chain**, not
in TypeScript. The swap carries `stopLimit = priceEUR`, so a bad rate reverts
the transaction and leaves the funds in escrow. There is no code path in which
the recipient quietly receives less.

## Why RivoKit

| | |
|---|---|
| 🌉 **Multi-chain by default** | Payers pay from a USDC balance on any chain (unified balance / CCTP) — RivoKit routes it to Arc. |
| 🔒 **Non-custodial** | Funds sit in the escrow contract on Arc, **never** on RivoKit's servers. |
| 🎯 **Recipient floor guarantee** | `stopLimit = EUR price` → the recipient gets **at least €P, or the swap reverts** with funds safe. |
| 🏦 **A real fiat exit** | One USDC balance on Arc reaches SEPA / PIX / SPEI / WIRE — driven to `COMPLETED` on both EUR/SEPA and USD/WIRE, not a printed instruction. The on-chain half is verifiable; the bank credit is Circle's report. |
| 🔁 **Automatic refunds** | On failure or expiry, USDC is bridged back to the payer's origin chain. |
| ⛽ **Gasless-ready** | ERC-3009 `receiveWithAuthorization` + operator relay; the payer never holds Arc gas. |
| 💸 **The relay pays for itself** | The operator fee is grossed onto the payer and split at capture — it never eats the floor. |
| ✅ **Verifiable, not asserted** | Every deployed contract is source-verified on the explorer, and `check-cpp.mjs` asserts the wiring instead of trusting it. |

## How it works

```text
setup      ─► AuthCaptureEscrow ─► collectors (bound by immutable) ─► verify wiring

settlement ─► createOrder    compliance screen → FX quote locked → stored
           ─► fund           multi-chain USDC ─► Arc ─► gasless ERC-3009 authorize
           ─► host release hook  (milestone / SLA / access granted)
           ─► release  ┬ wallet  capture ─► swap USDC→EURC, stopLimit = €P ─► rebate
                       └ bank    capture ─► CPN quote pinned to €P ─► broadcast
           ─► refund         void/refund ─► bridge back to receivingChain

off-ramp   ─► quote     rate + fees locked, ~30–60s
           ─► prepare   encrypt PII, create payment + Permit2 intent — moves nothing
           ─► submit    sign + broadcast — IRREVERSIBLE past BROADCASTED
           ─► CPN settles fiat to the beneficiary's bank
```

**Where the money ends up is the order's choice**, set once at `createOrder`:

- **`payoutTo: "wallet"`** (default) — settlement ends at EURC on Arc. Cashing
  out is then the recipient's own decision, made later over an accumulated
  balance, and driven independently through `createCpnRamp`.
- **`payoutTo: "bank"`** — `release()` captures and drives the off-ramp itself,
  in one call. The EURC swap is **skipped**, and not as a shortcut: CPN only
  sources USDC, and its quote pins the euro the seller receives just as the
  swap's `stopLimit` did. Converting first would pay a spread to reach a
  currency that is immediately spent to reach another one.

The floor survives either way. On the wallet path it is enforced by the swap's
`stopLimit`; on the bank path RivoKit refuses to broadcast a quote that delivers
less than the guaranteed price. That check stays in the SDK — a host-supplied
rail quotes and broadcasts, it never decides whether the seller was paid enough.

Two **modes**, mapping straight onto Commerce Payments Protocol operations:

- **`escrow`** (default) — `Authorize → Capture`. Funds held until the host's
  release hook fires.
- **`direct`** — `Charge`, atomic. For trusted payouts and approved invoices.

**Timeout is not a parameter.** It is derived from `wedge`, because the strength
of the available proof is what should decide who an expiry favours: strong proof
(B2B, digital) → `auto_capture`; weak proof (physical goods) → `reclaim`.

## Architecture

The only genuinely new code is **`orchestrator`**, **`settlement-fx`** and
**`ramp`**; the rest is calls into App Kit and protocol contracts.

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
                        │   SEPA · PIX · SPEI · WIRE                │
                        └──────────────────────────────────────────┘
```

| Module | Responsibility | Source |
|---|---|---|
| `orchestrator` | Order state machine, retries, reconciliation | **New code** |
| `settlement-fx` | Quote-lock + floored swap + rebate math | **New code** (App Kit Swap) |
| `ramp` | CPN off-ramp: quote, PII encryption, intent signing, lifecycle | **New code** (CPN) |
| `funding` | Multi-chain USDC → Arc | App Kit Unified Balance / Bridge |
| `escrow` | authorize / capture / void / refund / reclaim | Commerce Payments Protocol |
| `payout` | `PayoutRail` seam + CPN rail; **MOCK** instruction when no rail is wired | `arc-fintech` pattern |
| `events` | Webhooks, signature verification, compliance | Circle webhooks + SCP |

**On-chain vs off-chain:** escrowed funds, the FX conversion, the off-ramp's
Permit2 transfer and release state live **on-chain** (Arc). Order metadata, UI
status, notifications and release-hook logic live **off-chain** (host). Bank
settlement, KYB/AML and the OFI licence sit with **CPN and the licensed host**.

`createRivoKit` is a composition root, not a service: it holds no keys and opens
no connections. Every dependency that needs a credential is injected — that is
what keeps the SDK out of custody of both funds and secrets.
`demo/lib/rivokit.server.ts` is the reference wiring; `scripts/live-sdk.mjs`
runs the same one against Arc Testnet.

## Quickstart

```bash
git clone https://github.com/0xsheyn/RivoKit.git && cd RivoKit
npm install                      # runs `prepare` → builds dist/
cp .env.example .env.local       # fill in credentials (see Environment)
npm test                         # 424 tests / 24 files, no credentials needed

node scripts/preflight.mjs       # read-only: checks prerequisites, spends nothing
npm run setup                    # deploy escrow + collectors, create wallets (idempotent)
node scripts/check-cpp.mjs       # 8 wiring assertions on what was just deployed

npm run dev                      # marketplace demo → http://localhost:3000
```

| Command | Does |
|---|---|
| `npm test` | vitest, 424 green / 24 files, no credentials |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build:lib` | SDK → `dist/` (ESM + `.d.ts`), entry `src/index.ts` |
| `npm run setup` | deploy CPP instances + operator/merchant wallets (idempotent) |
| `npm run dev` | Next.js demo (`next dev demo`) |
| `npm run build` | `next build demo` — **never** while `npm run dev` is running (corrupts `.next`) |

Install into another app straight from git — the package is `private` (never on
the npm registry, deliberately) but otherwise normal:

```bash
npm install github:0xsheyn/RivoKit     # or: npm install file:../RivoKit
```

The demo is a Next.js marketplace over **four role columns**, each holding only
the authority that role really has: Buyer (signs ERC-3009 in MetaMask), Seller
(picks the wallet that receives the floor), Host (the release hook — only the
host releases or refunds), Wallet Seller (the CPN cash-out panel). `/sdk` is a
second page driving the same SDK as a bare state machine with an execution
inspector.

## Deployed contracts (Arc Testnet)

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

RivoKit writes no Solidity of its own. `contracts/` holds only the compiled
artifacts plus the provenance and re-verification recipe — see
[`contracts/README.md`](contracts/README.md).

Collectors bind the escrow as an `immutable`: one pointed at the wrong escrow
**still deploys** and is then permanently useless. `check-cpp.mjs` asserts the
wiring rather than assuming it.

## Chain constants

| Item | Value |
|---|---|
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |
| USDC | `0x3600…0000` — 6 decimals as ERC-20, **18 as native gas** |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

## Environment

Copy `.env.example` → `.env.local` (gitignored, never commit). These are the
names the code actually reads.

```bash
CIRCLE_API_KEY=            CIRCLE_ENTITY_SECRET=      CIRCLE_BLOCKCHAIN=ARC-TESTNET
KIT_KEY=                   # App Kit — FX swap
CIRCLE_CPN_KEY=            # fiat off-ramp — SERVER-ONLY, never import client-side
CIRCLE_RAMP_KEY=           # Circle Mint redeem — optional; USD and EUR/SEPA both proven
NEXT_PUBLIC_ARC_RPC_URL=https://rpc.testnet.arc.network
DEPLOYER_PRIVATE_KEY=      RELAYER_PRIVATE_KEY=       BUYER_PRIVATE_KEY=
NEXT_PUBLIC_SUPABASE_URL=  SUPABASE_SECRET_KEY=

# written by `npm run setup` — do not fill by hand
NEXT_PUBLIC_RIVO_ESCROW_ADDRESS=  NEXT_PUBLIC_RIVO_TOKEN_COLLECTOR_ADDRESS=
NEXT_PUBLIC_RIVO_REFUND_COLLECTOR_ADDRESS=
OPERATOR_WALLET_ID=  OPERATOR_ADDRESS=  MERCHANT_ADDRESS=

# demo knobs (optional, read by demo/lib/rivokit.server.ts)
RIVO_FEE_BPS=25            # operator fee at capture; 0 = fully subsidised
RIVO_FEE_RECEIVER=         # default: OPERATOR_ADDRESS
MIN_OPERATOR_GAS_USDC=0.5  # createOrder is refused below this operator gas float
```

The deployer and the operator must be **different** keys — the operator is hot,
signs every payment, and must not also hold deploy authority.

## API

```ts
import { createRivoKit, createCpnRamp } from "rivokit";
```

**Settlement — `createRivoKit(deps)`**, deps: `{store, escrow, fx, bridge, fund, config, compliance?, emitter?, payRebate?, payoutRail?, operatorGas?, refundBridgeParams?}`

| Method | Description |
|---|---|
| `createOrder({payer, receiver, priceEURMinor, receivingChain, wedge, mode?, payoutTo?, bufferBps?})` | screen → size → store. `payoutTo: "bank"` needs `payoutRail`, is sized from that rail, and is refused here if the corridor would not take it |
| `fund(orderId, opts?)` | multi-chain USDC → Arc → `authorize`. `opts.signature` relays a browser-signed ERC-3009 |
| `release(orderId, proof)` | `capture` → floored swap → payout instruction (MOCK), **or** `capture` → off-ramp broadcast for a bank order |
| `refreshPayout(orderId)` | poll the rail and advance a broadcast payout. Fallback for hosts with no webhook endpoint |
| `refund(orderId)` | `void`/`refund` + bridge-back to `receivingChain` |
| `status(orderId)` · `payoutFor(orderId)` | current order · the payout record (both async; it is persisted, so it survives a restart) |
| `estimateSwap({address, amountInMinor})` | FX quote without executing |
| `on/off(event, handler)` | `funding_pending` · `funded` · `released` · `payout_pending` · `paid_out` · `refund_pending` · `refunded` |

`released` carries `{orderId, eurcOutMinor, rebateMinor}`; `payout_pending`
carries the CPN `paymentId` and what was broadcast. `OrderState`:
`created · funding_pending · funded · settlement_pending · shipped · released ·
payout_pending · paid_out · refund_pending · refunded · failed`.

`payout_pending` means BROADCAST, not delivered — the fiat leg is asynchronous.
`paid_out` is terminal and has no edge back to `refund_pending`: money in a
beneficiary's bank is beyond anything an operator-funded refund can reach.

**Off-ramp rail — `createCpnPayoutRail({ramp, corridor, destinationCountry, senderAddress, details, signIntent, ensureAllowance?})`**

Implement `PayoutRail` yourself to off-ramp somewhere else. The API key, the
funds owner's signer and the beneficiary's PII are all injected; the floor check
stays in the SDK.

**Off-ramp — `createCpnRamp({apiKey, corridor})`**: `quote` · `prepare` (safe) ·
`submit(args, signer)` (irreversible) · `submitSigned(args, signature)` ·
`status`. Helpers: `verifyAndInterpretCpn` (throws on a bad signature),
`applyPaymentEvent` (forward-only reducer), `rfiEffect`, `isPointOfNoReturn`.

`submit` assumes the signer is reachable from wherever the API key lives — true
for a server key, false when the funds owner signs in their own browser wallet.
`submitSigned` takes a signature produced elsewhere, so the wallet that *holds*
the USDC can be the one that authorizes it to leave. Build the wallet's typed
data with `normalizeTypedData(transaction.messageToBeSigned)`.

Money crosses the boundary as **`bigint` minor units** in and **strings** out —
never a float. Signing is always **injected**; no module holds a key.

Corridors, read live from `GET /v1/cpn/payments/requirements`:

| Corridor | Method | Beneficiary fields | Min |
|---|---|---|---|
| EUR | SEPA | `IBAN`, `RECIPIENT_LEGAL_NAME` | ~12 USDC |
| BRL | PIX | `RECIPIENT_ID_NUMBER`, `RECIPIENT_EVP` | ~10 USDC |
| MXN | SPEI | `CLABE` + national ID | ~11 USDC |
| USD | WIRE | `BANK_NAME`, `SWIFT_CODE`, `BANK_COUNTRY`, `ACCOUNT_NUMBER`, `RECIPIENT_LEGAL_NAME` | ~61 USDC |

Those minimums are approximate on purpose: CPN enforces the limit on the
**destination** side, so the USDC amount that clears moves with FX. On EUR/SEPA,
11 USDC (~9.4 EUR) is rejected with `290100` while 12 USDC (10.31 EUR) is
accepted. Treat the API's answer as the authority, not a hard-coded floor.

### Invariants the SDK enforces

1. The recipient receives **≥ `priceEURMinor`** or the swap reverts, funds safe.
2. Refunds always go to the recorded `receivingChain`.
3. `rebate = max(0, actualOutput − priceEURMinor)`.
4. ERC-3009 nonces are single-use (anti-replay).
5. Money is always integer minor units — never a float.
6. Illegal state sequences are unrepresentable: a `capture` on an unfunded order
   is refused before it can reach the escrow and revert.
7. A CPN payment only moves forward; a duplicate or late webhook after a
   terminal state is ignored, not replayed.

## Scripts

Everything under `scripts/` hits real services and needs `.env.local`.

| Group | Scripts |
|---|---|
| **Setup / health** | `preflight` (read-only prereq check) · `setup` (deploy, idempotent) · `check-cpp` (escrow↔collector wiring, 8 assertions) · `check-hash` (off-chain `getPaymentInfoHash` vs on-chain `getHash`) · `check-operator` (grants + proves the operator's USDC allowance to the refund collector) · `sync-env` |
| **Live proofs** | `live-phase1/1b/2/2-chain` · `live-funding` · `live-bridge` · `live-unified` · `live-refund` · `live-recovery` (capture ok, swap misses floor, retry wins) · `live-charge` (direct mode) · `live-compliance` · `live-sdk` (full flow through the facade) · `live-scenario` · `live-ramp*` · `live-mint-arc-deposit` (seller EURC on Arc → Mint balance; sends only behind `CONFIRM=DEPOSIT`) · `live-cpn-subscribe` (lists subscriptions; `--check <url>` tests the `HEAD` Circle validates with; creates only behind `CONFIRM=SUBSCRIBE`) · `live-webhook-attribution` (cash-out with the polling writer removed, so only a webhook can move the row; broadcasts only behind `CONFIRM=BROADCAST`) |
| **API probes** | `probe-cpn*` (quote, payment, status, magic values) · `probe-cpn-lifecycle` (drives every payment state reachable without a broadcast — async failure, expiry, RFI levels 1–3 — and checks each against the reducer; costs nothing, funds nothing) · `probe-swap` · `probe-mint` (USD → wire) · `probe-mint-sepa` (links an IBAN account; redeems only behind `CONFIRM=REDEEM`) · `probe-mint-deposit` |
| **Demo utils** | `demo-topup` (fund the buyer on the source chain + Gateway) · `reset-demo` (wipe orders) |

## Testing

- **Unit** — `npm test`, 424 green / 24 files, no credentials. State machine,
  unit conversions, quote/rebate math, fee gross-up round-trip
  (`netOfFee(grossUpForFee(x)) ≥ x`), facade composition, compliance gating,
  webhook ECDSA verification, ERC-3009 sign+recover, the whole CPN layer. What
  they deliberately do not reach is listed in
  [What the tests do not guard](#what-the-tests-do-not-guard) — read it before
  treating a green run as coverage.
- **Live proofs** — `scripts/live-*.mjs` against Arc Testnet itself.
- **API probes** — `scripts/probe-*.mjs` map real service behaviour instead of
  assuming it (CPN response shapes, per-corridor requirements, sandbox magic
  values).

Foundry **fork tests prove nothing here**: Arc's USDC-as-gas and its
compliance precompiles do not exist on a local EVM, so a fork test of those
paths passes without testing anything.

### Two legs, two grades of evidence — read this before the table

Every claim below falls into one of two classes, and they are **not**
interchangeable. Conflating them is the single easiest way to overstate this
project.

| | **On-chain leg** | **Fiat leg** |
|---|---|---|
| What it covers | USDC leaving a wallet, escrow, capture, swap, the transfer into CPN's contract | A bank crediting a beneficiary |
| Evidence | **Verified.** Arc transaction hashes anyone can open in an explorer, balances that moved | **Asserted by Circle.** A `COMPLETED` status, a `fiatNetworkPaymentRef`, a `fiatSettlementTime` of 1–3 days |
| Who can check it | Anyone, independently, forever | Only the beneficiary, by reading their bank statement |
| Status here | Proven repeatedly | **Never observed — not once** |

The fiat leg is unobservable here **by construction**, not by omission:

- Circle's sandbox is a simulator. Payment statuses are driven by magic values
  on `ORIGINATOR_NAME`, and the documentation states that sandbox refund
  transaction hashes are *"randomly generated"*
  ([magic values](https://developers.circle.com/cpn/references/testing/magic-values)).
  No sandbox payment settles money, however many reach `COMPLETED`.
- Every payout destination in this repo is a **fabricated IBAN** — the canonical
  French example account, "Acme SARL". No balance exists behind it to inspect.
- The one time a payout was aimed at a destination whose balance *could* be read
  — Circle Mint's own EUR deposit IBAN — the payment reached `COMPLETED`, 12 USDC
  genuinely left the seller's wallet, and **the destination balance never moved**.

So when this README says a corridor "settled", it means *CPN reported the fiat
leg finished*. It does not mean anyone watched euros arrive. The only thing that
would settle the question is one real payment on mainnet into an account you
control — see [Roadmap](#roadmap).

### Proven live vs not

| Path | Status |
|---|---|
| Escrow lifecycle · floored swap · multi-chain funding · refund bridge-back · full flow via the facade | ✅ proven on Arc |
| **`release()` reaching a bank in one call — escrow → EUR/SEPA, no separate cash-out step** | ✅ order `ord_1785510582_657861`, `payoutTo: "bank"`. capture [`0x631405…9966698`](https://testnet.arcscan.app/tx/0x63140582f99e748e2af4c4f1f281fc086f5ee953f861668eb161adf7a9966698) → CPN `61d22d57…` **`COMPLETED`**, 11.751140 USDC → €10.00 exactly. Order walked `funded → payout_pending → paid_out`; stored payout is `kind: cpn`, `label: LIVE`, `executed: true`. `scripts/live-sdk-bank.mjs`, 2026-07-31 |
| Rebate on the bank path — the payer's surplus returned as **USDC** | ✅ order `ord_1785512905_183957`: buyer's on-chain balance rose **exactly** `0.474498` USDC, matching `rebateMinor`, tx [`0x50ef69…677c7c9e`](https://testnet.arcscan.app/tx/0x50ef691a0e2123966b81451f09dee0cb0a4a9e1f9f30699419bd90f7677c7c9e). Checked against the chain, not against the event |
| The payout ledger row settles with the mined Arc hash | ✅ all four rows `confirmed` with hashes (`authorize` · `capture` · `payout` `0x56b337…fa3f7f5f` · `rebate`). The hash comes from CPN's `onChainTransactions`, the only place it surfaces |
| A stale ledger row can be repaired after the fact | ✅ `scripts/live-payout-reconcile.mjs` walked `ord_1785510582_657861` from `pending` → `confirmed` with tx `0xfa3ba6…3a05a7d1`, through `refreshPayout` — the same path a webhook takes |
| **The SDK demo page reaches a bank from its own UI** | ✅ `ord_1785608622_324408` (€12.00, `payoutTo: "bank"`) → CPN `0a44d36f…` **`COMPLETED`**, order `paid_out`, payout `kind: cpn` / `label: LIVE`. Four ledger rows `confirmed`: authorize + capture 14.680697 ([`0xf83ad3…e55e3299`](https://testnet.arcscan.app/tx/0xf83ad3465f2e09bb5407a684fd2d48bbce88c9a41b2fd36cd9ad1470e55e3299), [`0xe7338a…f18a0f97`](https://testnet.arcscan.app/tx/0xe7338a7c49ff911b6b1722c9bdcf25f8be05a0539275621e13ef3f1bf18a0f97)), payout 14.080788 ([`0x3eb5ad…756cf6b48`](https://testnet.arcscan.app/tx/0x3eb5ad125607911d9f7e1f05c73595b9ef196e92f51b516153b7b39756cf6b48)), rebate 0.563208 ([`0x9c9148…c22fb780`](https://testnet.arcscan.app/tx/0x9c914879b997b9af5278e4c93d26d21dabbcf8511a1ce00d06678097c22fb780)). Repeated once more on `ord_1785607838_340322` → CPN `f5c7fb2c…` `COMPLETED` |
| **The marketplace demo reaches a bank through its own server actions** | ✅ `ord_1785518681_912453` via `mpCheckout → mpPay → mpRelease → mpRefreshPayout`: CPN `134aa6f6…` **`paid_out`**, all four ledger rows `confirmed` with hashes, rebate `0.470646` USDC returned (tx [`0x082480…25a955c4`](https://testnet.arcscan.app/tx/0x0824800d7b806300282302771030b530aaa014d4961308bcd2f6111e25a955c4)). `scripts/live-demo-bank.mjs` 12/12. The UI button is still missing — this drove the actions directly |
| Bank order sized from the PAYOUT rail, not from StableFX | ✅ CPN priced the €10.00 floor at 11.75 USDC; +400 bps buffer → 12.221241 USDC authorized. Permit2 approved for exactly that in [`0xee970d…d57ae06`](https://testnet.arcscan.app/tx/0xee970d3a847cf9a98281644ca0c264180554551786f15e7204506f272d57ae06) |
| Operator fee 25 bps split at capture, floor intact | ✅ `0x7910f1…037420` |
| Two-wallet mode — floor forwarded merchant → seller wallet | ✅ `0x11bf41…559bf4` |
| CPN EUR/SEPA end-to-end → `COMPLETED` | ✅ twice (15 USDC → 12.92 EUR) |
| Seller-signed cash-out — the seller's own wallet signs the CPN intent | ✅ proven — MetaMask signed, 15 USDC → 12.94 EUR `COMPLETED`, tx [`0x51e968…f049e7f`](https://testnet.arcscan.app/tx/0x51e9681d1d23fedeb239110a2c58309912a5c82d35a20c316b3102731f049e7f) |
| Wallet-side Permit2 **approve** branch, from a zero allowance | ✅ wallet `0xd7d7B4…` approved 15 USDC in tx [`0xdeebf4…cf11177a`](https://testnet.arcscan.app/tx/0xdeebf45ad5e1747693e33e2de0dabca14ccef1323d27d29aaaf598f7cf11177a), spent it on a 15 USDC → 12.95 EUR cash-out, allowance back to 0 |
| Circle Mint redeem — USD → wire bank | ✅ `complete` — 10.00 USD, balance 350.00 → 340.00, payout `3f708440…`, trackingRef `CIR2V7GVUJ` |
| Circle Mint redeem — EUR → SEPA bank | ✅ `complete` twice — 10.00 EUR each, balance 273.49 → 253.49, payouts `9d98c66f…` + `47a86ec3…` |
| Seller EURC on Arc → Mint EUR balance, **no bridge** | ✅ 1 EURC, balance 253.49 → 254.49, tx [`0x405164…52a8449e`](https://testnet.arcscan.app/tx/0x40516460af2571449291fa4448533793818dd287f9aeade449b1a13752a8449e) |
| CPN webhook delivered over HTTP into our own route | ✅ Circle validated the URL with `HEAD`, then POSTed 5 events for `056c3e1f…`; each verified live and written to `events` with `sig_verified = true` |
| Webhook signature verification | ✅ live `X-Circle-Signature` accepted, a body edited by one digit refused, `webhooks.test` accepted on a fresh subscription |
| Cash-out row advanced from a verified webhook | ✅ `acd9d389…` walked `CRYPTO_FUNDS_PENDING → FIAT_PAYMENT_INITIATED → COMPLETED`; duplicates and transaction events wrote nothing |
| *Which* writer advanced the row | ✅ settled — `da85fbcc…` broadcast with the polling writer removed, not out-raced: zero status writes from the caller, 5 verified `events` rows, row reached `COMPLETED` |
| **CPN USD/WIRE end-to-end → `COMPLETED`** | ✅ **wallet-signed** — payment `c2fec0f6…`, 2026-08-01: 62.000000 USDC from `0x7d9EEb…65bcCA` → **36.96 USD** to the destination bank, `signed_by: wallet`. Arc tx `0x7a7c8aad…d6234f` (block 54765268) moved the 62 USDC into the CPN contract, which forwarded 0.02 to the fee collector and 61.98 to Circle's settlement address. `fiatNetworkPaymentRef: RE78dzv7…`, `fiatSettlementTime` 1–3 days. Both target corridors have now settled |
| Browser-wallet funding rails (`demo/app/wallet-rails.ts`) | ✅ both executed on-chain through `createViemAdapterFromProvider` — Gateway spend tx [`0xca092f…4d774517`](https://testnet.arcscan.app/tx/0xca092f363b2dab2d891d7e29e274422f2362227c7af2283d6d6a33c49d774517), CCTP bridge mint tx [`0x35da17…fe945639`](https://testnet.arcscan.app/tx/0x35da17676282eed203afd3ccf8bcf8fe8daf9c23d7453bcb37e2f16efe945639) (Sepolia 21 → 18 exactly). Driven by an EIP-1193 provider, **not** MetaMask's UI |
| The CPN USD/WIRE fee is **flat, not a spread** | ✅ measured. On that 62 USDC payment the fee was `25.038594` USDC = `BFI_TRANSACTION_FEE` 25.018594 + gas 0.01 + service 0.01, and `62 − 25.038594 = 36.96` exactly. The same 25.018594 appears on a 42 USDC quote, which is what actually explains the ~61 USDC minimum — not the exchange rate |
| The corridor catalog on Arc, read from the API | ✅ `getOverview()` (223 destination countries) then `listRoutes()` per country, filtered to `ARC-TESTNET`: **286 routes, 14 corridors, every one sourced from USDC**. This is the *advertised* catalog, not execution proof — see [Corridors](#cpn-corridors-on-arc) |
| CPN paying **into** a Circle Mint balance | ❌ does not work, and it cost 12 USDC to learn. Payment `1a1cb321…` reached `COMPLETED` against Circle's own EUR deposit IBAN and the seller really paid (32.463489 → 20.462647 USDC), but the Mint EUR balance sat at 254.49 through T+60min and `/v1/businessAccount/deposits` recorded nothing. The sandboxes are not connected; CPN's fiat leg stops on CPN's side |
| The bug that proof found | ✅ fixed. One provider-backed adapter cannot serve both sides of a cross-chain move — App Kit sent the Arc mint on Sepolia and failed *after* the burn. `pinnedTo` now gives two chain-scoped views of one wallet; the stranded 2 USDC was recovered by `scripts/live-gateway-recover.mjs` (tx [`0x4bcadd…87e8c0f4`](https://testnet.arcscan.app/tx/0x4bcadd01c5af75b150c5d570690ff1e5399f298935cb9743cf473f1487e8c0f4)) |

CPN **BRL/PIX and MXN/SPEI** are **roadmap, not a gap** — see
[Roadmap](#roadmap). They are deliberately left unexercised during the build and
testnet phase, so they are not tracked as a status here.

### What the tests do not guard

The 424 unit tests are weighted toward pure logic — state machines, money
conversion, fee arithmetic, reducers, signature verification against a keypair
the test itself creates. The modules that talk to a network or a chain have no
direct tests, and the facade tests mock them:

| Module | How it is actually checked |
|---|---|
| `escrow/operations.ts` | live scripts only; mocked in the facade tests |
| `settlement-fx/swap.ts` | live scripts only; only `FloorNotMetError` is imported by tests |
| `orchestrator/order-store.ts` | live scripts only; tests import its *types* |
| `funding/unified-balance.ts` | no direct test; the browser rail it backs is proven on-chain by `scripts/live-wallet-rails.mjs`, and `demo/app/wallet-rails.test.ts` covers the prompt branches |
| `escrow/payment-info.ts` | no unit test, but `check-hash.mjs` asserts it against the chain |
| `lib/rpc.ts`, `lib/circle-dns.ts` | no test; both are infrastructure the live scripts lean on |

This is not a theoretical gap. Two production defects this month lived exactly
there and passed every test: the CPN public-key endpoint (tests sign with their
own keypair, so key resolution never runs) and the `webhooks.test` rejection
that silently disabled a subscription. Real traffic caught both.

## Gotchas that already cost time

- **Arc USDC is the gas token** — 18 decimals as gas, 6 as ERC-20. Factor `1e12`.
- **The operator's USDC allowance is bound to the refund collector address.**
  Redeploy the collector → allowance is 0 → `refund` reverts. Re-run
  `node scripts/check-operator.mjs` after any redeploy.
- **Public Arc RPCs rate-limit hard** (~3rd call). Use the rotation in
  `src/lib/rpc.ts`; design scripts to be *resumable*, not *repeatable*.
- **CPN quotes expire in ~30–60s.** Prepare-then-hesitate → `PAYMENT_EXPIRED`
  (`PM09000`). The sender must **approve Permit2** first or the broadcast fails.
- **`submit` cannot be cancelled** past `BROADCASTED`. Always gate it behind an
  explicit confirmation.
- **The USD/WIRE fee is a flat ~25 USDC, not a spread**, so a percentage buffer
  will not cover it and the damage grows as the order shrinks. Size bank-bound
  orders from `PayoutRail.estimate()`.
- **One provider-backed adapter cannot serve both sides of a cross-chain move.**
  `createViemAdapterFromProvider` takes its chain *from the provider*, so passing
  the same adapter as `fromAdapter` and `toAdapter` sends the destination
  transaction on the source chain — and it fails *after* the burn has landed,
  stranding the funds. Use two chain-pinned views of the one wallet
  (`pinnedTo()` in `demo/app/wallet-rails.ts`).
- **A Gateway spend whose burn already landed must be resumed, never retried.**
  The error carries `recoverability: 'RESUMABLE'` plus the attestation and
  signature; call `gatewayMint(...)` instead. Simulate first — the attestation is
  single-use, so a failing simulation means it is already redeemed.
- **Every `*.circle.com` host is DNS-hijacked here** — not just the API.
  Verified 28 Jul 2026: `api-sandbox.circle.com` *and* `developers.circle.com`
  both resolve to `36.86.63.185` presenting a `CN=internetpositif.id`
  certificate that expired 4 Jun 2026, so calls surface as a bare
  `fetch failed` or a misleading `CERT_HAS_EXPIRED`. Circle's **documentation**
  is unreachable from an ordinary fetch too; route it through
  `installCircleDnsPinning()` (DoH via `1.1.1.1`, TLS still verified), and note
  that appending `.md` to a docs URL returns the raw markdown.
  **Never** disable TLS verification.
- Meta-transactions that fully drain a nonce-zero Arc account revert.

## Security model

- **Non-custodial** — funds are held by the escrow contract (Commerce Payments
  Protocol). The operator only submits transactions and earns a fee, and
  **cannot redirect funds**.
- **Floor guarantee** — `stopLimit` ensures the recipient gets ≥ €P or a safe
  revert. It is enforced by the chain, not by application code.
- **Anti-replay** — single-use ERC-3009 authorization nonces; unique
  idempotency keys off-chain.
- **Injected signing** — no module holds a key. Both money-moving steps
  (`FundExecutor`, `ramp.submit`) take the signer from the host, so broadcasting
  is always an explicit decision, never a side effect.
- **PII never travels in the clear** — travel-rule and beneficiary data are
  JWE-encrypted to the quote's certificate key before leaving the process.
- **Unverified webhooks reach nothing** — `verifyAndInterpretCpn` checks the
  Circle signature before any reducer sees a body, and the reducers refuse to
  regress out of a terminal state.
- **Server-side policy** — validation and screening (Circle Compliance Engine)
  run on the server, never the client. `CIRCLE_CPN_KEY` is server-only and must
  never be imported into a client component.
- **Separated authority** — deployer, operator and merchant are three distinct
  wallets; the hot operator key holds no deploy authority.
- **Secrets** — credentials via environment variables, **never** committed.

Report vulnerabilities privately, not via public issues.

## CPN corridors on Arc

Read from the API on 2026-08-01 — `getOverview()` across 223 destination
countries, then `listRoutes()` per country, filtered to `ARC-TESTNET`: **286
routes, 14 corridors, every one sourced from USDC.** This is a reference for
what the network advertises, **not** a list of targets and **not** execution
proof. The build phase aimed at two corridors and both settled; the rest are
here so they never have to be mapped again.

| Corridor | Reach | Min USDC |
| --- | --- | --- |
| `USD/WIRE` | 196 countries | 36 (AU, CA, IL, NZ, TR) · 56 (143 countries) · 61 (48 countries) |
| `EUR/SEPA` | 48 countries | 11 · **1** for GG, GI, GP, IM, MQ, RE, YT |
| `EUR/WIRE` | 31 countries | 51 |
| `USD/FEDWIRE` | US | 16 |
| `AED/BANK-TRANSFER` | AE | 6 |
| `SGD/BANK-TRANSFER` | SG | 10 |
| `CNY/CIPS` | CN | 10 |
| `CNY/WIRE` | CN | 61 |
| `COP/BANK-TRANSFER` | CO | 9 |
| `COP/NEQUI` | CO | 10 |
| `HKD/WIRE` | HK | 61 |
| `HKD/CHATS` | HK | 303.42 |
| `BRL/PIX` | BR | 10 |
| `MXN/SPEI` | MX | 11 |

Four things to know before trusting any row of it:

- **`minUsdc` is indicative.** CPN rejects from the *destination* side (error
  `290100`), so the USDC threshold drifts with FX — 11 USDC was refused on a
  corridor that took 12 the same day.
- **USD/WIRE minimums are tiered per country** (36/56/61). `demo/lib/cpn.server.ts`
  hardcodes the single value 61, and only for US.
- **Each corridor carries its own `beneficiary` and travel-rule shape.** Read
  `GET /v1/cpn/payments/requirements` per corridor; copying another corridor's
  block fails validation, and `postalCode` is checked against the beneficiary
  country's format.
- Check one country with `node scripts/probe-cpn-source.mjs FR US`.

## Limitations & honest boundaries

- **Testnet / sandbox only**, unaudited — do not use real funds.
- **No euro has ever been observed arriving in a bank account.** This is the
  honest ceiling on every fiat claim here, and it is structural: the sandbox
  settles nothing, and every payout destination is a fabricated IBAN. The full
  argument, including the one experiment that tested it directly, is in
  [Two legs, two grades of evidence](#two-legs-two-grades-of-evidence--read-this-before-the-table).
  What *is* now captured is the handle a real beneficiary would reconcile
  against: `refCode` rides into the bank-statement memo, and
  `fiatNetworkPaymentRef` is stored on the payout the moment CPN issues one.
- **Both target corridors have reached `COMPLETED` — EUR/SEPA and USD/WIRE.**
  Neither is outstanding any more. But do not read the proven Circle Mint *USD → wire*
  redeem as the CPN one: that starts from a fiat balance already inside Circle
  Mint, while the CPN corridor starts from USDC on Arc and runs quote → travel
  rule → Permit2 → broadcast. Only the second is part of RivoKit's off-ramp,
  and evidence for one may never be used to claim the other.
- **The USD/WIRE fee is flat, so small orders are punished.** `BFI_TRANSACTION_FEE`
  was 25.018594 USDC on a 62 USDC payment *and* on a 42 USDC quote — the same
  absolute number, not a percentage. A €10-sized order would lose most of its
  value to it. This is also why the corridor's apparent "rate" looks wrong
  (0.404–0.642) while EUR/SEPA looks normal, and why bank-bound orders must
  never be sized with a percentage buffer alone. `PayoutRail.estimate()` exists
  for exactly this.
- **CPN cannot pay into a Circle Mint balance.** Tested with real money, so it
  need not be tested again: Circle's own EUR deposit IBAN is reachable over
  `EUR/SEPA` and CPN accepted it — payment `1a1cb321…` reached `COMPLETED` and
  12 USDC genuinely left the seller's wallet — but the Mint EUR balance never
  moved and no deposit was ever recorded. The conclusion is that CPN's fiat leg
  is simulated up to CPN's own boundary; the CPN and Mint sandboxes are not
  joined. The EURC → Mint route that *does* work is the direct Arc deposit
  address, not a CPN payment.
- **BRL/PIX and MXN/SPEI are built but deliberately unexercised** in the build
  and testnet phase — roadmap work, not an unfinished edge. See
  [Roadmap](#roadmap).
- **Circle Mint redeem is proven, in both currencies.** USD → wire bank reached
  `complete` once (10.00 USD, balance 350.00 → 340.00, payout `3f708440…`), and
  the euro-native path this project actually argues for — EUR → a SEPA bank —
  reached `complete` twice (10.00 EUR each, balance 273.49 → 253.49, payouts
  `9d98c66f…` and `47a86ec3…`), all on 28 Jul 2026. The destination is a linked
  IBAN account whose `transferTypesInfo` reports `sepa: {currencies: ["EUR"]}`,
  so the money leaves over SEPA rather than a wire wearing its name. Every
  earlier attempt failed `transaction_denied` purely because the sandbox
  account was in Console *default-deny* mode with zero policies; adding one
  flipped it, with no code change in between. The join is proven too, and it
  needs no bridge: Circle lists an **EUR deposit address on ARC**, so 1 EURC
  sent from the seller's Arc wallet credited the Mint EUR balance
  253.49 → 254.49 within seconds (tx `0x405164…52a8449e`). What remains
  deliberately unwired is the trigger — `release()` does not start a Mint
  redeem. The bank path it *does* drive is CPN, which sources USDC directly and
  so never needs the EURC leg at all.
- **The browser-wallet funding rails run on-chain, but no human has clicked the
  prompts.** `demo/app/wallet-rails.ts` lets a connected wallet reach Arc via
  Gateway spend or a CCTP bridge with no server secret involved, and both rails
  have now executed for real (Gateway spend `0xca092f…4d774517`, CCTP bridge
  mint `0x35da17…fe945639`). They were driven by an EIP-1193 provider, though,
  **not** by MetaMask's UI — so the switch-chain and add-chain prompts, and a
  user declining them, remain unobserved. Every answer to those prompts has a
  branch and a test; what is missing is the click, and no server key may stand
  in for it.
- **The seller-signed cash-out is proven, including the approval branch.** A
  connected MetaMask signs the CPN intent itself and the server only broadcasts
  it (`ramp.submitSigned`); no key for that address exists server-side. The
  wallet-side Permit2 approval — previously skipped because the test wallet
  already held an unlimited allowance — has now run from zero: `0xd7d7B4…`
  approved exactly 15 USDC, spent it on a 15 USDC → 12.95 EUR cash-out that
  reached `COMPLETED`, and its allowance returned to 0. The stored row carries
  `signed_by: "wallet"`.
- **The webhook path runs end to end; one attribution is still open.** A
  subscription registered from the CPN Console pointed at a Cloudflare quick
  tunnel. Circle validated the URL with `HEAD` (the route exports one —
  notification API v2 checks this before creating a subscription, and a
  `POST`-only route is refused there, not later), then delivered five signed
  events for cash-out `056c3e1f…`. Each was verified against the live
  `X-Circle-Signature` and written to `events` with `sig_verified = true`; a
  body edited by one digit is refused. Only the webhook path writes that table,
  so those rows are proof the transport, the verification and the persistence
  all ran.

  Which writer advanced `cpn_payments` in that run was left open, because
  `demo/lib/cpn.server.ts` reconciles from polled status too and the webhook
  (`cpn.payment.completed` at 20:32:25) landed inside the same 16-second window
  as the poll loop. That is now settled — see below.
- **The webhook, and only the webhook, advances the stored cash-out.** The
  attribution above was closed by removing the competing writer rather than
  trying to out-race it. Note the original plan — "close the demo tab so the
  poller stops" — was aimed at the wrong variable: no tab poller exists. The
  writer that raced is the loop *inside* `broadcastPayment`, twelve polls three
  seconds apart each calling `persistStatus`, which runs server-side and keeps
  running whether or not a tab is open.

  `scripts/live-webhook-attribution.mjs` prepares, records the row, broadcasts,
  and then only reads. For cash-out `da85fbcc…` (12 USDC → 10.31 EUR,
  broadcast 08:49:43.999Z) the row moved `CRYPTO_FUNDS_PENDING → COMPLETED`
  while the caller made exactly one write — the initial `recordCpnPayment` —
  and no status write at all. Five events landed in `events` with
  `sig_verified = true`, and only the webhook route writes that table. The
  single `ramp.status()` call ran *after* the observation window closed, as a
  control: CPN also said `COMPLETED`. On chain the seller went 24.000787 →
  12.000787 USDC.

  One thing that row does **not** claim: `FIAT_PAYMENT_INITIATED` was applied
  by the reducer but never sampled, because the last two webhooks arrived
  inside the same five-second read interval. What is proven is the endpoints of
  the walk, not three observed stops along it.

  Two defects surfaced only under real traffic, both invisible to the unit
  tests because those sign with their own keypair and never resolve a key.
  First, the public key endpoint differs per product: the route asked the
  Wallets path (`/v2/notifications/publicKey/{id}`) for CPN key ids, which
  answers `404`, so every CPN webhook would have been refused `401
  unverifiable`. Second, the `webhooks.test` Circle fires at a brand-new
  subscription carries no `cpn.` prefix, so it was routed to the Wallets path
  too and rejected three times — after which the subscription stopped
  receiving anything and had to be re-enabled from the Console. Key resolution
  now tries the inferred product and falls back to the other.

  Note the Console path sidesteps the API: `CIRCLE_CPN_KEY` still returns `403`
  on `/v2/cpn/notifications/subscriptions` while succeeding on
  `/v1/cpn/payments`, so `scripts/live-cpn-subscribe.mjs` needs the
  notifications capability added to the key before it can manage subscriptions
  itself.
- **`release()` triggers the off-ramp only for `payoutTo: "bank"` orders.** The
  default stays `"wallet"`, and not out of caution: a seller usually cashes out
  an accumulated balance rather than one order, which is why
  `cpn_payments.order_id` is a nullable link rather than a foreign key the flow
  depends on. Bank orders are the case where the buyer's payment IS the payout.
- **Without a `payoutRail`, the SDK's `payout` module is still a `MOCK`**
  instruction, labelled as such. It is not a bank transfer.
- **A payout's ledger row is `pending` until something reads the rail again.**
  Not a bug but worth knowing: a broadcast returns before the transfer is mined,
  so the Arc hash does not exist at write time and `confirmed_has_tx` rightly
  refuses a confirmation without one. `refreshPayout` settles the row on a later
  read, and `scripts/live-payout-reconcile.mjs` sweeps any row a crashed run
  left behind. A host with no webhook and no sweep will accumulate stale rows.
- **RivoKit does not verify the physical world.** The release hook is the host's
  judgement call; RivoKit checks consistency, it does not prove delivery.
- **In production the host must be an onboarded OFI** with CPN, plus KYB/AML on
  recipients. RivoKit is not a licensed operator and cannot be one for you.
- Depends on Circle: USDC/EURC can be frozen by the issuer, CCTP attestation is
  centralized, the public Arc RPC rate-limits aggressively, and Arc Testnet can
  go down.
- **Mainnet is out of scope** — gated on audit, key timelock/multisig, legal
  review and OFI onboarding.

## Roadmap

Ordered by what closes a structural hole rather than what adds surface. Nothing
here is a promise; it is what the honest ledger above says is still missing.

**Next — finish proving what is already written**

1. **A human clicking the wallet prompts.** The rails run on-chain, and every
   ANSWER to those prompts now has a branch and a test — switch accepted, 4902
   → add chain, an add that does not switch, a declined switch, a declined add,
   and a genuine wallet fault that must not be mistaken for a refusal. What is
   left is seeing the prompts themselves in MetaMask, which no server key may
   stand in for; that is the property being demonstrated.
2. **A bank-payout button in the *marketplace* UI.** Narrower than it was: the
   SDK demo page now has a wallet/bank toggle and has driven two orders to
   `COMPLETED` through it, so no UI reaching a bank is no longer the gap.
   `Marketplace.tsx` is — it still never passes `payoutTo: "bank"`, and
   `canPayoutToBank()` already says which listings clear the corridor minimum.
3. **A durable public endpoint.** Today's proof rode a Cloudflare quick tunnel,
   whose URL dies with the process, and the subscription dies with it. Anything
   beyond a one-off demo needs a stable host; note the trade-off in
   *Limitations* about exposing the demo's server actions.
4. **A scheduled reconciliation.** Two sweeps exist and both are run by hand.
   The gap with nothing behind it is the `cpn_payments` row of a standalone
   cash-out: if its webhook never arrives, nothing repairs it. The sweep can be
   written today; only its scheduler waits on item 3.

**Later — widen the reach once the above holds**

5. **CPN BRL/PIX and MXN/SPEI.** Both are implemented — corridor config,
   per-rail beneficiary and travel-rule fields, quotes — and settling them is a
   **deliberate non-goal of the build and testnet phase**, not an outstanding
   defect. They add breadth, not depth. Treat their absence from the proof table
   as intentional: this is the one place their status is tracked. The other
   twelve corridors in the [catalog](#cpn-corridors-on-arc) are in the same
   position — reachable, not targeted.
6. **Direct unit coverage for the network-facing modules** — listed in
   [What the tests do not guard](#what-the-tests-do-not-guard). Two real defects
   have already hidden there, so this is remediation, not tidiness.

**Gated on things outside the code**

7. **One real payment, into an account you control.** The only thing that
   converts the fiat leg from *reported* to *observed*. Use **EUR/SEPA**, not
   USD/WIRE: SEPA's minimum is ~11 USDC, while WIRE demands 36–61 USDC **plus**
   a flat ~25 USDC fee — so the first real proof costs about €10–12 rather than
   roughly $90. Match the credit using `refCode` in the statement memo, or
   `fiatNetworkPaymentRef` where the rail carries no memo. Gated on CPN
   production onboarding as an OFI, which is a licensing question, not a code
   one.
8. **Mainnet** — audit, key timelock/multisig, legal review, OFI onboarding.

## Structure

```text
rivokit/
├── src/
│   ├── sdk/            # RivoKit facade
│   ├── orchestrator/   # order state machine (new code)
│   ├── settlement-fx/  # quote-lock + stopLimit swap + rebate (new code)
│   ├── ramp/           # CPN off-ramp: client · encrypt · sign · state (new code)
│   ├── funding/        # App Kit unified balance / bridge
│   ├── escrow/         # Commerce Payments Protocol + gasless ERC-3009
│   ├── payout/         # PayoutRail seam · CPN rail · MOCK instruction
│   ├── events/         # webhooks + signature verification + compliance
│   ├── constants/      # verified Arc addresses & chain config
│   └── lib/            # RPC rotation, Circle DNS pinning
├── contracts/          # pinned CPP artifacts + provenance & verification recipe
├── infra/supabase/     # order-store migrations (shipped with the package)
├── scripts/            # setup · health checks · live proofs · API probes
├── demo/               # Next.js marketplace driving the SDK
└── README_v0.md        # the long-form original README
```

## License

Apache-2.0. Testnet-stage sample software for demonstration and education — not
a licensed financial product, not legal or financial advice. The embedding host
is fully responsible for the fiat leg, KYB/AML and compliance in its
jurisdiction.

<div align="center">Built for the <b>Build on Arc</b> hackathon — DeFi track.</div>
