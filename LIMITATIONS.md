# Limitations

What RivoKit does not do, has not proven, or deliberately left out of scope.

This is the counterweight to [PROOFS.md](PROOFS.md). Nothing here is hedging: if
a claim on that page is stronger than the evidence, that is a bug in the page,
and this document exists so it stays easy to spot.

- [The ceiling on every fiat claim](#the-ceiling-on-every-fiat-claim)
- [Stage and scope](#stage-and-scope)
- [What is proven but incomplete](#what-is-proven-but-incomplete)
- [What the tests do not guard](#what-the-tests-do-not-guard)
- [Economic limits](#economic-limits)
- [Operational limits](#operational-limits)
- [What RivoKit is not](#what-rivokit-is-not)
- [Dependencies you inherit](#dependencies-you-inherit)
- [Deliberate non-goals](#deliberate-non-goals)
- [Roadmap](#roadmap)

---

## The ceiling on every fiat claim

**No euro has ever been observed arriving in a bank account.**

This is structural, not an omission, and it caps everything else on the fiat side.

- **The sandbox settles nothing.** Circle's documentation states CPN sandbox
  statuses are driven by magic values on `ORIGINATOR_NAME`, and that sandbox
  refund transaction hashes are *"randomly generated"*. However many payments
  reach `COMPLETED`, no money moves.
- **Every payout destination here is a fabricated IBAN** — the canonical French
  example account, "Acme SARL". There is no balance behind it to inspect.
- **The one readable destination was not credited.** Aimed at Circle Mint's own
  EUR deposit IBAN, payment `1a1cb321…` reached `COMPLETED` and 12 USDC genuinely
  left the seller's wallet — and the Mint EUR balance sat at 254.49 through T+60
  minutes with no deposit recorded at all. The CPN and Mint sandboxes are not
  connected; CPN's fiat leg stops at CPN's boundary. That test cost 12 USDC.

So when this repository says a corridor "settled", it means **CPN reported the
fiat leg finished**. It does not mean anyone watched euros arrive.

**What would close it:** one real payment on mainnet into an account you control.
Use **EUR/SEPA**, not USD/WIRE — SEPA's minimum is ~11 USDC while WIRE demands
36–61 USDC *plus* a flat ~25 USDC fee, so the first real proof costs about €10–12
rather than roughly $90. Match the credit using `refCode` in the statement memo,
or `fiatNetworkPaymentRef` where the rail carries no memo. Both are now sent and
stored. This is gated on CPN production onboarding as an OFI — a licensing
question, not a code one.

## Stage and scope

- **Testnet and sandbox only. Unaudited.** Do not use real funds or mainnet keys.
- **The package is `private`** and deliberately absent from the npm registry.
  Installable from git or a local path.
- **Mainnet is out of scope**, gated on audit, key timelock/multisig, legal
  review and OFI onboarding.
- **In production the host must be an onboarded OFI** with CPN, plus KYB/AML on
  recipients. RivoKit is not a licensed operator and cannot be one for you.

## What is proven but incomplete

Each of these works and has evidence — with a named gap that the evidence does
not cover.

### The browser wallet prompts have never been clicked

Both funding rails in `demo/app/wallet-rails.ts` have executed on-chain (Gateway
spend `0xca092f…4d774517`, CCTP bridge mint `0x35da17…fe945639`) — but driven by
an **EIP-1193 provider, not MetaMask's UI**. So the switch-chain prompt, the
add-chain prompt for Arc, and a user declining either remain unobserved.

Every *answer* to those prompts has a branch and a test: switch accepted, 4902 →
add chain, an add that does not switch, a declined switch, a declined add, and a
genuine wallet fault that must not be mistaken for a refusal. What is missing is
the click — and no server key may stand in for it, because being unable to
substitute a server key is precisely the property being demonstrated.

### The marketplace UI has no bank-payout button

`Marketplace.tsx` never passes `payoutTo: "bank"`. The bank path has been driven
from the marketplace's own **server actions** (order `ord_1785518681_912453`) and
from the `/sdk` page's UI, which does have the toggle — so "no UI reaches a bank"
is no longer true. The specific gap is the marketplace button.
`canPayoutToBank()` already computes which listings clear the corridor minimum.

### The demo catalog is mostly below the corridor minimum

Listings at €2.50–€5.00 are all under the ~11 USDC EUR/SEPA requires, so a bank
order over them is always refused at `createOrder`. There is exactly one €10.00
listing (`dsk`) for that purpose.

### The webhook endpoint does not survive its own process

The live webhook proof rode a Cloudflare quick tunnel. The URL dies with the
process, and the subscription dies with it. Anything beyond a one-off demo needs
a durable public host.

Related: **CPN subscriptions can only be created from the Console.**
`CIRCLE_CPN_KEY` returns `403` on `/v2/cpn/notifications/subscriptions` (GET
*and* POST) while `/v1/cpn/payments` returns `200`, and `CIRCLE_API_KEY` is 403
on the CPN path too. Because listing is also 403, "no subscriptions" from a
script means nothing at all. The only prerequisite a script can actually verify
is `HEAD <url>` → 200 — the same thing Circle checks.

### One webhook transition was applied but never sampled

In the attribution run, `FIAT_PAYMENT_INITIATED` was applied by the reducer but
never observed, because the last two webhooks arrived inside the same five-second
read interval. What is proven is the endpoints of the walk, not three observed
stops along it.

### There is no scheduled reconciliation

Two sweeps exist and both are run by hand. A payout row is born `pending` — a
broadcast returns before the transfer is mined, so the Arc hash does not exist at
write time, and `confirmed_has_tx` rightly refuses a confirmation without one.
`refreshPayout` settles it on a later read and
`scripts/live-payout-reconcile.mjs` sweeps what a crashed run left behind.

**A host with no webhook and no sweep will accumulate stale `pending` rows.** The
gap with nothing behind it is the `cpn_payments` row of a standalone cash-out: if
its webhook never arrives, nothing repairs it. The sweep can be written today;
only its scheduler waits on a durable endpoint.

### `release()` does not trigger a Circle Mint redeem

That rail is proven independently (EUR→SEPA twice, USD→wire once, plus the
bridgeless Arc→Mint deposit) but is deliberately unwired to the order flow. The
bank path `release()` drives is CPN, which sources USDC directly and never needs
the EURC leg.

### Without a `payoutRail`, payout is a labelled MOCK

It executes nothing and hands the fiat leg to the host. It is not a bank
transfer, and it says so.

## What the tests do not guard

The 428 unit tests are weighted toward pure logic — state machines, money
conversion, fee arithmetic, reducers, signature verification against a keypair
the test itself creates. **The modules that talk to a network or a chain have no
direct tests, and the facade tests mock them.**

| Module | How it is actually checked |
|---|---|
| `escrow/operations.ts` | live scripts only; mocked in the facade tests |
| `settlement-fx/swap.ts` | live scripts only; only `FloorNotMetError` is imported by tests |
| `orchestrator/order-store.ts` | live scripts only; tests import its *types* |
| `funding/unified-balance.ts` | no direct test; the browser rail it backs is proven on-chain, and `demo/app/wallet-rails.test.ts` covers the prompt branches |
| `escrow/payment-info.ts` | no unit test, but `check-hash.mjs` asserts it against the chain |
| `lib/rpc.ts`, `lib/circle-dns.ts` | no test; both are infrastructure the live scripts lean on |

**This is not theoretical.** Two production defects lived exactly there and
passed every test: the CPN public-key endpoint (tests sign with their own
keypair, so key resolution never runs) and the `webhooks.test` rejection that
silently disabled a subscription. Real traffic caught both.

Also: **Foundry fork tests prove nothing here.** Arc's USDC-as-gas and its
compliance precompiles do not exist on a local EVM, so a fork test of those paths
passes without testing anything.

## Economic limits

**The USD/WIRE fee is flat, so small orders are punished.**
`BFI_TRANSACTION_FEE` was 25.018594 USDC on a 62 USDC payment *and* on a 42 USDC
quote — the same absolute number, not a percentage. A €10-sized order would lose
most of its value to it. This also explains why the corridor's apparent "rate"
looks wrong (0.404–0.642) while EUR/SEPA looks normal, and why bank-bound orders
must never be sized with a percentage buffer alone. `PayoutRail.estimate()`
exists for exactly this.

**Corridor minimums are enforced destination-side**, so the USDC threshold drifts
with FX. 11 USDC was refused on a corridor that accepted 12 the same day
(`290100`). Any hard-coded floor is wrong on a schedule nobody controls.

**EURC cannot be off-ramped through CPN at all.** `sourceCurrencies: ["USDC"]`,
full stop. The only exit for EURC is Circle Mint — the `EUR ARC` deposit address,
then a redeem. So do not promise "the seller picks EUR or USD and cashes out
through CPN": the real options are **automatic to bank via CPN**
(`payoutTo: "bank"`, currency follows the corridor) **or** keep EURC and redeem
through Mint yourself.

**Do not mix the two USD→bank rails.** Circle Mint redeem USD→wire starts from a
fiat balance already inside Mint. The CPN USD/WIRE corridor starts from USDC on
Arc and runs quote → travel rule → Permit2 → broadcast. Only the second is part
of RivoKit's off-ramp; evidence for one may never be used to claim the other.

## Operational limits

- **CPN quotes expire in ~30–60 seconds.** Prepare-then-hesitate →
  `PAYMENT_EXPIRED` (`PM09000`).
- **`submit` cannot be cancelled** past `BROADCASTED`. Always gate it behind an
  explicit confirmation.
- **The sender must approve Permit2 first** or the broadcast fails.
- **SEPA payouts take ~8–12 minutes**, versus ~50 seconds for a USD wire. The
  balance debits at `201` while the status stays `pending`, so a script with a
  5-minute window reports a healthy payout as stuck. Allow at least 20 minutes.
- **CPN async magic values take ~115 seconds**, not "a few seconds" as documented.
  A 20-second polling window reports them as hung.
- **Public Arc RPCs rate-limit hard**, around the third call. Design anything
  that talks to them to be *resumable*, not *repeatable*.
- **Every `*.circle.com` host is DNS-hijacked on some networks** — including the
  documentation, which means an ordinary `fetch` cannot read Circle's docs
  either. Use `installCircleDnsPinning()`. Never disable TLS verification.
- **The operator's USDC allowance is bound to the refund collector address.**
  Redeploy the collector → allowance 0 → `refund` reverts.
- **A sandbox Mint account starts in Console `default-deny` with zero policies**,
  so every payout returns `transaction_denied`. It is a Console setting, not a
  code problem.
- **Meta-transactions that fully drain a nonce-zero Arc account revert.**

## What RivoKit is not

- **Not a marketplace, wallet, custodian, or licensed institution.** It
  orchestrates; the licensed host stays the party of record.
- **It does not verify the physical world.** The release hook is the host's
  judgement call. RivoKit checks consistency; it does not prove delivery.
- **It writes no primitives from scratch** and no Solidity of its own. It
  composes App Kit, the Commerce Payments Protocol and CPN behind one API.
- **It holds no keys.** Every signer is injected. That is a constraint on what it
  can do for you, not only a security property.

## Dependencies you inherit

- **Circle.** USDC and EURC can be frozen by the issuer.
- **CCTP attestation is centralized.**
- **Arc Testnet can go down**, and its public RPCs rate-limit aggressively.
- **CPN corridor availability, limits and fees are Circle's**, read live because
  they change.

## Deliberate non-goals

Listed so their absence is not read as an unfinished edge.

**BRL/PIX and MXN/SPEI are roadmap, not a gap.** Both are implemented — corridor
config, per-rail beneficiary and travel-rule fields, quotes — and settling them is
a deliberate non-goal of the build and testnet phase. They add breadth, not
depth. The other twelve corridors in the [catalog](PROOFS.md#the-corridor-catalog-on-arc)
are in the same position: reachable, not targeted. USD/WIRE is **not** in this
group — it is a target, and it settled.

## Roadmap

Ordered by what closes a structural hole rather than what adds surface. Nothing
here is a promise; it is what the ledger above says is still missing.

**Next — finish proving what is already written**

1. **A human clicking the wallet prompts.** Every answer has a branch and a test.
   What is left is seeing the prompts in MetaMask, which is the property being
   demonstrated.
2. **A bank-payout button in the *marketplace* UI.** `canPayoutToBank()` already
   says which listings qualify.
3. **A durable public endpoint**, so a webhook subscription outlives the process
   that created it.
4. **A scheduled reconciliation**, closing the stale-row gap for standalone
   cash-outs whose webhook never arrives.

**Later — widen the reach once the above holds**

5. **CPN BRL/PIX and MXN/SPEI.** Implemented; unexercised on purpose.
6. **Direct unit coverage for the network-facing modules.** Two real defects have
   already hidden there, so this is remediation, not tidiness.

**Gated on things outside the code**

7. **One real payment into an account you control** — the only thing that turns
   the fiat leg from *reported* into *observed*. EUR/SEPA, ~€10–12.
8. **Mainnet** — audit, key timelock/multisig, legal review, OFI onboarding.
