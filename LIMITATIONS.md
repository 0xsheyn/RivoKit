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

### Two things are proven by use, and have no artifact to show for it

Both entries below used to sit here as open gaps. They are closed — by the only
evidence they could ever have had, which is worth stating plainly rather than
letting them sit unlabelled beside rows carrying transaction hashes.

**The browser wallet prompts have been clicked.** Both funding rails in
`demo/app/wallet-rails.ts` had already executed on-chain (Gateway spend
`0xca092f…4d774517`, CCTP bridge mint `0x35da17…fe945639`), but driven by an
EIP-1193 provider rather than a wallet's UI. All six answers have since been
exercised by hand: already on Arc (no prompt), switch accepted, switch declined
(4001, which surfaces as a refusal and not as a failure), add-chain (4902)
accepted and then declined, and a two-chain bridge raising the switch prompt
**twice** — confirming the `pinnedTo()` regression has not returned.

**The marketplace's bank button has been pressed through to `paid_out`.**
`Storefront` in `Marketplace.tsx` reads `mpPayoutOptions()`, checks
`canPayoutToBank(p)`, and renders **BUY → EURO FIAT** on every listing that
clears the corridor minimum, passing `payoutTo: "bank"` into `mpCheckout`.
Nothing about the destination is asked of the buyer — the price decides.

Neither has a hash or a replayable run attached, and neither can: the property
being demonstrated is that **no server key may stand in for the user's
decision**, so an artifact produced by a server key would disprove rather than
support it. Read them as testimony. Every other ✅ in this document is
machine-checkable.

### The demo catalog is split either side of the corridor minimum

Six listings, €6.50–€14.50. The three below €10.00 can only settle as EURC in a
wallet; the three above it clear the ~11 USDC EUR/SEPA requires and go to a bank.
The threshold sits deliberately above the observed ~€9.4 so nothing lands in the
gap, and it is only a hint: the authority is `PayoutRail.limits()`, read live at
`createOrder`, because that USDC minimum drifts with FX.

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

Three sweeps exist and all three are run by hand. A payout row is born `pending`
— a broadcast returns before the transfer is mined, so the Arc hash does not
exist at write time, and `confirmed_has_tx` rightly refuses a confirmation
without one. `refreshPayout` settles it on a later read and
`scripts/live-payout-reconcile.mjs` sweeps what a crashed run left behind.
`reconcileCpnPayments` does the same for standalone cash-outs — the rows
`refreshPayout` cannot reach, because they belong to no order —
`scripts/live-cashout-reconcile.mjs`.

**What remains is the scheduler, not the code.** A host that runs neither a
webhook endpoint nor one of these sweeps will still accumulate stale rows;
nothing fires them on a timer, and nothing will until there is a durable endpoint
to hang one off. Running them by hand is a real answer for a testnet demo and not
one for production.

### The public demo has no access control at all — only a per-action ceiling

Every Server Action that moves money — a CPN broadcast, a Mint redeem, a
capture, a refund, an order — runs for **anyone who loads the page**. That is
deliberate: the point of a public testnet demo is that a stranger can walk up and
run the whole settlement themselves, and a shared password would defeat it.

So state the consequence plainly. A visitor can trigger an **irreversible** CPN
broadcast signed with the seller's server-held key. Nothing asks who they are,
nothing records who did it, and nothing can undo it once broadcast.

**The cap is the only control, and it is a ceiling per call, not a budget.**
`DEMO_CAP_TOKEN_MINOR` / `DEMO_CAP_FIAT_MINOR` (default 25 USDC / 25.00 fiat)
bound any single action; they do not bound how many actions someone makes. The
realistic worst case is therefore not theft of anything valuable — it is the
demo wallets running dry and needing a refill.

That is only acceptable because of what sits behind it: disposable testnet keys
holding testnet USDC on Arc Testnet, and a CPN sandbox whose fiat leg is a
simulator. Nothing here touches a real balance.

There is an opt-in lock (`DEMO_WRITE_KEY`) for a deployment that wants one: set
it and every action above needs an unlock cookie first. It is still one shared
secret with no accounts, no roles and no audit trail — enough to keep an endpoint
from being an open faucet, not enough to be called authentication. Anything
holding real value needs a different mechanism entirely.

### `release()` does not trigger a Circle Mint redeem

That rail is proven independently (EUR→SEPA twice, USD→wire once, plus the
bridgeless Arc→Mint deposit) but is deliberately unwired to the order flow. The
bank path `release()` drives is CPN, which sources USDC directly and never needs
the EURC leg.

### Without a `payoutRail`, payout is a labelled MOCK

It executes nothing and hands the fiat leg to the host. It is not a bank
transfer, and it says so.

## What the tests do not guard

The 462 unit tests are weighted toward pure logic — state machines, money
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

**Next — the last two gaps, and neither is code**

This group used to open with two items about a missing click. Both have been
done and both are recorded above; what is left is hosting, which no amount of
writing closes.

1. **A durable public endpoint**, so a webhook subscription outlives the process
   that created it. The route already exports `HEAD` — what Circle actually
   validates with — so the blockers are a host, Deployment Protection being off
   for that URL, and a Console step that is manual forever.
2. **A scheduled reconciliation.** The sweep itself now exists —
   `reconcileCpnPayments` closes the stale-row gap for standalone cash-outs
   whose webhook never arrives, and `scripts/live-cashout-reconcile.mjs` runs
   it. Only the scheduler is left, and it waits on (1).

**Later — widen the reach once the above holds**

3. **CPN BRL/PIX and MXN/SPEI.** Implemented; unexercised on purpose.
4. **Direct unit coverage for the network-facing modules.** Two real defects have
   already hidden there, so this is remediation, not tidiness.

**Gated on things outside the code**

5. **One real payment into an account you control** — the only thing that turns
   the fiat leg from *reported* into *observed*. EUR/SEPA, ~€10–12.
6. **Mainnet** — audit, key timelock/multisig, legal review, OFI onboarding.
