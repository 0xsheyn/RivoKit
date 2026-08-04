<div align="center">

# RivoKit

### An embeddable cross-border settlement SDK on Arc — multi-chain USDC in, local-currency out.

![chain](https://img.shields.io/badge/chain-Arc%20Testnet%20(5042002)-blue) ![contracts](https://img.shields.io/badge/contracts-verified%20on%20Arc-success) ![tests](https://img.shields.io/badge/tests-462%20passing-brightgreen) ![status](https://img.shields.io/badge/status-mvp%20%C2%B7%20testnet-orange) ![license](https://img.shields.io/badge/license-MIT-green)

**[Getting started](STARTED.md)** · **[Architecture](ARCHITECTURE.md)** · **[Proofs](PROOFS.md)** · **[Limitations](LIMITATIONS.md)**

</div>

> ⚠️ **Testnet only, unaudited.** Do not use real funds or mainnet keys.

---

<p align="center">
  <img src="demo/assets/readme_banner.jpg" alt="RivoKit — one call, escrow to bank account. A createOrder call with payoutTo: &quot;bank&quot;, then fund() and release(), which captures, quotes through CPN, broadcasts and reaches the bank. Order ord_1785510582_657861 ran it on Arc Testnet on 2026-07-31: capture 0x631405…9966698, CPN payment 61d22d57… reported COMPLETED, 11.751140 USDC to €10.00 exactly; the order walked funded → payout_pending → paid_out and stored its payout as kind: cpn, label: LIVE, executed: true. Both target corridors have reached COMPLETED on live infrastructure — EUR/SEPA payment 61d22d57… moved 11.751140 USDC to €10.00, and USD/WIRE payment c2fec0f6… moved 62.000000 USDC to $36.96, signed_by: wallet.">
</p>

Every hash, every order id, and exactly what each run does *not* prove:
**[PROOFS.md](PROOFS.md)**.

## Overview

RivoKit is a **money-orchestration layer** that a marketplace, payout app or
invoicing system embeds into its checkout. It moves value from *"the payer pays
USDC from whatever chain they hold it on"* to *"the recipient is paid"* — with
the recipient's amount fixed before anything moves.

A buyer pays USDC from any supported chain. RivoKit routes it to Arc, holds it in
a Commerce Payments Protocol escrow, and on release takes **one of two endings,
chosen once at `createOrder`**:

- **`payoutTo: "wallet"`** — a floored swap USDC→EURC, ending at EURC on Arc.
  The recipient decides later what to do with an accumulated balance.
- **`payoutTo: "bank"`** — `release()` drives the off-ramp itself, in one call,
  and the money lands in a local bank account. The currency follows the corridor.

That second ending is the thing this project is actually about, and it is real:
both target corridors have driven a payment to `COMPLETED` with USDC genuinely
leaving a wallet on Arc.

**What runs today, stated as narrowly as the evidence allows:**

- RivoKit's **own** Commerce Payments Protocol instances on Arc Testnet, all four
  source-verified full match.
- Escrow lifecycle, floored swap, multi-chain funding and refund bridge-back —
  proven against the real chain, not a fork.
- `release()` reaching a bank in one call, driven from scripts, from the `/sdk`
  page's UI, and from the marketplace's own server actions.
- A **25 bps operator fee** grossed onto the payer and split at capture, never
  touching the recipient's floor.
- A cash-out the server **cannot forge**: a connected wallet signs the CPN intent
  and the server only broadcasts it. Proven from a zero Permit2 allowance.
- Webhooks that are **verified, not trusted** — signature-checked against the
  live key before any reducer sees a body, with a one-digit edit refused.
- **462 unit tests** across 26 files, runnable with no credentials at all.

And the ceiling on all of it: **`COMPLETED` is CPN reporting the fiat leg
finished, not anyone watching euros arrive.** That distinction is not a
disclaimer at the bottom of this page — it is [a section of its own](#the-boundary-this-project-will-not-paper-over).

RivoKit is **not** a marketplace, wallet, custodian, or licensed institution. It
orchestrates; the licensed host that embeds it stays the party of record. It
writes no primitives from scratch — it composes App Kit (bridge / swap / unified
balance), the Commerce Payments Protocol (escrow) and CPN (fiat) behind one API.

## The problem it solves

Three frictions that converge on the same point:

**The payer's balance is scattered; the recipient does not want crypto.** A
crypto-native business holds USDC across many chains. A European contractor wants
euros in a bank account. Bridging that today means manual off-ramps, opaque FX,
and a settlement path the platform has to babysit.

**The recipient needs certainty, not a rate.** They want a *guaranteed* local
amount — not exposure to whatever FX does between checkout and settlement. "Best
effort" is not a payment. RivoKit fixes the recipient's number at `createOrder`
and makes the chain enforce it: the swap carries `stopLimit = priceEUR`, so a bad
rate reverts and leaves the funds in escrow. On the bank path the CPN quote plays
the same role, and RivoKit refuses to broadcast one that delivers less. **There
is no code path in which the recipient quietly receives less.**

**Platforms must assemble the plumbing themselves.** Offering "pay in USDC,
receive local" means stitching bridging + escrow + FX + payout across four
protocols, each with its own failure mode, none of them the platform's core
competency — and then discovering the parts do not compose. CPN accepts USDC
only, so a settlement that ends in EURC cannot be off-ramped through it at all.
That is the kind of thing you find after building both halves.

RivoKit closes all three: the payer pays from any chain, the recipient is
guaranteed their number and can be paid into a bank without a second manual step,
and the platform calls a handful of functions instead of becoming a payment
company.

## Why RivoKit

| | |
|---|---|
| 🌉 **Multi-chain by default** | Payers pay from a USDC balance on any chain (unified balance / CCTP) — RivoKit routes it to Arc. |
| 🎯 **The recipient's number is fixed first** | `stopLimit` on the wallet path, the CPN quote on the bank path. Either way: at least the promised amount, or nothing moves. |
| 🏦 **One call reaches a bank** | `payoutTo: "bank"` makes `release()` capture, quote and broadcast. Not a printed instruction, not a second manual cash-out. |
| 🔒 **Non-custodial, and keyless** | Funds sit in the escrow contract. RivoKit holds no key at all — every signer is injected by the host, so broadcasting is always an explicit decision. |
| ⛽ **Gasless, and it pays for itself** | ERC-3009 + operator relay: the payer never holds Arc gas. The operator fee is grossed *onto* the payer, so the relay's cost never comes out of the recipient's floor. |
| 💶 **The buffer comes back** | The payer overpays a buffer to absorb rate drift and gets the surplus returned — in the right token for the path, EURC or USDC. |
| 🔁 **Refunds know where they came from** | On failure or expiry the USDC is bridged back to the payer's origin chain. |
| ✅ **Verifiable, not asserted** | Every contract is source-verified on the explorer, `check-cpp.mjs` asserts the wiring instead of trusting it, and every claim in [PROOFS.md](PROOFS.md) carries a hash — next to what it does *not* prove. |

**The four rules that do not bend:**

1. **Non-custodial.** Funds sit in the escrow contract on Arc, never on a
   RivoKit server. RivoKit holds no key — every signer is injected by the host.
2. **Money is always `bigint` minor units.** Never a float, at any layer.
3. **Every swap carries a `stopLimit`.** A swap that cannot meet the seller's
   floor reverts rather than settling short. The guarantee is enforced by the
   chain, not by TypeScript.
4. **Mocks are labelled MOCK.** A build with no payout rail wired refuses
   `payoutTo: "bank"` at `createOrder` instead of pretending.

## How the money moves

```text
        ┌── Ethereum · Base · Avalanche ──┐
        │        buyer holds USDC          │
        └────────────────┬─────────────────┘
                         │  CCTP bridge · Gateway unified balance
                         ▼
              ┌─────────────────────┐
              │    USDC on Arc      │  ERC-3009: buyer signs, operator relays
              └──────────┬──────────┘  (the buyer never holds Arc gas)
                         ▼
              ┌─────────────────────┐
              │   Escrow (CPP)      │  authorize → hold → capture / void / refund
              └──────────┬──────────┘
                         ▼
          ┌──────────────┴───────────────┐
   payoutTo: "wallet"              payoutTo: "bank"
          │                               │
   floored swap                    CPN quote pinned to €P
   USDC → EURC, stopLimit = €P     (the swap is skipped)
          │                               │
          ▼                               ▼
   EURC on Arc                     local bank account
```

**Why the bank path skips the swap.** CPN accepts USDC as its only source
currency — `sourceCurrencies: ["USDC"]`, verified against the live API.
Converting to EURC first and back would pay a spread to reach a currency that is
immediately spent to reach another one. Instead the CPN quote is what pins the
euro amount, exactly as `stopLimit` pins it on the wallet path. The floor check
stays in the SDK; a host-supplied rail only quotes and broadcasts — it never
decides whether the seller was paid enough.

**Why a bank order is sized by the rail.** A buffer computed against the
StableFX spread does not cover CPN's spread *and* its fees, and the gap only
surfaces after the escrow is already captured. `PayoutRail.estimate()` exists so
the thing that will execute the payout is the thing that sizes it.

Two **modes**, mapping straight onto Commerce Payments Protocol operations:
`escrow` (default, `Authorize → Capture`, funds held until the host's release
hook fires) and `direct` (`Charge`, atomic — for trusted payouts and approved
invoices).

**Timeout is not a parameter.** It is derived from `wedge`, because the strength
of the available proof is what should decide who an expiry favours: strong proof
(B2B, digital) → `auto_capture`; weak proof (physical goods) → `reclaim`.

## API surface

```ts
import { createRivoKit, createCpnRamp, createCpnPayoutRail } from "rivokit";
```

`createRivoKit(deps)` — deps: `{store, escrow, fx, bridge, fund, config,
compliance?, emitter?, payRebate?, payoutRail?, operatorGas?, refundBridgeParams?}`

| Method | Does |
|---|---|
| `createOrder(params)` | Screen → size → store. Rejects here — not at release — if the rail would refuse the order. |
| `fund(orderId, opts?)` | Moves USDC to Arc and authorizes into escrow. `opts.signature` relays a browser-wallet ERC-3009. |
| `release(orderId, proof)` | Capture → settle. Reaches a bank when `payoutTo: "bank"`. |
| `retrySettlement(orderId)` | The way out of `settlement_pending`: swap again, or re-quote and broadcast. Never captures twice. |
| `refund(orderId)` | `void`/`refund` + bridge-back to `receivingChain`. |
| `status(orderId)` · `payoutFor(orderId)` | Read the order and its payout row. Both persisted, so both survive a restart. |
| `refreshPayout(orderId)` | Second read of the rail — the fallback for hosts with no webhook endpoint. |
| `estimateSwap({address, amountInMinor})` | FX quote without creating anything. |
| `on(event, fn)` · `off(event, fn)` | `funding_pending` · `funded` · `released` · `payout_pending` · `paid_out` · `refund_pending` · `refunded` |

`OrderState`: `created · funding_pending · funded · settlement_pending · shipped
· released · payout_pending · paid_out · refund_pending · refunded · failed`.

`payout_pending` means **broadcast, not delivered** — the fiat leg is
asynchronous. `paid_out` is terminal and has no edge back to `refund_pending`:
money in a beneficiary's bank is beyond anything an operator-funded refund can
reach.

`settlement_pending` means **captured, but not yet in the promised currency** —
the escrow is empty and the USDC sits with the receiver. It is recoverable, and
`retrySettlement()` is what recovers it; calling `release()` again would try to
capture an escrow that has nothing left in it. `order.failureReason` says which
refusal put it there.

Standalone off-ramp, decoupled from any order:
`createCpnRamp({apiKey, corridor})` → `quote` · `prepare` (safe) · `submit`
(irreversible) · `submitSigned` · `status`.

Wiring all of this into a real app, step by step: **[STARTED.md](STARTED.md)**.

## Status

| | |
|---|---|
| Tests | **462 passing / 26 files**, runnable with no credentials at all |
| Typecheck | clean (`tsc --noEmit`) |
| Chain | Arc Testnet (`5042002`) — RivoKit's own CPP instances, all source-verified full match |
| Corridors proven | **EUR/SEPA** and **USD/WIRE**, both `COMPLETED` |
| Corridors advertised on Arc | 14 corridors / 286 routes, every one USDC-sourced |
| Package | `private` — installable from git, deliberately absent from the npm registry |

## The boundary this project will not paper over

**No euro has ever been observed arriving in a bank account, and none can be in
a sandbox.**

Circle's documentation states the CPN sandbox is a simulator: statuses are driven
by magic values on `ORIGINATOR_NAME`, and sandbox refund transaction hashes are
*"randomly generated"*. Every payout destination in this repository is a
fabricated IBAN with no balance to inspect. The one destination whose balance
*could* be read — Circle Mint's own EUR deposit IBAN — was **not** credited even
though the payment reached `COMPLETED` and 12 USDC genuinely left the seller's
wallet. That experiment cost 12 USDC and is written down so nobody repeats it.

So a corridor that "settled" here means **CPN reported the fiat leg finished**.
It does not mean anyone watched euros arrive. Only one real payment on mainnet,
into an account you control, closes that question.

Everything else on this page is backed by a transaction hash you can open in an
explorer.

The complete inventory of what is unproven, unbuilt, or deliberately out of
scope: **[LIMITATIONS.md](LIMITATIONS.md)**.

## Repository

| Path | Holds |
|---|---|
| `src/` | The SDK. Entry point `src/index.ts` — deep imports are unsupported and move without a version bump. |
| `src/payout/` | The `PayoutRail` seam and the CPN implementation of it. |
| `demo/` | Next.js marketplace plus a bare `/sdk` state-machine page. |
| `scripts/live-*.mjs` | Proofs against real Arc Testnet. Require `.env.local`. |
| `scripts/probe-*.mjs` | API behaviour mapping — what the services actually do, not what we assumed. |
| `contracts/` | Pinned CPP artifacts, provenance, re-verification recipe. No Solidity of our own. |
| `infra/supabase/migrations/` | Order-store schema, with the invariants as DB constraints. |
| `README_v0.md` | The previous long-form README, kept for its integration walk-through. |

## License

MIT. See [LICENSE](LICENSE). Testnet-stage sample software for
demonstration and education — not a licensed financial product, not legal or
financial advice. The embedding host is fully responsible for the fiat leg,
KYB/AML and compliance in its jurisdiction.

Report vulnerabilities privately, not through public issues.
