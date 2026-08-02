<div align="center">

# RivoKit

### An embeddable cross-border settlement SDK on Arc — multi-chain USDC in, local-currency out.

![chain](https://img.shields.io/badge/chain-Arc%20Testnet%20(5042002)-blue) ![contracts](https://img.shields.io/badge/contracts-verified%20on%20Arc-success) ![tests](https://img.shields.io/badge/tests-428%20passing-brightgreen) ![status](https://img.shields.io/badge/status-mvp%20%C2%B7%20testnet-orange) ![license](https://img.shields.io/badge/license-Apache--2.0-green)

**[Getting started](STARTED.md)** · **[Architecture](ARCHITECTURE.md)** · **[Proofs](PROOFS.md)** · **[Limitations](LIMITATIONS.md)**

</div>

> ⚠️ **Testnet only, unaudited.** Do not use real funds or mainnet keys.

---

## One call, escrow to bank account

```ts
const order = await kit.createOrder({
  payer, receiver,
  priceEURMinor: 1_000_000n,        // €10.00 guaranteed to the seller
  receivingChain: "ARC-TESTNET",
  wedge: "delivery_confirmed",
  payoutTo: "bank",
});

await kit.fund(order.id);
await kit.release(order.id, proof);  // capture → CPN quote → broadcast → bank
```

That is not a sketch. Order `ord_1785510582_657861` ran it against Arc Testnet on
2026-07-31: capture
[`0x631405…9966698`](https://testnet.arcscan.app/tx/0x63140582f99e748e2af4c4f1f281fc086f5ee953f861668eb161adf7a9966698),
CPN payment `61d22d57…` reported **`COMPLETED`**, 11.751140 USDC → **€10.00
exactly**. The order walked `funded → payout_pending → paid_out` and stored its
payout as `kind: cpn`, `label: LIVE`, `executed: true`.

Both target corridors have reached `COMPLETED` on live infrastructure:

| Corridor | Payment | Moved |
|---|---|---|
| **EUR/SEPA** | `61d22d57…` | 11.751140 USDC → €10.00 |
| **USD/WIRE** | `c2fec0f6…` | 62.000000 USDC → $36.96, `signed_by: wallet` |

Every hash, every order id, and exactly what each run does *not* prove:
**[PROOFS.md](PROOFS.md)**.

## What it is

A money-orchestration layer a marketplace, payout app or invoicing system embeds
into its checkout. It moves value from *"the payer pays USDC from any chain"* to
*"the recipient is paid"* — with a locked FX quote, escrow, automatic refunds,
gasless UX, and a fiat exit.

A buyer pays USDC from whichever chain they already hold it on. RivoKit routes it
to Arc, holds it in a Commerce Payments Protocol escrow, and on release either
settles to floor-guaranteed EURC on Arc or drives it through the Circle Payments
Network into a local bank account. The seller is promised an exact amount in
fiat terms before anything moves, and receives exactly that.

RivoKit is **not** a marketplace, wallet, custodian, or licensed institution. It
orchestrates; the licensed host that embeds it stays the party of record. It
writes no primitives from scratch — it composes App Kit (bridge / swap / unified
balance), the Commerce Payments Protocol (escrow) and CPN (fiat) behind one API.

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

Standalone off-ramp, decoupled from any order:
`createCpnRamp({apiKey, corridor})` → `quote` · `prepare` (safe) · `submit`
(irreversible) · `submitSigned` · `status`.

Wiring all of this into a real app, step by step: **[STARTED.md](STARTED.md)**.

## Status

| | |
|---|---|
| Tests | **428 passing / 24 files**, runnable with no credentials at all |
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

Apache-2.0. See [LICENSE](LICENSE). Testnet-stage sample software for
demonstration and education — not a licensed financial product, not legal or
financial advice. The embedding host is fully responsible for the fiat leg,
KYB/AML and compliance in its jurisdiction.

Report vulnerabilities privately, not through public issues.

<div align="center">Built for the <b>Build on Arc</b> hackathon — DeFi track.</div>
