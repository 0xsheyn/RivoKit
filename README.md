<div align="center">

# RivoKit

### An embeddable cross-border settlement SDK on Arc — multi-chain USDC in, local-currency out.

Payers pay in USDC from any chain; a recipient in Europe receives **EURC** (and an EUR payout instruction) on Arc — **non-custodial**, with optional **conditional escrow** and a **floor guarantee** for the recipient.

<br/>

![status](https://img.shields.io/badge/status-testnet-orange) ![chain](https://img.shields.io/badge/chain-Arc%20Testnet%20(5042002)-blue) ![stack](https://img.shields.io/badge/stack-TypeScript%20%2B%20App%20Kit-3178c6) ![license](https://img.shields.io/badge/license-Apache--2.0-green)

**[Bahasa Indonesia](./README.id.md)**

<br/>

[Overview](#overview) · [Problem](#the-problem-it-solves) · [Why](#why-rivokit) · [How it works](#how-it-works) · [Architecture](#architecture) · [Install](#installation) · [Integration](#integration-guide) · [API](#sdk-api-reference) · [Security](#security-model) · [Limitations](#limitations--honest-boundaries) · [Roadmap](#roadmap)

</div>

> ⚠️ **Testnet only — unaudited, not for production.** The fiat leg (EURC→EUR) is simulated. Do not use real funds or mainnet private keys.

---

## Overview

RivoKit is a **money-orchestration layer** that other platforms (marketplaces, payout apps, invoicing systems) embed into their checkout/payout. It does one thing well: moving value from *"the payer pays USDC from any chain"* to *"the recipient receives EURC / a payout instruction on Arc"* — with quoted FX, optional escrow, automatic refunds, and gasless UX.

RivoKit is **not** a marketplace, wallet, custodian, or licensed payment institution. It stops at the on-chain boundary (EURC + payout instruction); the fiat leg, KYB/AML, and dispute arbitration are handed to the **licensed host** that embeds it.

RivoKit writes no primitives from scratch — it **composes** the Arc + Circle stack (App Kit for bridge/swap/unified balance, Commerce Payments Protocol for escrow) behind a single clean API.

## The problem it solves

Cross-border stablecoin payments today are blocked by three frictions that all converge at the same point:

- **The payer's balance is scattered, and the recipient doesn't want crypto.** A crypto-native business holds USDC across many EVM chains, but a European vendor/contractor only wants local currency. Bridging that today means manual off-ramps, many steps, opaque FX rates, and slow settlement.
- **The recipient needs certainty, not volatility.** A recipient who doesn't understand crypto wants a **guaranteed local amount** (e.g. €P), on time, without exposure to hidden FX risk between the moment of payment and the moment of settlement.
- **Platforms have to assemble the infrastructure themselves.** To offer "pay in USDC, receive local", a platform must stitch together cross-chain bridging, escrow, FX, and payout from scattered protocols — expensive, cross-chain bug-prone, and far from its core competency.

RivoKit closes all three in one SDK: the payer pays from any chain, the recipient is guaranteed to receive **≥ €P** in EURC on Arc, and the platform just calls a few functions — without becoming a payment company.

## Why RivoKit

| | |
|---|---|
| 🌉 **Multi-chain by default** | Payers pay from a USDC balance on any chain (unified balance) — RivoKit routes it to Arc. |
| 🔒 **Non-custodial** | Funds are held by the escrow contract on Arc, **never** RivoKit's servers. |
| 🎯 **Recipient floor guarantee** | The FX swap uses `stopLimit = EUR price` → the recipient receives **at least €P or the swap reverts** (funds stay safe). |
| 🔁 **Automatic refunds** | On failure/expiry → USDC is bridged back to the payer's origin chain. |
| ⚙️ **One SDK, not a protocol assembly** | App Kit + Commerce Payments Protocol combined behind a few calls. |
| ⛽ **Gasless-ready** | ERC-3009 `receiveWithAuthorization` + operator-relay; payers need not hold Arc gas. |

## How it works

```text
createOrder ─► funding (multi-chain USDC ─► Arc, App Kit)
            ─► escrow  (authorize)                    [Commerce Payments Protocol]
            ─► host release hook (milestone / SLA / confirmation)
            ─► capture ─► settlement-FX (swap USDC→EURC, stopLimit = €P)
            ─► rebate to buyer + payout instruction (mock on testnet)
            ─► (on failure) refund ─► bridge-back to origin chain
```

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
└──────────────┘               │  payout · events                    │
                               └──────────────┬──────────────────────┘
                                              ▼
                        ┌─────────────────────────────────────────┐
                        │              Arc Testnet                 │
                        │  App Kit(Gateway/CCTP)  CPP escrow  Swap │
                        └─────────────────────────────────────────┘
```

| Module | Responsibility | Source |
|---|---|---|
| `orchestrator` | Order state machine, retries, cross-chain reconciliation | **New code** |
| `settlement-fx` | Quote-lock + floored swap + rebate calc | **New code** (App Kit Swap) |
| `funding` | Multi-chain USDC → Arc | App Kit Unified Balance / Bridge |
| `escrow` | authorize/capture/void/refund/reclaim | Commerce Payments Protocol |
| `payout` | EURC→EUR instruction (mock) + refund bridge-back | `arc-fintech` pattern |
| `events` | Webhooks, signature verification, compliance | Circle webhooks + SCP |

**On-chain vs off-chain:** escrowed funds, FX conversion, and release state live **on-chain** (Arc). Order metadata, UI status, notifications, and release-hook logic live **off-chain** (host). The fiat leg & KYB/AML are **off-chain, owned by a licensed host**.

## Prerequisites

- **Node.js 20+**
- A **Circle Console** account: `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` (register the entity secret once)
- An App Kit **`KIT_KEY`** (for FX swaps / Stablecoin Service)
- Testnet USDC/EURC from [faucet.circle.com](https://faucet.circle.com) (select Arc Testnet)
- *(Production)* a licensed fiat off-ramp capability + KYB on recipients

## Installation

```bash
npm install @rivokit/sdk @circle-fin/app-kit @circle-fin/adapter-viem-v2 viem
```

## Configuration

Create `.env.local` (never commit it):

```bash
# Circle
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=          # 32-byte hex; register once
CIRCLE_BLOCKCHAIN=ARC-TESTNET

# App Kit (FX swap)
KIT_KEY=KIT_KEY:<keyId>:<keySecret>

# Arc
RIVOKIT_RPC_URL=https://rpc.testnet.arc.network

# Escrow (filled in automatically by `npm run setup`)
ESCROW_ADDRESS=
TOKEN_COLLECTOR_ADDRESS=
REFUND_COLLECTOR_ADDRESS=
OPERATOR_WALLET_ID=
MERCHANT_ADDRESS=
```

## Quickstart

```bash
git clone <repo> && cd rivokit
npm install
cp .env.example .env.local     # fill in the credentials above
npm run setup                  # deploy escrow (SCP) + create operator/merchant wallets
npm run dev
```

Minimal integration into your app:

```ts
import { RivoKit } from "@rivokit/sdk";

const rivokit = new RivoKit({
  kitKey: process.env.KIT_KEY!,
  rpcUrl: process.env.RIVOKIT_RPC_URL,
});

// 1) Create an order — the FX quote is locked here
const order = await rivokit.createOrder({
  payer, receiver,
  priceEUR: "18500000",          // micro-EURC (€18.50) — the amount GUARANTEED to the recipient
  receivingChain: "Ethereum_Sepolia",
  mode: "escrow",                // "escrow" | "direct"
  wedge: "digital_goods",
});

// 2) Fund the escrow — multi-chain USDC → Arc (async, event-driven)
await rivokit.fund(order.id, payerAdapter);

// 3) Release from your business logic (milestone approved, access granted, etc.)
await rivokit.release(order.id, { kind: "access_granted", ref: "LIC-8842" });
```

## Integration guide

### What RivoKit does vs what you (the host) provide

| RivoKit (in the flow) | Host (out of the flow) |
|---|---|
| Multi-chain USDC funding → Arc | Catalog, identity, product UX |
| Non-custodial escrow + release/refund | **Release hook** (milestone/SLA/confirmation) |
| Floored USDC→EURC FX + rebate | **Fiat payout execution** (EURC→EUR) via licensed off-ramp |
| Structured payout instruction | **KYB/AML**, merchant of record, dispute/arbitration |
| Status webhooks | Being the licensed operator/PSP (production) |

### 1. Lock the payment amount (inside `createOrder`)

`createOrder` calls `estimateSwap` to lock the USDC amount the buyer must pay, using the checkout-time rate plus a buffer:

```ts
const est = await rivokit.estimateSwap({
  from: { adapter, chain: "Arc_Testnet" },
  tokenIn: "USDC", tokenOut: "EURC",
  amountIn: "1000000",                 // 1 USDC to read the rate
  config: { kitKey },
});
// usdcAmount = priceEUR / rate × (1 + bufferBps)
```

The buyer is locked to `order.usdcAmount`; the seller's settlement rate floats within a window and is guaranteed by `stopLimit` (see step 3).

### 2. Fund the escrow (multi-chain → Arc)

```ts
await rivokit.fund(order.id, payerAdapter);
// primary:  kit.unifiedBalance.spend({ to:{ chain:"Arc_Testnet", recipientAddress: ESCROW }})
// fallback: kit.bridge / kit.estimateBridge
// then:     escrow.authorize(PaymentInfo)
```

> Cross-chain funding is **async** — CCTP attestation can take several minutes. The order passes through `funding_pending` before `funded`. Design your UI to await the event, not block.

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
rivokit.on("funded",   ({ orderId })                 => notifyReceiver(orderId));
rivokit.on("released", ({ orderId, eurcOut, rebate })=> updateUI(orderId, eurcOut, rebate));
rivokit.on("refunded", ({ orderId, chain })          => updateUI(orderId));
rivokit.on("failed",   ({ orderId, reason })         => showError(orderId, reason));

const order = await rivokit.status(order.id);
```

Register the Circle webhook endpoints (`transactions.*`, `gateway.deposit.finalized`) and **verify their signatures**. RivoKit emits a `MOCK` payout instruction that you forward to your licensed off-ramp in production.

## SDK API reference

### Methods

| Method | Returns | Description |
|---|---|---|
| `new RivoKit(config)` | `RivoKit` | Init with `kitKey`, `rpcUrl`, `adapters`, `developerFee?` |
| `createOrder(params)` | `Order` | Create an order + lock the FX quote |
| `fund(orderId, adapter)` | `Promise<void>` | Fund escrow: multi-chain USDC → Arc |
| `release(orderId, proof)` | `Promise<void>` | `capture` → settlement-FX → payout instruction |
| `refund(orderId)` | `Promise<void>` | `void`/`refund` + bridge-back |
| `status(orderId)` | `Order` | Current order status |
| `on(event, handler)` | `void` | Subscribe to status events |
| `estimateSwap(params)` | `SwapEstimate` | (Util) FX quote without executing |

### Core types

```ts
type CreateOrderParams = {
  payer: Address; receiver: Address;
  priceEUR: string;                    // micro-EURC (6 decimals) — guaranteed ≥ this to recipient
  receivingChain: ChainName;           // refund destination; default = largest source chain
  mode: "escrow" | "direct";
  wedge: "contractor_payout" | "digital_goods" | "invoice" | "physical_demo";
  bufferBps?: number;                  // default 150 (1.5%) — FX cushion + rebate source
  timeoutPolicy: { type: "reclaim" | "auto_capture"; deadline: number };
};

type OrderState =
  | "created" | "funding_pending" | "funded"
  | "released" | "refund_pending" | "refunded" | "failed";
```

### Events

| Event | Payload |
|---|---|
| `funding_pending` / `funded` | `{ orderId }` |
| `released` | `{ orderId, eurcOut, rebate }` |
| `refund_pending` / `refunded` | `{ orderId, chain? }` |
| `failed` | `{ orderId, reason }` |

### Invariants enforced by the SDK

1. The recipient receives **≥ `priceEUR`** or the swap reverts (funds safe).
2. Refunds always go to the recorded `receivingChain`.
3. `rebate = max(0, actualOutput − priceEUR)`.
4. ERC-3009 nonce is single-use (anti-replay).
5. Money is always **integer minor units** (6 decimals) — never a float.

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

## Security model

- **Non-custodial** — funds are held by the escrow contract (Commerce Payments Protocol); the operator only submits txs & earns a fee, and **cannot redirect funds**.
- **Floor guarantee** — `stopLimit` ensures the recipient gets ≥ €P or a safe revert.
- **Anti-replay** — single-use ERC-3009 authorization nonces; unique idempotency keys off-chain.
- **Server-side policy** — validation & screening (Circle Compliance Engine) on the server, not the client.
- **Secrets** — credentials via environment variables; **never** committed.

Report vulnerabilities privately, not via public issues.

## Limitations & honest boundaries

- **Testnet only**, unaudited — do not use real funds.
- **The fiat leg (EURC→EUR) is mocked**; production requires a licensed host (Circle Mint/PSP) + KYB/AML.
- Depends on Circle: USDC/EURC can be frozen by the issuer; CCTP attestation is centralized; Arc Testnet may experience downtime.
- RivoKit is **not** a licensed operator — the host is responsible for the fiat leg, compliance, and disputes.

## Project structure

```text
rivokit/
├── src/
│   ├── orchestrator/     # order state machine (new code)
│   ├── settlement-fx/    # quote-lock + stopLimit swap + rebate (new code)
│   ├── funding/          # App Kit unified balance / bridge
│   ├── escrow/           # Commerce Payments Protocol
│   ├── payout/           # EURC→EUR instruction (mock) + refund bridge-back
│   └── events/           # webhooks + compliance
├── demo/                 # split-panel host demo (Next.js) — buyer + seller
└── README.md
```

## Roadmap

Build phases (testnet): Setup → Escrow lifecycle → Settlement-FX → Multi-chain funding + refund → Events/compliance/payout mock → SDK surface + demo → Hardening. The full production frontend is built after the core SDK works. Mainnet is out of current scope — gated on audit + key timelock/multisig + legal review + a licensed off-ramp.

## Contributing

Contributions follow phase discipline (read the internal build guide before writing code). Ordinary bugs → issues; security vulnerabilities → report privately. Non-negotiable rules: non-custodial, money as integer minor units, swaps must carry a `stopLimit`, mocks must be labeled, and no credentials/internal docs committed.

## License & disclaimer

Apache-2.0 (following the referenced Circle samples).

RivoKit is testnet-stage sample software for demonstration and educational purposes. It is **not** a licensed financial product and **not** legal/financial advice. The embedding host is fully responsible for the fiat leg, KYB/AML, and compliance in its jurisdiction.

---

<div align="center">
Built for the <b>Build on Arc</b> hackathon — DeFi track.
</div>
