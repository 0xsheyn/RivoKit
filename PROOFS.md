# Proofs

Every claim RivoKit makes, with the transaction hash or payment id behind it —
and, for each one, what it does **not** establish.

Read [Two grades of evidence](#two-grades-of-evidence) before the tables. It is
the difference between "anyone can verify this forever" and "Circle said so."

- [Two grades of evidence](#two-grades-of-evidence)
- [Settlement on Arc](#settlement-on-arc)
- [Escrow to bank in one call](#escrow-to-bank-in-one-call)
- [The demos reaching a bank](#the-demos-reaching-a-bank)
- [The fiat corridors](#the-fiat-corridors)
- [Cash-out signed by the owner's wallet](#cash-out-signed-by-the-owners-wallet)
- [Webhooks](#webhooks)
- [Circle Mint — the second fiat exit](#circle-mint--the-second-fiat-exit)
- [Browser wallet funding rails](#browser-wallet-funding-rails)
- [What we measured about CPN](#what-we-measured-about-cpn)
- [The corridor catalog on Arc](#the-corridor-catalog-on-arc)
- [Negative results](#negative-results)
- [Reproducing any of this](#reproducing-any-of-this)

---

## Two grades of evidence

Every claim below is one of two classes, and they are **not** interchangeable.
Conflating them is the easiest way to overstate this project.

| | **On-chain leg** | **Fiat leg** |
|---|---|---|
| Covers | USDC leaving a wallet, escrow, capture, swap, the transfer into CPN's contract | A bank crediting a beneficiary |
| Evidence | **Verified.** Arc transaction hashes anyone can open, balances that moved | **Asserted by Circle.** A `COMPLETED` status, a `fiatNetworkPaymentRef`, a `fiatSettlementTime` of 1–3 days |
| Who can check | Anyone, independently, forever | Only the beneficiary, by reading a bank statement |
| Status here | Proven repeatedly | **Never observed — not once** |

The fiat leg is unobservable here **by construction**:

- Circle's sandbox is a simulator. Statuses are driven by magic values on
  `ORIGINATOR_NAME`, and the documentation states sandbox refund transaction
  hashes are *"randomly generated"*
  ([magic values](https://developers.circle.com/cpn/references/testing/magic-values)).
  No sandbox payment settles money, however many reach `COMPLETED`.
- Every payout destination in this repo is a **fabricated IBAN** — the canonical
  French example account, "Acme SARL". No balance exists behind it.
- The one payout aimed at a destination whose balance *could* be read reached
  `COMPLETED` and the destination balance **never moved**. See
  [Negative results](#negative-results).

So "settled" on this page means **CPN reported the fiat leg finished**. It does
not mean anyone watched euros arrive.

## Settlement on Arc

| Claim | Evidence |
|---|---|
| Escrow lifecycle · floored swap · multi-chain funding · refund bridge-back · full flow through the facade | ✅ proven on Arc Testnet, `scripts/live-sdk.mjs` and the `live-phase*` series |
| Operator fee 25 bps split at capture, floor intact | ✅ tx [`0x7910f1…037420`](https://testnet.arcscan.app/tx/0x7910f15984c10fe929d3e642a84ca3be2c86d3727076fb3d57552899e0037420) — capture split 0.008784 → operator, 3.504835 → merchant, €2.50 floor still met |
| Two-wallet mode — the €2.50 EURC floor forwarded merchant → seller wallet | ✅ tx [`0x11bf41…559bf4`](https://testnet.arcscan.app/tx/0x11bf41510b5aa7943dde09b436ff499064e4f9b8bea6c85f20a1057540559bf4) |
| Recovery after a missed floor — capture succeeds, swap misses, retry wins | ✅ `scripts/live-recovery.mjs` |
| Direct mode (atomic `Charge`) | ✅ `scripts/live-charge.mjs` |

## Escrow to bank in one call

**The headline claim.** `release()` on a `payoutTo: "bank"` order captures the
escrow, quotes CPN against the guaranteed price, and broadcasts — no separate
cash-out step.

**Order `ord_1785510582_657861`** — 2026-07-31, `scripts/live-sdk-bank.mjs`:

| | |
|---|---|
| Capture | [`0x631405…9966698`](https://testnet.arcscan.app/tx/0x63140582f99e748e2af4c4f1f281fc086f5ee953f861668eb161adf7a9966698) |
| CPN payment | `61d22d57…` → **`COMPLETED`** |
| Amount | 11.751140 USDC → **€10.00 exactly** |
| Order path | `funded → payout_pending → paid_out` |
| Stored payout | `kind: cpn`, `label: LIVE`, `executed: true` |
| Sizing | CPN priced €10.00 at 11.75 USDC; +400 bps → 12.221241 USDC authorized |
| Permit2 | approved for exactly that in [`0xee970d…d57ae06`](https://testnet.arcscan.app/tx/0xee970d3a847cf9a98281644ca0c264180554551786f15e7204506f272d57ae06) |

That last pair is the point of `PayoutRail.estimate()`: the order was sized by
the rail that executed it, not by StableFX.

**The rebate on the bank path returns USDC, and it was checked against the
chain.** Order `ord_1785512905_183957`: the buyer's on-chain balance rose
**exactly** `0.474498` USDC, matching `rebateMinor`, in tx
[`0x50ef69…677c7c9e`](https://testnet.arcscan.app/tx/0x50ef691a0e2123966b81451f09dee0cb0a4a9e1f9f30699419bd90f7677c7c9e).
Verified by reading balances, not by trusting an event. All four ledger rows
reached `confirmed` with hashes (payout `0x56b337…fa3f7f5f`). 13/13 assertions.

**A stale ledger row can be repaired after the fact.**
`scripts/live-payout-reconcile.mjs` walked `ord_1785510582_657861` from `pending`
→ `confirmed` with tx `0xfa3ba6…3a05a7d1`, through `refreshPayout` — the same
path a webhook takes.

## The demos reaching a bank

Not scripts calling the SDK — the demo applications' own code paths.

**The `/sdk` page, from its own UI.** Order `ord_1785608622_324408` (€12.00,
`payoutTo: "bank"`) → CPN `0a44d36f…` **`COMPLETED`**, order `paid_out`, payout
`kind: cpn` / `label: LIVE` / `executed: true`. Four ledger rows `confirmed`:

| Row | Amount | Tx |
|---|---|---|
| authorize + capture | 14.680697 | [`0xf83ad3…e55e3299`](https://testnet.arcscan.app/tx/0xf83ad3465f2e09bb5407a684fd2d48bbce88c9a41b2fd36cd9ad1470e55e3299) · [`0xe7338a…f18a0f97`](https://testnet.arcscan.app/tx/0xe7338a7c49ff911b6b1722c9bdcf25f8be05a0539275621e13ef3f1bf18a0f97) |
| payout | 14.080788 | [`0x3eb5ad…756cf6b48`](https://testnet.arcscan.app/tx/0x3eb5ad125607911d9f7e1f05c73595b9ef196e92f51b516153b7b39756cf6b48) |
| rebate | 0.563208 | [`0x9c9148…c22fb780`](https://testnet.arcscan.app/tx/0x9c914879b997b9af5278e4c93d26d21dabbcf8511a1ce00d06678097c22fb780) |

Repeated on `ord_1785607838_340322` → CPN `f5c7fb2c…` `COMPLETED`. 2026-08-01.

*How we know it was the UI and not a script:* both orders were created **without**
an `mp.order` event (which `mpCheckout` always writes), and the `live-sdk-bank`
run state held different order ids. Not the marketplace, not the script. Since then
`createOrderAction` writes an `sdk.order` event, so origin no longer has to be
inferred from missing data.

**The marketplace, through its own server actions.** Order
`ord_1785518681_912453` via `mpCheckout → mpPay → mpRelease → mpRefreshPayout`:
CPN `134aa6f6…` `paid_out`, four ledger rows `confirmed` with hashes, rebate
0.470646 USDC returned in
[`0x082480…25a955c4`](https://testnet.arcscan.app/tx/0x0824800d7b806300282302771030b530aaa014d4961308bcd2f6111e25a955c4).
`scripts/live-demo-bank.mjs`, 12/12.

**The button, separately.** This run called the server actions directly, which is
the same code path but not the same claim. `Marketplace.tsx` does ship a button —
`Storefront` renders **BUY → EURO FIAT** on every listing `canPayoutToBank()`
clears and passes `payoutTo: "bank"` into `mpCheckout` — and it has been pressed
by hand through to `paid_out`. That last part is testimony, not an artifact; see
the note under *Browser wallet funding rails* for why this class of claim can
never carry a hash.

## The fiat corridors

Both target corridors have reached `COMPLETED`.

### EUR/SEPA

- Via `release()`: payment `61d22d57…`, 11.751140 USDC → €10.00 (above).
- Standalone cash-out, twice: 15 USDC → 12.92 EUR, `COMPLETED`.
- Wallet-signed: 15 USDC → 12.94 EUR, tx
  [`0x51e968…f049e7f`](https://testnet.arcscan.app/tx/0x51e9681d1d23fedeb239110a2c58309912a5c82d35a20c316b3102731f049e7f).

### USD/WIRE

Payment `c2fec0f6…`, 2026-08-01, **wallet-signed**:

| | |
|---|---|
| Moved | 62.000000 USDC from `0x7d9EEb…65bcCA` → **36.96 USD** to the destination bank |
| Signature | `signed_by: wallet` |
| Arc tx | `0x7a7c8aad…d6234f`, block 54765268 |
| On-chain split | 62 USDC into the CPN contract → 0.02 to the fee collector, 61.98 to Circle's settlement address |
| Fee | `25.038594` USDC = `BFI_TRANSACTION_FEE` 25.018594 + gas 0.01 + service 0.01. `62 − 25.038594 = 36.96` exactly |
| Reference | `fiatNetworkPaymentRef: RE78dzv7…`, `fiatSettlementTime` 1–3 days |

An earlier USD/WIRE attempt `FAILED`; that result no longer describes the status.

### BRL/PIX and MXN/SPEI

Implemented — corridor config, per-rail beneficiary and travel-rule fields,
quotes — and **deliberately unexercised** during the build and testnet phase.
Roadmap, not a gap. This and the roadmap section of the README are the only
places their status is tracked.

## Cash-out signed by the owner's wallet

The server never holds a key for the signing address; it only broadcasts what the
wallet signed (`ramp.submitSigned`).

Proven **from a zero Permit2 allowance**, which is the branch that had previously
been skipped because the test wallet already held an unlimited one:

1. Wallet `0xd7d7B4…` approved exactly 15 USDC — tx
   [`0xdeebf4…cf11177a`](https://testnet.arcscan.app/tx/0xdeebf45ad5e1747693e33e2de0dabca14ccef1323d27d29aaaf598f7cf11177a)
2. Spent it entirely on a 15 USDC → 12.95 EUR cash-out that reached `COMPLETED`
3. Allowance returned to 0
4. The stored row carries `signed_by: "wallet"`

## Webhooks

**Delivered over real HTTP into our own route.** Circle validated the URL with
`HEAD`, then POSTed five events for cash-out `056c3e1f…`. Each was verified
against the live `X-Circle-Signature` and written to `events` with
`sig_verified = true`. A body edited by one digit is refused. `webhooks.test` is
accepted on a fresh subscription.

**A verified webhook advances the stored cash-out.** Row `acd9d389…` walked
`CRYPTO_FUNDS_PENDING → FIAT_PAYMENT_INITIATED → COMPLETED`; duplicates and
transaction events wrote nothing.

**And only the webhook does.** This was settled by *removing* the competing
writer, not out-racing it. `scripts/live-webhook-attribution.mjs` prepares,
records the row, broadcasts, and then only reads. For cash-out `da85fbcc…`
(12 USDC → 10.31 EUR, broadcast 08:49:43.999Z):

- The caller made exactly one write — the initial `recordCpnPayment` — and **no
  status write at all**
- Five events landed in `events` with `sig_verified = true`; only the webhook
  route writes that table
- The row reached `COMPLETED`
- On chain the seller went 24.000787 → 12.000787 USDC
- A single `ramp.status()` ran *after* the observation window as a control: CPN
  also said `COMPLETED`

**What that row does not claim:** `FIAT_PAYMENT_INITIATED` was applied by the
reducer but never *sampled* — the last two webhooks arrived inside the same
five-second read interval. Proven: the endpoints of the walk. Not proven: three
observed stops along it.

**Two defects only real traffic caught**, both invisible to unit tests that sign
with their own keypair and never resolve a key: the per-product public-key
endpoint (CPN key ids answered 404 on the Wallets path → every CPN webhook would
have been refused `401 unverifiable`), and the `webhooks.test` rejection that
disabled a subscription after three failures. Both fixed; key resolution now
tries the inferred product and falls back.

## Circle Mint — the second fiat exit

A rail independent of CPN, which is what stops the fiat story resting on one
integration.

| Claim | Evidence |
|---|---|
| Seller EURC on Arc → Mint EUR balance, **no bridge** | ✅ 1 EURC, balance 253.49 → 254.49, tx [`0x405164…52a8449e`](https://testnet.arcscan.app/tx/0x40516460af2571449291fa4448533793818dd287f9aeade449b1a13752a8449e). Circle exposes an `EUR ARC` deposit address |
| Mint redeem USD → wire bank | ✅ `complete` — 10.00 USD, 350.00 → 340.00, payout `3f708440…` |
| Mint redeem EUR → SEPA bank | ✅ `complete` twice — 10.00 EUR each, 273.49 → 253.49, payouts `9d98c66f…` + `47a86ec3…` |

All 2026-07-28. The destination is a linked IBAN whose `transferTypesInfo`
reports `sepa: {currencies: ["EUR"]}` — so the money leaves over SEPA, not a wire
wearing its name.

> **Do not mix the two USD→bank rails.** Circle Mint redeem USD→wire starts from
> a fiat balance already inside Mint. The CPN USD/WIRE corridor starts from USDC
> on Arc and runs quote → travel rule → Permit2 → broadcast. Only the second is
> part of RivoKit's off-ramp. Evidence for one may never be used to claim the
> other.

Every earlier Mint attempt failed `transaction_denied` purely because the sandbox
account was in Console *default-deny* with zero policies; adding one flipped it,
with no code change in between.

**Deliberately unwired:** `release()` does not trigger a Mint redeem. The bank
path it drives is CPN, which sources USDC directly and never needs the EURC leg.

## Browser wallet funding rails

Both rails in `demo/app/wallet-rails.ts` executed on-chain through
`createViemAdapterFromProvider`:

| Rail | Tx |
|---|---|
| Gateway spend | [`0xca092f…4d774517`](https://testnet.arcscan.app/tx/0xca092f363b2dab2d891d7e29e274422f2362227c7af2283d6d6a33c49d774517) |
| CCTP bridge mint | [`0x35da17…fe945639`](https://testnet.arcscan.app/tx/0x35da17676282eed203afd3ccf8bcf8fe8daf9c23d7453bcb37e2f16efe945639) — Sepolia 21 → 18 exactly |

`scripts/live-wallet-rails.mjs`, driven by an EIP-1193 provider
(`scripts/lib/eip1193.mjs`).

**What this does not prove, and what closed it separately.** The run above is a
provider driving the rails, so on its own it says nothing about a wallet's UI.
That gap is closed, but by testimony rather than by an artifact: all six answers
have since been exercised by hand in a real wallet — already on Arc (no prompt),
switch accepted, switch declined (4001, surfacing as a refusal and not as a
failure), add-chain (4902) accepted and then declined, and a two-chain bridge
raising the switch prompt **twice**, confirming the `pinnedTo()` regression has
not returned. Each answer also has a branch and a test
(`demo/app/wallet-rails.test.ts`, `wallet-errors.test.ts`).

There is no hash to attach and no run to replay, and there cannot be: what is
being demonstrated is that **no server key may stand in for the user's
decision**, so an artifact produced by a server key would disprove the claim
rather than support it. Weigh it accordingly against the hashed rows here.

**The bug this proof found, and fixed.** One provider-backed adapter cannot serve
both sides of a cross-chain move: App Kit sent the Arc mint on Sepolia and failed
*after* the burn. 2 USDC stranded, recovered by
`scripts/live-gateway-recover.mjs` (tx
[`0x4bcadd…87e8c0f4`](https://testnet.arcscan.app/tx/0x4bcadd01c5af75b150c5d570690ff1e5399f298935cb9743cf473f1487e8c0f4)).
`pinnedTo()` now gives two chain-scoped views of one wallet.

## What we measured about CPN

Facts established by probing, not by reading documentation.

**CPN sources only USDC.** `GET /v1/cpn/configurations/overview` returns
`sourceCurrencies: ["USDC"]`, full stop (2026-07-31,
`scripts/probe-cpn-source.mjs`). EURC cannot be off-ramped at all. This is the
whole reason the bank path skips the swap.

**The USD/WIRE fee is flat, not a spread.** `BFI_TRANSACTION_FEE` was 25.018594
USDC on a 62 USDC payment *and* on a 42 USDC quote — the same absolute number.
That explains the ~61 USDC minimum (not the exchange rate), why sending exactly
at the minimum is refused `290100`, and why the corridor's apparent rate looks
absurd (0.404–0.642) while EUR/SEPA looks normal.

**Async magic values take ~115 seconds, not "a few seconds."** Measured
2026-08-02: `AsyncFailed` → `FAILED` (`TRAVEL_RULE_FAILED`) and `Expired` →
`FAILED` (`ONCHAIN_SETTLEMENT_CUTOFF_TIME_EXCEEDED`), both at t+115s. A 20-second
polling window reports both as hung — an easy misread.
`scripts/probe-cpn-lifecycle.mjs` drives the six states reachable without a
broadcast (including RFI levels 1–3, where `rfiEffect` is confirmed correct:
`blocksPayment: true`, `failsPayment: false`) and names explicitly the four it
does **not** run because they require a real broadcast (`Delayed` and three
`FailThenRefund*`).

**SEPA payouts are much slower than USD wires** — ~8–12 minutes versus ~50
seconds (2026-07-28). The balance debits at `201` while the status stays
`pending`, so a 5-minute window reports a healthy payout as stuck.

**Corridor minimums are enforced destination-side.** 11 USDC refused on a
corridor that accepted 12 the same day.

## The corridor catalog on Arc

Read from the API on 2026-08-01: `getOverview()` across 223 destination
countries, then `listRoutes()` per country, filtered to `ARC-TESTNET` — **286
routes, 14 corridors, every one sourced from USDC.**

This is what the network **advertises**. It is not execution proof and not a list
of targets. It is here so it never has to be mapped again.

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

Before trusting any row:

- **`minUsdc` is indicative.** Enforced destination-side, so it drifts with FX.
- **USD/WIRE minimums are tiered per country** (36/56/61). `demo/lib/cpn.server.ts`
  hardcodes 61, and only for US.
- **Each corridor has its own beneficiary and travel-rule shape.** Read
  `GET /v1/cpn/payments/requirements` per corridor; copying another corridor's
  block fails validation, and `postalCode` is checked against the beneficiary
  country's format.
- Check one country: `node scripts/probe-cpn-source.mjs FR US`.

## Negative results

Things that do not work, established at cost, recorded so nobody repeats them.

**CPN cannot pay into a Circle Mint balance. Tested with real money.**

Circle Mint issues EUR deposit instructions per account
(`GET /v1/businessAccount/banks/wires/{id}/instructions?currency=EUR`) — an IBAN
at Bank Frick LI, beneficiary `CIRCLE INTERNET`, plus an account-specific
`trackingRef`. Liechtenstein has an `EUR/SEPA` route on Arc, and CPN **accepted**
that IBAN — payment `1a1cb321…` walked `CRYPTO_FUNDS_PENDING → COMPLETED`, 12
USDC genuinely left the seller's wallet (32.463489 → 20.462647, tx
`0xdfcf0e51…91d54f23`), and `customerRefId` preserved the trackingRef intact.
(The IBAN and trackingRef are deliberately not reproduced here — they are deposit
routing for a specific account. Read your own from the endpoint above.)

**The Mint EUR balance did not move.** 254.49 at broadcast, still 254.49 at T+60
minutes, and `/v1/businessAccount/deposits` recorded no new deposit at all — its
only row dated 2026-07-22. So this is not a slow SEPA credit.

Conclusion: CPN's fiat leg is a simulation that stops on CPN's side. The CPN and
Mint sandboxes are not connected. Cost: 12 USDC.
`scripts/live-cpn-to-mint.mjs`, 2026-08-01.

This is also the single strongest piece of evidence for the boundary at the top
of this page: a `COMPLETED` payment whose destination balance could actually be
read did not credit.

**Foundry fork tests prove nothing about Arc.** USDC-as-gas and the compliance
precompiles do not exist on a local EVM, so a fork test of those paths passes
without testing anything.

**Meta-transactions that fully drain a nonce-zero Arc account revert** — which
touches the premise of the gasless path at its edge.

## Reproducing any of this

Everything under `scripts/` hits real services and needs `.env.local`. Everything
that spends sits behind an explicit `CONFIRM=` variable — 22 of the 29 `live-*`
scripts — except `live-ramp-approve` / `live-ramp-revoke`, which are bounded and
reversible allowance writes. `probe-*` scripts fund nothing. The full list, and
the two bridge gates that apply only to a first run, are in
[ARCHITECTURE.md](ARCHITECTURE.md#scripts).

`live-cpn-to-mint` **refuses to run**: its question is answered, the answer cost
12 USDC, and re-running would only spend more.

```bash
node scripts/probe-cpn-status.mjs      # what CPN says right now
node scripts/probe-cpn-source.mjs FR   # routes for one destination country
node scripts/probe-cpn-lifecycle.mjs   # every state reachable without a broadcast
node scripts/live-payout-reconcile.mjs # settle any stale payout rows
```

The claims here are meant to be falsifiable. If a hash does not show what this
page says it shows, the page is wrong — fix the page.
