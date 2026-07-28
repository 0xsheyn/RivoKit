<div align="center">

# RivoKit

### An embeddable cross-border settlement SDK on Arc — multi-chain USDC in, local-currency out.

![chain](https://img.shields.io/badge/chain-Arc%20Testnet%20(5042002)-blue) ![contracts](https://img.shields.io/badge/contracts-verified%20on%20Arc-success) ![tests](https://img.shields.io/badge/tests-280%20passing-brightgreen) ![status](https://img.shields.io/badge/status-mvp%20%C2%B7%20testnet-orange) ![stack](https://img.shields.io/badge/stack-TypeScript%20%2B%20App%20Kit-3178c6) ![node](https://img.shields.io/badge/node-%3E%3D20-339933) ![license](https://img.shields.io/badge/license-Apache--2.0-green)

[Overview](#overview) · [Problem](#the-problem-it-solves) · [Why](#why-rivokit) · [How it works](#how-it-works) · [Architecture](#architecture) · [Quickstart](#quickstart) · [Contracts](#deployed-contracts-arc-testnet) · [API](#api) · [Security](#security-model) · [Limitations](#limitations--honest-boundaries)

</div>

> ⚠️ **Testnet only, unaudited.** Do not use real funds or mainnet keys.
> The SDK's own `payout` module is still a labelled `MOCK`; the real fiat exit
> is `createCpnRamp`. What is proven and what is not is stated exactly in
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
- **CPN EUR/SEPA settled end-to-end to `COMPLETED`**, twice: 15 USDC → 12.92 EUR
  into a real sandbox bank rail. The fiat leg is no longer a mock.
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
- **Webhooks that are verified, not trusted.** Live `X-Circle-Signature`
  verification against Circle's per-product key endpoint, a body edited by one
  digit refused, and the verified events folded into a stored cash-out —
  duplicates and out-of-order arrivals writing nothing.
- **280 unit tests** across 19 files, runnable with no credentials at all.

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
| 🏦 **A real fiat exit** | One USDC balance on Arc reaches SEPA / PIX / SPEI / WIRE — proven to `COMPLETED` on EUR, not a printed instruction. |
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
           ─► release        capture ─► swap USDC→EURC, stopLimit = €P ─► rebate
           ─► refund         void/refund ─► bridge back to receivingChain

off-ramp   ─► quote     rate + fees locked, ~30–60s
           ─► prepare   encrypt PII, create payment + Permit2 intent — moves nothing
           ─► submit    sign + broadcast — IRREVERSIBLE past BROADCASTED
           ─► CPN settles fiat to the beneficiary's bank
```

The two halves are **deliberately separate**. Settlement is per-order and
synchronous with the buyer; cashing out is the recipient's own decision, made
later, over an accumulated balance — so the off-ramp is driven independently
rather than wired into `release()`.

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
| `payout` | Payout instruction (**MOCK**) + refund bridge-back | `arc-fintech` pattern |
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
npm test                         # 280 tests / 19 files, no credentials needed

node scripts/preflight.mjs       # read-only: checks prerequisites, spends nothing
npm run setup                    # deploy escrow + collectors, create wallets (idempotent)
node scripts/check-cpp.mjs       # 8 wiring assertions on what was just deployed

npm run dev                      # marketplace demo → http://localhost:3000
```

| Command | Does |
|---|---|
| `npm test` | vitest, 280 green / 19 files, no credentials |
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

**Settlement — `createRivoKit(deps)`**, deps: `{store, escrow, fx, bridge, fund, config, compliance?, emitter?, payRebate?, operatorGas?, refundBridgeParams?}`

| Method | Description |
|---|---|
| `createOrder({payer, receiver, priceEURMinor, receivingChain, wedge, mode?, bufferBps?})` | screen → lock quote → store |
| `fund(orderId, opts?)` | multi-chain USDC → Arc → `authorize`. `opts.signature` relays a browser-signed ERC-3009 |
| `release(orderId, proof)` | `capture` → floored swap → payout instruction (MOCK) |
| `refund(orderId)` | `void`/`refund` + bridge-back to `receivingChain` |
| `status(orderId)` · `payoutFor(orderId)` | current order · the MOCK instruction (both async; the instruction is persisted, so it survives a restart) |
| `estimateSwap({address, amountInMinor})` | FX quote without executing |
| `on/off(event, handler)` | `funding_pending` · `funded` · `released` · `refund_pending` · `refunded` |

`released` carries `{orderId, eurcOutMinor, rebateMinor}`. `OrderState`:
`created · funding_pending · funded · settlement_pending · shipped · released ·
refund_pending · refunded · failed`.

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
| **Live proofs** | `live-phase1/1b/2/2-chain` · `live-funding` · `live-bridge` · `live-unified` · `live-refund` · `live-recovery` (capture ok, swap misses floor, retry wins) · `live-charge` (direct mode) · `live-compliance` · `live-sdk` (full flow through the facade) · `live-scenario` · `live-ramp*` · `live-mint-arc-deposit` (seller EURC on Arc → Mint balance; sends only behind `CONFIRM=DEPOSIT`) · `live-cpn-subscribe` (lists subscriptions; `--check <url>` tests the `HEAD` Circle validates with; creates only behind `CONFIRM=SUBSCRIBE`) |
| **API probes** | `probe-cpn*` (quote, payment, status, magic values) · `probe-swap` · `probe-mint` (USD → wire) · `probe-mint-sepa` (links an IBAN account; redeems only behind `CONFIRM=REDEEM`) · `probe-mint-deposit` |
| **Demo utils** | `demo-topup` (fund the buyer on Sepolia + Gateway) · `reset-demo` (wipe orders) |

## Testing

- **Unit** — `npm test`, 280 green / 19 files, no credentials. State machine,
  unit conversions, quote/rebate math, fee gross-up round-trip
  (`netOfFee(grossUpForFee(x)) ≥ x`), facade composition, compliance gating,
  webhook ECDSA verification, ERC-3009 sign+recover, the whole CPN layer.
- **Live proofs** — `scripts/live-*.mjs` against Arc Testnet itself.
- **API probes** — `scripts/probe-*.mjs` map real service behaviour instead of
  assuming it (CPN response shapes, per-corridor requirements, sandbox magic
  values).

Foundry **fork tests prove nothing here**: Arc's USDC-as-gas and its
compliance precompiles do not exist on a local EVM, so a fork test of those
paths passes without testing anything.

### Proven live vs not

| Path | Status |
|---|---|
| Escrow lifecycle · floored swap · multi-chain funding · refund bridge-back · full flow via the facade | ✅ proven on Arc |
| Operator fee 25 bps split at capture, floor intact | ✅ `0x7910f1…037420` |
| Two-wallet mode — floor forwarded merchant → seller wallet | ✅ `0x11bf41…559bf4` |
| CPN EUR/SEPA end-to-end → `COMPLETED` | ✅ twice (15 USDC → 12.92 EUR) |
| Seller-signed cash-out — the seller's own wallet signs the CPN intent | ✅ proven — MetaMask signed, 15 USDC → 12.94 EUR `COMPLETED`, tx [`0x51e968…f049e7f`](https://testnet.arcscan.app/tx/0x51e9681d1d23fedeb239110a2c58309912a5c82d35a20c316b3102731f049e7f) |
| Wallet-side Permit2 **approve** branch, from a zero allowance | ✅ wallet `0xd7d7B4…` approved 15 USDC in tx [`0xdeebf4…cf11177a`](https://testnet.arcscan.app/tx/0xdeebf45ad5e1747693e33e2de0dabca14ccef1323d27d29aaaf598f7cf11177a), spent it on a 15 USDC → 12.95 EUR cash-out, allowance back to 0 |
| Circle Mint redeem — USD → wire bank | ✅ `complete` — 10.00 USD, balance 350.00 → 340.00, payout `3f708440…`, trackingRef `CIR2V7GVUJ` |
| Circle Mint redeem — EUR → SEPA bank | ✅ `complete` twice — 10.00 EUR each, balance 273.49 → 253.49, payouts `9d98c66f…` + `47a86ec3…` |
| Seller EURC on Arc → Mint EUR balance, **no bridge** | ✅ 1 EURC, balance 253.49 → 254.49, tx [`0x405164…52a8449e`](https://testnet.arcscan.app/tx/0x40516460af2571449291fa4448533793818dd287f9aeade449b1a13752a8449e) |
| CPN webhook → verified → folded into the stored cash-out | ✅ live signatures verified, tampered body refused, `cpn_payments` row for `acd9d389…` advanced `CRYPTO_FUNDS_PENDING → FIAT_PAYMENT_INITIATED → COMPLETED` |
| That webhook arriving over HTTP at our own route | ⚠️ every layer above the transport is proven; the endpoint still needs to be publicly reachable |
| CPN BRL / MXN / USD | ⚠️ requirements + quote + prepare only, **no settlement** |
| Browser-wallet funding rails (`demo/app/wallet-rails.ts`) | ❌ written, never executed on-chain |

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

## Limitations & honest boundaries

- **Testnet / sandbox only**, unaudited — do not use real funds.
- **The off-ramp is real, but its reach is uneven.** EUR/SEPA is proven to
  `COMPLETED`. BRL, MXN and USD are verified only as far as `prepare` — their
  requirements and quotes are live, but no payment has settled on those rails.
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
  deliberately unwired is the trigger — `release()` does not start a redeem,
  because a seller cashes out an accumulated balance rather than one order.
- **The browser-wallet funding rails have never been executed on-chain.**
  `demo/app/wallet-rails.ts` lets a connected wallet reach Arc via Gateway spend
  or a CCTP bridge with no server secret involved — which is the point — but
  only the server-signed demo buyer has actually moved funds.
- **The seller-signed cash-out is proven, including the approval branch.** A
  connected MetaMask signs the CPN intent itself and the server only broadcasts
  it (`ramp.submitSigned`); no key for that address exists server-side. The
  wallet-side Permit2 approval — previously skipped because the test wallet
  already held an unlimited allowance — has now run from zero: `0xd7d7B4…`
  approved exactly 15 USDC, spent it on a 15 USDC → 12.95 EUR cash-out that
  reached `COMPLETED`, and its allowance returned to 0. The stored row carries
  `signed_by: "wallet"`.
- **Webhooks are real; the last hop is not proven.** A subscription registered
  from the CPN Console delivered five signed events for one cash-out —
  `cryptoFundsPending`, `transaction.broadcasted`, `transaction.completed`,
  `fiatPaymentInitiated`, `completed` — and replaying those exact bodies through
  `interpretCpnEvent` + `applyPaymentEvent` walks the payment
  `CREATED → CRYPTO_FUNDS_PENDING → FIAT_PAYMENT_INITIATED → COMPLETED`, with
  the two transaction events correctly no-oping against the payment machine. So
  the envelope shape and the reducer are verified against real Circle traffic
  rather than fixtures. All five signatures verify against the live
  `X-Circle-Signature`, and a body edited by one digit is refused — so the
  security-critical half is proven too. Finding that required fixing a defect
  real traffic exposed and tests could not: the public key endpoint differs per
  product, and the route was asking the Wallets path
  (`/v2/notifications/publicKey/{id}`) for CPN keys, which answers `404`. Every
  CPN webhook would have been refused `401 unverifiable` by an endpoint that
  otherwise looked correct. Feeding those verified events into
  `applyCpnEventToStore` then advanced the real `cpn_payments` row for
  `acd9d389…` from `CRYPTO_FUNDS_PENDING` to `COMPLETED`, ignoring a duplicate
  and no-oping both transaction events on the way. So only the transport itself
  is unproven now — a Cloudflare quick tunnel could not reach the origin on this
  machine. Note the Console path sidesteps the API:
  `CIRCLE_CPN_KEY` still returns `403` on
  `/v2/cpn/notifications/subscriptions` while succeeding on `/v1/cpn/payments`,
  so `scripts/live-cpn-subscribe.mjs` needs the notifications capability added
  to the key before it can manage subscriptions itself.
- **The off-ramp is still not triggered by `release()`, on purpose.** A seller
  cashes out an accumulated balance, not one order — so `cpn_payments.order_id`
  is a nullable link, not a foreign key the flow depends on.
- **The SDK's `payout` module is still a `MOCK`** instruction, labelled as such.
  It is not a bank transfer.
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

1. **Browser-wallet funding rails on-chain.** `demo/app/wallet-rails.ts` is the
   non-custodial claim in code form, and it has never been executed. Needs a
   human at a connected wallet: by design no server key can stand in, which is
   exactly the property being demonstrated.
2. **A CPN webhook delivered over HTTP into our own route.** Verification,
   interpretation and the `cpn_payments` write are all proven against real
   Circle traffic (see *Limitations*); only the transport has never run, and
   that needs the endpoint publicly reachable.
3. **Automatic reconciliation from webhooks.** The pieces are proven
   individually; what no one has watched yet is a stale row correcting itself
   without a human replaying the event.

**Later — widen the reach once the above holds**

4. **CPN corridors beyond EUR.** BRL/PIX, MXN/SPEI and USD/WIRE are live as far
   as `prepare`; each needs a funded settlement to prove. Deliberately *not* a
   focus: they add breadth, not depth, and every one of them costs real
   settlement to demonstrate. Revisit once the rails above are proven.
5. **Direct unit coverage for the network-facing modules** — `escrow/operations`,
   `settlement-fx/swap`, `orchestrator/order-store`, `funding/unified-balance`.
   The facade tests mock these, so today only the live scripts exercise them.

**Gated on things outside the code**

6. **Mainnet** — audit, key timelock/multisig, legal review, OFI onboarding.

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
│   ├── payout/         # payout instruction (MOCK) + refund bridge-back
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
