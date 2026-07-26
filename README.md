<div align="center">

# RivoKit

### An embeddable cross-border settlement SDK on Arc — multi-chain USDC in, local-currency out.

Payers pay in USDC from any chain; the recipient receives **EURC on Arc** with a floor guarantee, and can cash out to **real local fiat** — EUR/SEPA, BRL/PIX, MXN/SPEI, USD/WIRE — through the Circle Payments Network. **Non-custodial**, with optional **conditional escrow**.

<br/>

![chain](https://img.shields.io/badge/chain-Arc%20Testnet%20(5042002)-blue) ![status](https://img.shields.io/badge/status-mvp-orange) ![hackathon](https://img.shields.io/badge/built%20for-Hackathon-red)   ![stack](https://img.shields.io/badge/stack-TypeScript%20%2B%20App%20Kit-3178c6) ![node](https://img.shields.io/badge/node-%3E%3D20-339933) ![license](https://img.shields.io/badge/license-Apache--2.0-green)

<br/>

[Overview](#overview) · [Problem](#the-problem-it-solves) · [Why](#why-rivokit) · [How it works](#how-it-works) · [Architecture](#architecture) · [Off-ramp](#fiat-off-ramp-cpn) · [Install](#installation) · [Integration](#integration-guide) · [API](#sdk-api-reference) · [Security](#security-model) · [Limitations](#limitations--honest-boundaries) · [Roadmap](#roadmap)

</div>

> ⚠️ **Testnet / sandbox only — unaudited, not for production.** Do not use real funds or mainnet private keys.
>
> The fiat leg is **no longer a mock**: USDC→EUR payouts settle through the Circle Payments Network on Arc Testnet, proven end-to-end. What each piece has and has not been shown to do is stated precisely in [Fiat off-ramp](#fiat-off-ramp-cpn) and [Limitations](#limitations--honest-boundaries) — read those before believing any claim here.

---

## Overview

RivoKit is a **money-orchestration layer** that other platforms (marketplaces, payout apps, invoicing systems) embed into their checkout/payout. It does one thing well: moving value from *"the payer pays USDC from any chain"* to *"the recipient is paid"* — with quoted FX, optional escrow, automatic refunds, gasless UX, and a fiat exit.

It covers two legs that are usually bought separately:

1. **Settlement on Arc** — multi-chain USDC → escrow → floored USDC→EURC swap, so the recipient is guaranteed **≥ €P** on-chain.
2. **Fiat off-ramp** — USDC on Arc → a beneficiary's bank account in EUR, BRL, MXN or USD, via the Circle Payments Network (CPN).

RivoKit is **not** a marketplace, wallet, custodian, or licensed financial institution. It orchestrates; the **licensed host** that embeds it remains the party of record. In production CPN requires the host to be an onboarded **OFI** (originating financial institution), and KYB/AML plus dispute arbitration stay with the host in every configuration.

RivoKit writes no primitives from scratch — it **composes** the Arc + Circle stack (App Kit for bridge/swap/unified balance, Commerce Payments Protocol for escrow, CPN for the fiat exit) behind a single clean API.

## The problem it solves

Cross-border stablecoin payments today are blocked by three frictions that all converge at the same point:

- **The payer's balance is scattered, and the recipient doesn't want crypto.** A crypto-native business holds USDC across many EVM chains, but a European vendor/contractor only wants local currency. Bridging that today means manual off-ramps, many steps, opaque FX rates, and slow settlement.
- **The recipient needs certainty, not volatility.** A recipient who doesn't understand crypto wants a **guaranteed local amount** (e.g. €P), on time, without exposure to hidden FX risk between the moment of payment and the moment of settlement.
- **Platforms have to assemble the infrastructure themselves.** To offer "pay in USDC, receive local", a platform must stitch together cross-chain bridging, escrow, FX, and payout from scattered protocols — expensive, cross-chain bug-prone, and far from its core competency.

RivoKit closes all three in one SDK: the payer pays from any chain, the recipient is guaranteed **≥ €P** in EURC on Arc and can cash out to their own bank account in local currency, and the platform just calls a few functions — without becoming a payment company.

## Why RivoKit

| | |
|---|---|
| 🌉 **Multi-chain by default** | Payers pay from a USDC balance on any chain (unified balance) — RivoKit routes it to Arc. |
| 🔒 **Non-custodial** | Funds are held by the escrow contract on Arc, **never** RivoKit's servers. |
| 🎯 **Recipient floor guarantee** | The FX swap uses `stopLimit = EUR price` → the recipient receives **at least €P or the swap reverts** (funds stay safe). |
| 🏦 **A real fiat exit** | One USDC balance on Arc reaches EUR/SEPA, BRL/PIX, MXN/SPEI and USD/WIRE bank accounts through CPN — not a printed "payout instruction". |
| 🔁 **Automatic refunds** | On failure/expiry → USDC is bridged back to the payer's origin chain. |
| ⚙️ **One SDK, not a protocol assembly** | App Kit + Commerce Payments Protocol + CPN combined behind a few calls. |
| ⛽ **Gasless-ready** | ERC-3009 `receiveWithAuthorization` + operator-relay; payers need not hold Arc gas. |

## How it works

```text
createOrder ─► funding (multi-chain USDC ─► Arc, App Kit)
            ─► escrow  (authorize)                    [Commerce Payments Protocol]
            ─► host release hook (milestone / SLA / confirmation)
            ─► capture ─► settlement-FX (swap USDC→EURC, stopLimit = €P)
            ─► rebate to buyer + payout instruction
            ─► (on failure) refund ─► bridge-back to origin chain

cash out    ─► quote (rate + fees locked, ~60s)       [Circle Payments Network]
            ─► prepare (payment + Permit2 intent — nothing moves yet)
            ─► submit  (sign + broadcast — irreversible)
            ─► CPN settles fiat to the beneficiary's bank
```

The two are **deliberately separate**. Settlement is per-order and synchronous with the buyer; cashing out is the recipient's own decision, made later, over an accumulated balance — so the off-ramp is driven independently rather than wired into `release()`.

Two **modes**, mapping directly onto Commerce Payments Protocol operations:

- **`escrow`** (default) — `Authorize → Capture`. Funds are held until the host's release hook triggers release.
- **`direct`** — `Charge` (atomic). For trusted payouts/invoices with no hold.

**Wedge-dependent timeout:** weak proof (physical goods) → `Reclaim`/refund, buyer-favouring; strong proof (B2B/digital) → `Capture`, seller-favouring.

## Architecture

RivoKit is a TypeScript orchestration layer. The only genuinely new code is **`orchestrator`** and **`settlement-fx`**; everything else is calls into App Kit / protocol contracts.

```text
┌──────────────┐   call SDK    ┌─────────────────────────────────────┐
│  Host App    │──────────────►│      RivoKit SDK (TypeScript)       │
│ (marketplace │               │  orchestrator (state machine)       │
│  / payout)   │◄──── events ──│  funding · escrow · settlement-fx   │
└──────────────┘               │  ramp · payout · events             │
                               └──────────────┬──────────────────────┘
                                              ▼
                        ┌─────────────────────────────────────────┐
                        │              Arc Testnet                 │
                        │  App Kit(Gateway/CCTP)  CPP escrow  Swap │
                        └──────────────────┬──────────────────────┘
                                           ▼
                        ┌─────────────────────────────────────────┐
                        │   CPN — fiat settlement to bank rails    │
                        │   SEPA · PIX · SPEI · WIRE               │
                        └─────────────────────────────────────────┘
```

| Module | Responsibility | Source |
|---|---|---|
| `orchestrator` | Order state machine, retries, cross-chain reconciliation | **New code** |
| `settlement-fx` | Quote-lock + floored swap + rebate calc | **New code** (App Kit Swap) |
| `ramp` | CPN off-ramp: quote, PII encryption, intent signing, payment lifecycle | **New code** (Circle Payments Network) |
| `funding` | Multi-chain USDC → Arc | App Kit Unified Balance / Bridge |
| `escrow` | authorize/capture/void/refund/reclaim | Commerce Payments Protocol |
| `payout` | Structured payout instruction (mock) + refund bridge-back | `arc-fintech` pattern |
| `events` | Webhooks, signature verification, compliance | Circle webhooks + SCP |

**On-chain vs off-chain:** escrowed funds, FX conversion, the off-ramp's Permit2 transfer, and release state live **on-chain** (Arc). Order metadata, UI status, notifications, and release-hook logic live **off-chain** (host). Bank settlement, KYB/AML and the OFI licence sit with **CPN and the licensed host**.

## Fiat off-ramp (CPN)

`src/ramp` turns an accumulated USDC balance on Arc into a bank payout. It is a **separate surface** from the order flow — the recipient decides when to cash out, over whatever has piled up.

### The three steps, and why they are split

| Step | Moves money? | What it does |
|---|---|---|
| `quote(amount)` | no | Locks rate + fees for the corridor. **Expires in ~30–60s** — the clock is real. |
| `prepare(params)` | no | Encrypts travel-rule + beneficiary PII to the quote's JWK, creates the payment, and returns the **Permit2 intent** to sign. |
| `submit(args, signer)` | **yes, irreversibly** | Signs the intent and broadcasts. Past `BROADCASTED` the sender's USDC is gone. |

The split is the whole point: **preparing is safe, broadcasting is a decision**. The `signer` is injected rather than held by the module — who signs is the host's environment, exactly like the SDK's `FundExecutor`. In the demo a testnet key stands in for the seller; in production the seller signs in their own wallet.

```ts
import { createCpnRamp } from "./src/ramp/cpn-ramp.ts";

const ramp = createCpnRamp({
  apiKey: process.env.CIRCLE_CPN_KEY!,
  corridor: {
    senderType: "BUSINESS", recipientType: "BUSINESS",
    senderCountry: "US", destinationCountry: "FR",
    blockchain: "ARC-TESTNET", paymentMethodType: "SEPA",
    sourceCurrency: "USDC", destinationCurrency: "EUR",
  },
});

const { quote, fees, spreadBps } = await ramp.quote({ sourceAmount: "15" });

const { payment, transaction } = await ramp.prepare({
  quote,
  travelRule: [ /* ORIGINATOR_NAME, BENEFICIARY_ADDRESS, … */ ],
  beneficiaryAccount: [{ name: "IBAN", value: "FR76…" }, { name: "RECIPIENT_LEGAL_NAME", value: "Acme SARL" }],
  senderAddress: seller, refundAddress: seller,
  useCase: "B2B", reasonForPayment: "PMT001", customerRefId: "ord-8842",
});

// Irreversible — gate this behind an explicit user confirmation.
await ramp.submit({ paymentId: payment.id, transaction }, sellerAccount);
```

### Corridors

Each rail demands different beneficiary and travel-rule fields. These were read live from `GET /v1/cpn/payments/requirements`, not guessed:

| Corridor | Method | Beneficiary fields | Min |
|---|---|---|---|
| 🇪🇺 EUR | SEPA | `IBAN`, `RECIPIENT_LEGAL_NAME` | 11 USDC |
| 🇧🇷 BRL | PIX | `RECIPIENT_ID_NUMBER`, `RECIPIENT_EVP` | 10 USDC |
| 🇲🇽 MXN | SPEI | `CLABE` (+ beneficiary national ID) | 11 USDC |
| 🌍 USD | WIRE | `BANK_NAME`, `SWIFT_CODE`, `BANK_COUNTRY`, `ACCOUNT_NUMBER`, `RECIPIENT_LEGAL_NAME` | 61 USDC |

Postal codes are validated per country, and the beneficiary must sit in the destination country — so the beneficiary address varies by corridor while the originator stays with the OFI.

### Prerequisites the flow will not do for you

- The sender must **approve Permit2** on Arc USDC before `submit`, or the broadcast fails.
- The quote expiry is short, and prepare-then-hesitate is the most common failure — it surfaces as `PAYMENT_EXPIRED` (`PM09000`). Every un-broadcast attempt during this project's CPN testing failed exactly that way.

### Webhooks

CPN drives payments asynchronously and reports via `cpn.payment.*`, `cpn.rfi.*`, `cpn.transaction.*`, `cpn.refund.*`. `verifyAndInterpretCpn` verifies the Circle signature **before** returning anything, and the reducers only ever move a payment forward — a duplicate or out-of-order webhook after a terminal state is ignored, not replayed.

```ts
import { verifyAndInterpretCpn, applyPaymentEvent } from "./src/ramp/cpn-state.ts";

const event = verifyAndInterpretCpn({ rawBody, signatureBase64, publicKey });  // throws on bad signature
if (event) {
  const outcome = applyPaymentEvent(currentState, event);
  if (outcome.changed) persist(outcome.state);   // else: no-op | duplicate | illegal
}
```

An open RFI (`rfiEffect`) blocks the payment; a rejection fails it.

## Prerequisites

- **Node.js 20+**
- A **Circle Console** account: `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` (register the entity secret once)
- An App Kit **`KIT_KEY`** (for FX swaps / Stablecoin Service)
- A **CPN key** (`CIRCLE_CPN_KEY`) for the fiat off-ramp — self-serve in Circle Console
- Testnet USDC/EURC from [faucet.circle.com](https://faucet.circle.com) (select Arc Testnet)
- *(Production)* OFI onboarding with CPN + KYB on recipients

## Installation

> **Not on the public npm registry, and deliberately so** — nothing here is audited and the payout leg is still `MOCK`, so the package stays `private` to make an accidental `npm publish` impossible. It is otherwise a normal installable package: it builds to `dist/` with type declarations and a single entry point.

Install it into your app straight from git (the `prepare` script builds it on install):

```bash
npm install github:0xsheyn/RivoKit          # or: npm install file:../RivoKit
```

Or work on it from source:

```bash
git clone https://github.com/0xsheyn/RivoKit.git && cd RivoKit
npm install          # runs `prepare` → builds dist/
npm run build:lib    # rebuild the SDK on its own
npm test             # 261 unit tests, no credentials needed
```

Everything supported is exported from the package root — deep imports into `src/` work but move without a version bump:

```ts
import { createRivoKit, createEscrow, createSettlementFx, createCpnRamp } from "rivokit";
```

Runtime dependencies of note: `@circle-fin/app-kit` + `@circle-fin/adapter-viem-v2` (bridge/swap/unified balance), `viem` (chain access and signing), `jose` (JWE encryption of CPN payment data). The order store expects Postgres/Supabase — the migrations under `infra/supabase/migrations/` ship with the package.

## Configuration

Copy `.env.example` to `.env.local` and fill it in — `.env.local` is gitignored and must never be committed. The variables that matter:

```bash
# Circle
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=            # 32-byte hex; register once
CIRCLE_BLOCKCHAIN=ARC-TESTNET

# App Kit (FX swap)
KIT_KEY=KIT_KEY:<keyId>:<keySecret>

# Fiat off-ramp — SERVER-ONLY, never import into a client component
CIRCLE_CPN_KEY=
CIRCLE_RAMP_KEY=                 # Circle Mint ("On/off ramp") — optional, see Limitations

# Arc
NEXT_PUBLIC_ARC_RPC_URL=https://rpc.testnet.arc.network

# Signing keys. Deployer and relayer MUST differ — the operator is a hot key that
# signs every payment and must not also hold deploy authority.
DEPLOYER_PRIVATE_KEY=
RELAYER_PRIVATE_KEY=
BUYER_PRIVATE_KEY=

# Written automatically by `npm run setup` — do not fill these by hand.
# The collectors are bound to the escrow by immutable, so all three must come
# from the same setup run.
NEXT_PUBLIC_RIVO_ESCROW_ADDRESS=
NEXT_PUBLIC_RIVO_TOKEN_COLLECTOR_ADDRESS=
NEXT_PUBLIC_RIVO_REFUND_COLLECTOR_ADDRESS=
OPERATOR_WALLET_ID=
OPERATOR_ADDRESS=
MERCHANT_ADDRESS=
```

Supabase holds the off-chain order state (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`) — see `.env.example` for the full list.

## Quickstart

```bash
cp .env.example .env.local     # fill in the credentials above
npm run setup                  # deploy escrow (SCP) + create operator/merchant wallets
npm test                       # 240 unit tests, no credentials needed
npm run dev                    # the marketplace demo on http://localhost:3000
```

### The demo

`demo/` is a Next.js marketplace that drives the real SDK against Arc Testnet — not a screenshot mock. One page, three panels, each with the authority that role actually has:

- **Buyer** — connects MetaMask, signs the ERC-3009 authorization in-browser, picks a payment rail.
- **Seller** — watches orders settle, then cashes out through the CPN off-ramp panel (corridor picker, live quote with fees and spread, prepare, then an explicitly-gated broadcast).
- **Host** — the release hook: the platform decides when funds are released.

### Minimal integration

```ts
import { createRivoKit } from "./src/sdk/rivokit.ts";

// RivoKit composes injected modules — it holds no keys and moves nothing itself.
const rivokit = createRivoKit({
  store, escrow, fx, bridge,   // your OrderStore + the proven domain modules
  fund,                        // FundExecutor: your environment signs & relays
  compliance,                  // optional: screens payer/receiver before storing
  config: {
    chainId: 5042002,
    escrowAddress, operator, token, refundCollector, settlementAddress,
    screeningChain: "ARC-TESTNET",
  },
});

// 1) Create an order — the FX quote is locked here, after compliance screening
const order = await rivokit.createOrder({
  payer, receiver,
  priceEURMinor: 18_500_000n,    // micro-EURC (€18.50) — GUARANTEED to the recipient
  receivingChain: "Ethereum_Sepolia",
  mode: "escrow",                // "escrow" | "direct"
  wedge: "digital_goods",
});

// 2) Fund the escrow — multi-chain USDC → Arc (async, event-driven).
//    Pass a signature when the buyer signed ERC-3009 in their own browser wallet.
await rivokit.fund(order.id, { signature });

// 3) Release from your business logic (milestone approved, access granted, etc.)
await rivokit.release(order.id, { kind: "access_granted", ref: "LIC-8842" });
```

## Integration guide

### What RivoKit does vs what you (the host) provide

| RivoKit (in the flow) | Host (out of the flow) |
|---|---|
| Multi-chain USDC funding → Arc | Catalog, identity, product UX |
| Non-custodial escrow + release/refund | **Release hook** (milestone/SLA/confirmation) |
| Floored USDC→EURC FX + rebate | **Beneficiary data** (IBAN/CLABE/PIX key) + travel-rule fields |
| CPN off-ramp: quote → prepare → submit | **KYB/AML**, merchant of record, dispute/arbitration |
| Status events + verified CPN webhooks | Being the licensed **OFI**/PSP (production) |

### 0. Wire the composition root

`createRivoKit` is a composition root, not a service: it holds no keys and opens no connections. Every dependency that needs a credential is injected, which is what keeps the SDK out of custody of both funds and secrets. A minimal server-side wiring:

```ts
import {
  createRivoKit, createEscrow, createSettlementFx, createBridge,
  createUnifiedBalance, createOrderStore, createComplianceGate, createCircleScreener,
  ARC_TESTNET_CHAIN_ID, USDC_ADDRESS, installCircleDnsPinning,
} from "rivokit";

installCircleDnsPinning();                        // never disable TLS verification instead

const kit = createRivoKit({
  store:  createOrderStore(SUPABASE_URL, SUPABASE_SECRET_KEY),
  escrow: createEscrow({ escrowAddress, publicClient, operator: sendViaYourOperatorWallet }),
  fx:     createSettlementFx({ kitKey, circleApiKey, circleEntitySecret }),
  bridge: createBridge(),
  fund:   async ({ paymentInfo, hash, signature }) => { /* your ERC-3009 relay → { authorizeTxHash } */ },
  payRebate,                                      // optional: returns the buffer surplus to the payer
  compliance: createComplianceGate(createCircleScreener(request, uuid)),
  operatorGas: () => publicClient.getBalance({ address: operator }),
  config: {
    chainId: ARC_TESTNET_CHAIN_ID, escrowAddress, operator, token: USDC_ADDRESS,
    refundCollector, settlementAddress,
    feeBps: 25, feeReceiver: operator,            // cost recovery for the gasless relay
    minOperatorGasWei: 5n * 10n ** 17n,           // refuse new orders below 0.5 USDC of gas
  },
});
```

Two of those are worth stating plainly, because they are the running cost of "gasless":

- **`feeBps` / `feeReceiver`** — the operator pays Arc gas (which *is* USDC) for authorize, capture, void and refund. The fee is withheld by the escrow at capture and **grossed onto what the payer authorizes**, never subtracted from the receiver's floor; taking it out of the captured amount would shrink the swap input below `priceEUR` and the floored swap would revert. Default `0` = you subsidise every order.
- **`operatorGas` + `minOperatorGasWei`** — without this, an operator that runs out of gas fails *after* the payer has signed, leaving the order in `funding_pending` with nothing on-chain to explain it. With it, `createOrder` throws `OperatorGasLowError` before anything is quoted or stored.

`demo/lib/rivokit.server.ts` is the reference composition; `scripts/live-sdk.mjs` runs the same one against Arc Testnet.

### 1. Lock the payment amount (inside `createOrder`)

`createOrder` inverts a settlement quote to lock the USDC amount the buyer must pay, using the checkout-time rate plus a buffer. To read a rate without creating an order:

```ts
const est = await rivokit.estimateSwap({
  address: payer,
  amountInMinor: 1_000_000n,           // 1 USDC to read the rate
});
// est.amountOutMinor / est.stopLimitMinor / est.fees — all strings at the boundary
// usdcAmount = priceEUR / rate × (1 + bufferBps)
```

The buyer is locked to `order.usdcAmount`; the seller's settlement rate floats within a window and is guaranteed by `stopLimit` (see step 3).

### 2. Fund the escrow (multi-chain → Arc)

```ts
await rivokit.fund(order.id);                 // host-held key signs the ERC-3009 authorization
await rivokit.fund(order.id, { signature });  // …or relay one the buyer signed in their browser wallet
// primary:  kit.unifiedBalance.spend({ to:{ chain:"Arc_Testnet", recipientAddress: payer }})
// fallback: kit.bridge / kit.estimateBridge
// then:     escrow.authorize(PaymentInfo)  ← gasless: payer signs ERC-3009, operator relays
```

> Funding mints/bridges USDC to the **payer** on Arc, then `authorize` pulls it into escrow via a gasless ERC-3009 signature — minting straight to the escrow would move tokens with no payment recorded against them.
>
> Cross-chain funding is **async** — a Gateway deposit waits on source-chain finality, and CCTP attestation can take several minutes. The order passes through `funding_pending` before `funded`. Design your UI to await the event, not block.

### 3. Inject the release hook

RivoKit does **not** verify the physical world — you decide when funds are released:

```ts
await rivokit.release(order.id, { kind: "milestone",      ref: "M-42" });   // B2B
await rivokit.release(order.id, { kind: "access_granted", ref: "LIC-1" });  // digital
await rivokit.release(order.id, { kind: "delivery",       ref: "TRK-9" });  // physical (trusted input)
```

On release, RivoKit runs `capture`, then swaps USDC→EURC with `stopLimit = priceEUR` — the recipient receives **≥ €P or the swap reverts** (funds safe in escrow). Any positive surplus is rebated to the buyer.

### 4. Refund

```ts
await rivokit.refund(order.id);   // escrow.void/refund → bridge USDC back to receivingChain
```

### 5. Webhooks & status

```ts
rivokit.on("funded",   ({ orderId })                               => notifyReceiver(orderId));
rivokit.on("released", ({ orderId, eurcOutMinor, rebateMinor })    => updateUI(orderId, eurcOutMinor));
rivokit.on("refunded", ({ orderId, chain })                        => updateUI(orderId));

const order = await rivokit.status(order.id);
const payout = rivokit.payoutFor(order.id);   // the MOCK instruction emitted on release
```

Register the Circle webhook endpoints (`transactions.*`, `gateway.deposit.finalized`, `cpn.*`) and **verify their signatures**.

### 6. Cash out to fiat

The SDK's own `payout` module still emits a **`MOCK`** instruction on release — it is labelled as such and is not a bank transfer. The real fiat exit is the [CPN off-ramp](#fiat-off-ramp-cpn), driven separately over the recipient's accumulated balance.

## SDK API reference

### Settlement — `createRivoKit(deps)`

| Method | Returns | Description |
|---|---|---|
| `createRivoKit(deps)` | `RivoKit` | Compose the SDK from injected modules (see `RivoKitDeps` below) |
| `createOrder(params)` | `Promise<Order>` | Screen payer/receiver, lock the FX quote, store the order |
| `fund(orderId, opts?)` | `Promise<void>` | Multi-chain USDC → Arc → `escrow.authorize`. `opts.signature` relays a browser-signed ERC-3009 |
| `release(orderId, proof)` | `Promise<void>` | `capture` → floored swap → payout instruction |
| `refund(orderId)` | `Promise<void>` | `void`/`refund` + bridge-back to `receivingChain` |
| `status(orderId)` | `Promise<Order>` | Current order |
| `payoutFor(orderId)` | `PayoutInstruction \| undefined` | The MOCK instruction emitted on release |
| `on/off(event, handler)` | `void` | Subscribe / unsubscribe to status events |
| `estimateSwap(params)` | `Promise<SwapEstimate>` | FX quote without executing |

Money crosses the SDK boundary as **`bigint` minor units** going in and **strings** coming out (the `Order` wire type) — never a float, in either direction.

```ts
type RivoKitDeps = {
  store: OrderStore; escrow: Escrow; fx: SettlementFx; bridge: Bridge;
  fund: FundExecutor;              // injected: the host's environment signs & relays
  config: RivoKitConfig;
  compliance?: ComplianceGate;     // screens BEFORE an order is stored
  emitter?: Emitter;
};

type CreateOrderParams = {
  payer: Address; receiver: Address;
  priceEURMinor: bigint;               // micro-EURC — guaranteed ≥ this to the recipient
  receivingChain: string;              // refund destination
  wedge: "contractor_payout" | "digital_goods" | "invoice" | "physical_demo";
  mode?: "escrow" | "direct";          // default "escrow"
  bufferBps?: number;                  // default 150 (1.5%) — FX cushion + rebate source
};

type OrderState =
  | "created" | "funding_pending" | "funded"
  | "settlement_pending" | "shipped" | "released"
  | "refund_pending" | "refunded" | "failed";
```

The timeout policy is **not** a parameter — it is derived from the `wedge`, because the strength of the available proof is what should decide who an expiry favours: strong proof (B2B, digital) → `auto_capture`; weak proof (physical) → `reclaim`.

### Events

| Event | Payload |
|---|---|
| `funding_pending` / `funded` | `{ orderId }` |
| `released` | `{ orderId, eurcOutMinor, rebateMinor }` |
| `refund_pending` / `refunded` | `{ orderId, chain }` |

### Off-ramp — `createCpnRamp(params)`

| Method | Returns | Description |
|---|---|---|
| `quote(amount)` | `Promise<RampQuote>` | Lock rate + fees. Fix exactly one side: `sourceAmount` or `destinationAmount` |
| `prepare(params)` | `Promise<{ payment, transaction }>` | Encrypt PII, create payment + Permit2 intent. **Moves nothing** |
| `submit(args, signer)` | `Promise<CpnTransaction>` | Sign + broadcast. **Irreversible** |
| `status(paymentId)` | `Promise<CpnPayment>` | Poll the async lifecycle |

| Helper | Description |
|---|---|
| `verifyAndInterpretCpn(params)` | Verify the Circle signature, then normalize the webhook. Throws on a bad signature |
| `applyPaymentEvent(state, event)` | Forward-only reducer; reports `no-op \| duplicate \| illegal` instead of regressing |
| `rfiEffect(event)` | Whether an RFI blocks or fails the payment |
| `isPointOfNoReturn(txState)` | `BROADCASTED` or later — funds have irreversibly left |

### Invariants enforced by the SDK

1. The recipient receives **≥ `priceEURMinor`** or the swap reverts (funds safe).
2. Refunds always go to the recorded `receivingChain`.
3. `rebate = max(0, actualOutput − priceEURMinor)`.
4. ERC-3009 nonce is single-use (anti-replay).
5. Money is always **integer minor units** — never a float.
6. Illegal state sequences are unrepresentable: the machine refuses a `capture` on an unfunded order before it can reach the escrow and revert.
7. A CPN payment only ever moves forward; a duplicate or late webhook after a terminal state is ignored, not replayed.

## Chains, tokens & constants

> Testnet addresses may change — verify at `docs.arc.io/arc/references/contract-addresses`.

| Item | Value |
|---|---|
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |
| USDC | `0x3600000000000000000000000000000000000000` (6 decimals, native gas) |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` (6 decimals) |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` (same on all chains) |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` (CPN pulls the off-ramp amount through this) |

Note that Arc's USDC is the **native gas token**, with 18 decimals as gas and 6 as an ERC-20 — a distinction that has to be respected in both directions.

## Testing

Three layers, because Arc cannot be faithfully forked:

- **Unit tests** — `npm test`, **240 green across 16 files**, no credentials required. Cover the pure logic: the order state machine, unit conversions, quote/rebate math, the SDK facade's composition, event routing, compliance gating, webhook ECDSA verification, the gasless ERC-3009 authorization (signed and recovered against a real key), and the CPN layer (client, JWE encryption, EIP-712 witness signing, and the forward-only payment reducer).
- **Live proofs** (`scripts/live-*.mjs`) exercise every contract-touching path against **Arc Testnet itself** — fund → capture → floored swap → payout, refund with bridge-back, multi-chain funding via bridge and unified balance, and the full flow end-to-end through the SDK.
- **API probes** (`scripts/probe-*.mjs`) map real service behaviour rather than assuming it: CPN quote/payment/status shapes, the per-corridor requirements, and the sandbox magic values (`ORIGINATOR_NAME: "Failed"` / `"AsyncSuccess"`) used to confirm the state model in `cpn-state.ts` matches the statuses CPN actually emits.

Foundry **fork** tests are deliberately not the source of truth here: Arc's USDC-as-gas and its blocklist/compliance precompiles do not exist on a local EVM, so a fork test of those paths passes without testing anything. The live scripts run against the real chain instead — slower, but they actually prove the behaviour.

### What is proven live

| Path | Status |
|---|---|
| Escrow lifecycle — authorize / capture / void / refund / reclaim | ✅ proven on Arc Testnet |
| Floored USDC→EURC swap (`stopLimit`) | ✅ proven |
| Multi-chain funding — CCTP bridge + Gateway unified balance | ✅ proven |
| Refund with bridge-back to origin chain | ✅ proven |
| Full flow end-to-end through the SDK facade | ✅ proven |
| **CPN off-ramp EUR/SEPA — quote → prepare → broadcast → `COMPLETED`** | ✅ **proven**, twice (15 USDC → 12.92 EUR, on-chain tx `COMPLETED`) |
| CPN corridors BRL/PIX, MXN/SPEI, USD/WIRE | ⚠️ requirements + quote + prepare verified live; **no completed settlement** |
| Circle Mint redeem (`CIRCLE_RAMP_KEY`) | ❌ wired, **never executed** — see Limitations |

## Security model

- **Non-custodial** — funds are held by the escrow contract (Commerce Payments Protocol); the operator only submits txs & earns a fee, and **cannot redirect funds**.
- **Floor guarantee** — `stopLimit` ensures the recipient gets ≥ €P or a safe revert.
- **Anti-replay** — single-use ERC-3009 authorization nonces; unique idempotency keys off-chain.
- **Injected signing** — no module holds a key. Both money-moving steps (`FundExecutor`, `ramp.submit`) take the signer from the host, so broadcasting is always an explicit decision, never a side effect.
- **PII never travels in the clear** — travel-rule and beneficiary data are JWE-encrypted to the quote's certificate key before leaving the process.
- **Unverified webhooks reach nothing** — `verifyAndInterpretCpn` checks the Circle signature before any reducer sees a body, and the reducers refuse to regress out of a terminal state.
- **Server-side policy** — validation & screening (Circle Compliance Engine) on the server, not the client. `CIRCLE_CPN_KEY` is server-only and must never be imported into a client component.
- **Secrets** — credentials via environment variables; **never** committed.

Report vulnerabilities privately, not via public issues.

## Limitations & honest boundaries

- **Testnet / sandbox only**, unaudited — do not use real funds.
- **The off-ramp is real, but its reach is uneven.** EUR/SEPA is proven to `COMPLETED`. BRL, MXN and USD are verified only as far as `prepare` — their requirements and quotes are live, but no payment has settled on those rails.
- **Circle Mint redeem has never been run.** `demo/lib/mint.server.ts` and the MintRedeem panel are wired against the sandbox API but have not been executed once, so treat that path as unproven code, not a feature.
- **The off-ramp is not wired into `release()`.** Settlement and cash-out are separate surfaces; joining them (a payment record that tracks its own CPN payout) is not done.
- **The SDK's `payout` module is still a `MOCK`** instruction, clearly labelled as such. It is not a bank transfer.
- **In production the host must be an onboarded OFI** with CPN, plus KYB/AML on recipients. RivoKit is not a licensed operator and cannot be one for you.
- **CPN quotes expire in ~30–60 seconds.** Any UI that lets a user pause between prepare and broadcast will produce `PAYMENT_EXPIRED` failures.
- Depends on Circle: USDC/EURC can be frozen by the issuer; CCTP attestation is centralized; the public Arc RPC rate-limits aggressively, and Arc Testnet may experience downtime.

## Project structure

```text
rivokit/
├── src/
│   ├── sdk/              # RivoKit facade — the one object the flow runs through
│   ├── orchestrator/     # order state machine + reconciliation (new code)
│   ├── settlement-fx/    # quote-lock + stopLimit swap + rebate (new code)
│   ├── ramp/             # CPN off-ramp: client · encrypt · sign · state (new code)
│   ├── funding/          # App Kit unified balance / bridge
│   ├── escrow/           # Commerce Payments Protocol + gasless ERC-3009
│   ├── payout/           # payout instruction (MOCK) + refund bridge-back
│   ├── events/           # webhooks + signature verification + compliance
│   ├── constants/        # verified Arc addresses & chain config
│   └── lib/              # RPC rotation, Circle DNS pinning
├── scripts/              # live proofs (live-*.mjs) + API probes (probe-*.mjs)
├── demo/                 # Next.js marketplace driving the SDK + off-ramp panels
└── README.md
```

## Roadmap

**Done, proven live on Arc:** setup → escrow lifecycle → settlement-FX → multi-chain funding + refund → events/compliance → SDK surface → browser-signed funding + marketplace demo → **CPN fiat off-ramp (EUR/SEPA settled end-to-end)**.

**Next:**

- Settle the remaining corridors (BRL/PIX, MXN/SPEI, USD/WIRE) past `prepare`.
- Wire the off-ramp into the order record, so a payment tracks its own CPN payout and webhook-driven state.
- Exercise or drop the Circle Mint redeem path — unproven code should not ship as a feature.
- Hardening: retries and reconciliation across the CPN lifecycle.

Mainnet stays out of scope — gated on audit + key timelock/multisig + legal review + OFI onboarding.

## Contributing

Contributions follow phase discipline (read the internal build guide before writing code). Ordinary bugs → issues; security vulnerabilities → report privately. Non-negotiable rules: non-custodial, money as integer minor units, swaps must carry a `stopLimit`, mocks must be labeled, and no credentials/internal docs committed.

## License & disclaimer

Apache-2.0 (following the referenced Circle samples).

RivoKit is testnet-stage sample software for demonstration and educational purposes. It is **not** a licensed financial product and **not** legal/financial advice. The embedding host is fully responsible for the fiat leg, KYB/AML, and compliance in its jurisdiction.

---

<div align="center">
Built for the <b>Build on Arc</b> hackathon — DeFi track.
</div>
