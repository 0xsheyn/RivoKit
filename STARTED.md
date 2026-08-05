# Getting started

Install, configure, and integrate RivoKit — from a clone that runs the demo, to
the SDK wired into your own app, to an order that reaches a bank account.

- [1. Install](#1-install)
- [2. Credentials](#2-credentials)
- [3. Deploy your escrow](#3-deploy-your-escrow)
- [4. Run the demo](#4-run-the-demo)
- [5. Integrate the SDK](#5-integrate-the-sdk)
- [6. The order lifecycle](#6-the-order-lifecycle)
- [7. Paying out to a bank](#7-paying-out-to-a-bank)
- [8. The standalone off-ramp](#8-the-standalone-off-ramp)
- [9. Webhooks](#9-webhooks)
- [10. Going to production](#10-going-to-production)
- [Troubleshooting](#troubleshooting)

Prerequisites: **Node ≥ 20**, a Circle developer account (sandbox is fine), a
Supabase project, and testnet USDC from [faucet.circle.com](https://faucet.circle.com).

---

## 1. Install

### As a dependency

The package is `private` — deliberately never published to the npm registry —
but installs normally from git or a local path. `prepare` builds `dist/` on
install, so there is no separate build step.

```bash
npm install github:0xsheyn/RivoKit
# or, working locally against a checkout:
npm install file:../RivoKit
```

```ts
import { createRivoKit } from "rivokit";
```

Everything supported is re-exported from `src/index.ts`. Deep imports into
`src/**` work but are **not** part of the supported surface: they move without a
version bump.

### As a checkout

```bash
git clone https://github.com/0xsheyn/RivoKit.git && cd RivoKit
npm install                 # runs `prepare` → builds dist/
npm test                    # 462 tests / 26 files — needs no credentials at all
```

`npm test` passing on a fresh clone with an empty `.env.local` is the intended
first checkpoint. Nothing below is required to reach it.

| Command | Does |
|---|---|
| `npm test` | vitest — 462 green / 26 files, no credentials |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build:lib` | SDK → `dist/` (ESM + `.d.ts`), entry `src/index.ts` |
| `npm run setup` | Deploy CPP instances + operator/merchant wallets (idempotent) |
| `npm run dev` | Next.js demo → `http://localhost:3000` |
| `npm run build` | `next build demo` — **never** while `npm run dev` is running; it corrupts `.next` |

## 2. Credentials

Copy the template and fill it in. `.env.local` is gitignored and must never be
committed.

```bash
cp .env.example .env.local
```

### What each key is for

| Variable | Needed for | Notes |
|---|---|---|
| `CIRCLE_API_KEY` | Wallets, compliance screening, webhook public keys | Also the key that authenticates **both** webhook public-key endpoints |
| `CIRCLE_ENTITY_SECRET` | Developer-controlled wallets | Treat as a honeypot — full wallet authority |
| `KIT_KEY` | App Kit — the FX swap | Server-side only |
| `CIRCLE_CPN_KEY` | The fiat off-ramp | **Server-only.** Never import into a client component |
| `CIRCLE_RAMP_KEY` | Circle Mint redeem | Optional — a second, independent fiat exit |
| `NEXT_PUBLIC_ARC_RPC_URL` | Chain reads | `https://rpc.testnet.arc.network` |
| `DEPLOYER_PRIVATE_KEY` | `npm run setup` — deploys once, then tops up the Circle wallets' gas | Its own wallet. Deploy authority must not sit on a hot key |
| `SELLER_PRIVATE_KEY` | The demo seller: receives a bank-bound order's capture, signs the Permit2/CPN intent, owns the cash-out balance | Its own wallet. In production the seller signs in their own. Formerly `RELAYER_PRIVATE_KEY`, which never relayed anything — the Circle operator wallet does that |
| `BUYER_PRIVATE_KEY` | Demo/live scripts signing ERC-3009 | A demo shortcut — in production the buyer signs in their browser |
| `NEXT_PUBLIC_SUPABASE_URL` · `SUPABASE_SECRET_KEY` | The order store | Service key — server-side only |
| `DEMO_WRITE_KEY` | Optional lock on every action that moves money | **Opt-in.** Set it and those actions need the header's Unlock control first; leave it unset and the demo runs open to anyone, which is how the public testnet deployment runs. Same behaviour locally and in production — no environment-dependent surprise. The per-action caps below apply either way |
| `DEMO_CAP_TOKEN_MINOR` · `DEMO_CAP_FIAT_MINOR` | Per-action ceilings | Optional. Default 25 USDC and 25.00 fiat. Applied whether or not the caller is unlocked — the cap is what bounds a leaked key |

Written automatically by `npm run setup`, never by hand:
`NEXT_PUBLIC_RIVO_ESCROW_ADDRESS`, `NEXT_PUBLIC_RIVO_TOKEN_COLLECTOR_ADDRESS`,
`NEXT_PUBLIC_RIVO_REFUND_COLLECTOR_ADDRESS`, `OPERATOR_WALLET_ID`,
`OPERATOR_ADDRESS`, `MERCHANT_ADDRESS`.

Optional demo knobs read by `demo/lib/rivokit.server.ts`:

```bash
RIVO_FEE_BPS=25            # operator fee at capture; 0 = fully subsidised
RIVO_FEE_RECEIVER=         # defaults to OPERATOR_ADDRESS
MIN_OPERATOR_GAS_USDC=0.5  # createOrder is refused below this operator gas float
RIVO_PAYOUT_CORRIDOR=EUR-SEPA
```

> **The deployer and the operator must be different keys.** The operator is hot —
> it signs every payment — and must not also hold deploy authority.

### Database

Apply the migrations in `infra/supabase/migrations/` in order. They ship with the
package (`files` includes them), and they carry the SDK's invariants as database
constraints rather than as comments — `confirmed_has_tx`, for one, refuses to
mark a payout confirmed without an on-chain hash.

## 3. Deploy your escrow

RivoKit deploys **its own** Commerce Payments Protocol instances. It writes no
Solidity; `contracts/` holds the pinned artifacts and the re-verification recipe.

```bash
node scripts/preflight.mjs   # read-only prerequisite check — spends nothing
npm run setup                # deploy escrow + collectors, create wallets (idempotent)
node scripts/check-cpp.mjs   # 8 assertions on the wiring that was just deployed
```

`setup` is idempotent: values already present in `.env.local` cause the matching
stage to be skipped, so an interrupted run is resumed, not restarted.

**Run `check-cpp.mjs`.** Collectors bind the escrow as an `immutable`. One
pointed at the wrong escrow still deploys successfully and is then permanently
useless — the assertion is the only thing standing between that and a silent
dead end.

Chain constants, if you need them directly:

| Item | Value |
|---|---|
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| USDC | `0x3600…0000` — 6 decimals as ERC-20, **18 as native gas** |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

All of these are exported: `ARC_TESTNET_CHAIN_ID`, `USDC_ADDRESS`,
`EURC_ADDRESS`, `PERMIT2_ADDRESS`, `arcTestnet`, and more.

## 4. Run the demo

```bash
node scripts/demo-topup.mjs   # fund the buyer on a source chain + Gateway
npm run dev                   # → http://localhost:3000
```

The demo is a Next.js marketplace laid out as **four role columns**, each holding
only the authority that role really has:

- **Buyer** — signs ERC-3009 in MetaMask; never holds Arc gas.
- **Seller** — picks the wallet that receives the floor.
- **Host** — the release hook. Only the host releases or refunds.
- **Wallet Seller** — the CPN cash-out panel, signing with its own wallet.

`/sdk` is a second page driving the same SDK as a bare state machine with an
execution inspector — the fastest way to watch the lifecycle without the
marketplace framing. It has a wallet/bank toggle and has driven orders to
`COMPLETED` through it.

`demo/lib/rivokit.server.ts` is the **reference composition**. When the wiring
below is ambiguous, that file is the answer, and `scripts/live-sdk.mjs` proves
the same composition against the chain.

## 5. Integrate the SDK

`createRivoKit` is a **composition root, not a service**. It holds no keys and
opens no connections. Every dependency that needs a credential is injected —
that is what keeps the SDK out of custody of both funds and secrets.

```ts
import {
  createRivoKit, createEscrow, createSettlementFx, createBridge,
  createOrderStore, createComplianceGate, createCircleScreener,
  ARC_TESTNET_CHAIN_ID, USDC_ADDRESS,
} from "rivokit";

const kit = createRivoKit({
  store:  createOrderStore(SUPABASE_URL, SUPABASE_SECRET_KEY),
  escrow: createEscrow({ escrowAddress, publicClient, operator: operatorSender }),
  fx:     createSettlementFx({ kitKey, circleApiKey, circleEntitySecret }),
  bridge: createBridge(appKit),
  fund,                    // FundExecutor — see below
  payRebate,               // optional: returns the payer's surplus
  compliance: gate,        // optional but strongly recommended
  operatorGas,             // optional: () => Promise<bigint>
  payoutRail,              // optional: required for payoutTo: "bank"
  config: {
    chainId: ARC_TESTNET_CHAIN_ID,
    escrowAddress,
    operator:          OPERATOR_ADDRESS,
    token:             USDC_ADDRESS,
    refundCollector:   REFUND_COLLECTOR_ADDRESS,
    settlementAddress: MERCHANT_ADDRESS,   // receives capture, runs the swap
    screeningChain:    "ARC-TESTNET",
    feeBps: 25, feeReceiver: OPERATOR_ADDRESS,
    minOperatorGasWei: 500_000n * 10n ** 12n,
  },
});
```

### The three injections that matter

**`escrow.operator`** — a `Sender` that submits escrow calls. In the demo it is a
Circle developer-controlled wallet, polled to settlement:

```ts
const operatorSender = async ({ functionName, args }) => {
  const tx = await circle.contractExecution({
    walletId: OPERATOR_WALLET_ID,
    contractAddress: ESCROW,
    abiFunctionSignature: ESCROW_SIGNATURES[functionName],
    abiParameters: args.map(encodeArg),
  });
  return { txHash: await settleCircleTx(tx.id, functionName) };
};
```

**`fund`** — a `FundExecutor`. It moves the payer's USDC onto Arc and authorizes
it into escrow. It is injected because it needs the payer's signature and the
funding rail, both of which live in your environment:

```ts
const fund = async ({ paymentInfo, hash, signature }) => {
  const state = await escrow.getPaymentState(hash);
  // Idempotent. No new transaction, so no hash — never invent one, or the
  // facade writes it into a ledger row marked `confirmed`.
  if (state.hasCollectedPayment) return {};

  // Either relay a browser-wallet signature, or sign server-side (demo only).
  const sig = signature ?? await buyerWallet.signTypedData(
    receiveAuthorizationTypedData({
      paymentInfo, chainId: ARC_TESTNET_CHAIN_ID,
      escrowAddress: ESCROW, tokenCollector: TOKEN_COLLECTOR, usdcAddress: USDC_ADDRESS,
    }),
  );

  const auth = await escrow.authorize(paymentInfo, paymentInfo.maxAmount, TOKEN_COLLECTOR, sig);
  return { authorizeTxHash: auth.txHash };
};
```

Build the typed data with `receiveAuthorizationTypedData` and hand it to the
browser — that is the whole gasless path. The buyer signs; the operator pays Arc
gas; the operator fee, grossed *onto* the payer, is what reimburses it. The
seller's floor is never funded out of.

**`payRebate`** — returns the settlement surplus to the payer. **It must read
`token`.** A wallet-path surplus is EURC held by the merchant; a bank-path
surplus is USDC held by the seller. Ignoring the field sends the wrong asset out
of the wrong wallet, and only fails if the merchant happens to be short:

```ts
const payRebate = async ({ to, amountMinor, token }) => {
  if (token === "USDC") return sendSellerUsdc(to, amountMinor);
  return sendMerchantEurc(to, amountMinor);
};
```

Omit `payRebate` entirely and the rebate is still computed, stored and reported —
just not delivered, and the seller keeps the surplus.

> **Server-side only.** `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `KIT_KEY` and
> `CIRCLE_CPN_KEY` must never reach a browser bundle. The one thing that is safe
> client-side is the payer's own signing: the ERC-3009 typed data, and the
> funding rails that need only the payer's wallet.

## 6. The order lifecycle

```ts
const order = await kit.createOrder({
  payer, receiver,
  priceEURMinor: 2_500_000n,      // €25.00 guaranteed — minor units, always bigint
  receivingChain: "ARC-TESTNET",  // where a refund goes back to
  wedge: "delivery_confirmed",
  mode: "escrow",                 // or "direct" for an atomic charge
  bufferBps: 150,                 // overpay to absorb rate drift; returned as rebate
});

await kit.fund(order.id);                       // or { signature } from the browser
await kit.release(order.id, { kind: "delivery_confirmed", ... });

const state = await kit.status(order.id);       // → "released" | "paid_out" | …
```

Subscribe rather than poll:

```ts
kit.on("released",      ({ orderId, eurcOutMinor, rebateMinor }) => { … });
kit.on("payout_pending", ({ orderId, paymentId }) => { … });   // BROADCAST, not delivered
kit.on("paid_out",       ({ orderId }) => { … });              // terminal
```

**Invariants the SDK enforces for you:**

1. The recipient receives **≥ `priceEURMinor`**, or the swap reverts with funds safe.
2. Refunds always go to the recorded `receivingChain`.
3. `rebate = max(0, actualOutput − priceEURMinor)`.
4. ERC-3009 nonces are single-use.
5. Money is integer minor units — never a float.
6. Illegal state sequences are unrepresentable: a capture on an unfunded order is
   refused before it can reach the escrow and revert.
7. A CPN payment only moves forward; a duplicate or late webhook after a terminal
   state is ignored, not replayed.

## 7. Paying out to a bank

Add a `payoutRail` and set `payoutTo: "bank"`. Without a rail, `payoutTo: "bank"`
is refused at `createOrder` — the default build stays free of payout capability
rather than half-wired.

```ts
import { createCpnRamp, createCpnPayoutRail } from "rivokit";

const ramp = createCpnRamp({ apiKey: CIRCLE_CPN_KEY, corridor: EUR_SEPA });

const payoutRail = createCpnPayoutRail({
  ramp,
  corridor: "EUR-SEPA",
  destinationCountry: "FR",
  destinationScale: 2,
  senderAddress: SELLER_ADDRESS,     // holds the captured USDC AND signs the intent
  details: async (orderId) => ({     // usually a database read
    travelRule: [...], beneficiaryAccount: [...],
    useCase: "...", reasonForPayment: "PMT001",
  }),
  signIntent: (message) => sellerSigner.signTypedData(normalizeTypedData(message)),
  ensureAllowance: (amountMinor) => approvePermit2(amountMinor),
});
```

Then:

```ts
const order = await kit.createOrder({ …, payoutTo: "bank" });
await kit.fund(order.id);
await kit.release(order.id, proof);   // capture → quote → broadcast, one call
```

### Four things that will bite you here

**The order must pay the wallet that signs Permit2.** The off-ramp spends the
USDC that capture produced, so `receiver` has to be the seller's EOA — the
`senderAddress` above — not your merchant wallet. Pay somewhere else and the
payout finds nothing to pull from.

**Size from the rail, never from a percentage.** The USD/WIRE fee is a flat
~25 USDC — `BFI_TRANSACTION_FEE` measured at 25.018594 on a 62 USDC payment *and*
on a 42 USDC quote. The smaller the order, the more brutal it is proportionally.
`createOrder` already sizes bank orders from `PayoutRail.estimate()`; do not
second-guess it with a percentage buffer.

**Corridor minimums are enforced on the destination side.** So the USDC threshold
drifts with FX: 11 USDC was refused on a corridor that accepted 12 the same day
(error `290100`). Treat `limits()` as the authority, never a hard-coded floor.

**A payout row is born `pending`.** A broadcast returns before the transfer is
mined, so the Arc hash does not exist at write time — and it surfaces only in
CPN's `onChainTransactions[].transactionHash`. Settle the row with
`refreshPayout(orderId)` on a later read, or from a webhook. A host with neither
will accumulate stale `pending` rows.

Implement `PayoutRail` yourself to off-ramp somewhere RivoKit ships no client
for. The API key, the funds owner's signer and the beneficiary's PII are all
injected; the floor check stays in the SDK.

## 8. The standalone off-ramp

Cashing out an accumulated balance is a separate concern from settling one
order, so it has a separate entry point. This is why `cpn_payments.order_id` is a
nullable link rather than a foreign key the flow depends on.

```ts
const ramp = createCpnRamp({ apiKey: CIRCLE_CPN_KEY, corridor });

const quote   = await ramp.quote({ amountMinor });          // expires in ~30–60s
const prepared = await ramp.prepare({ …, quote });          // encrypts PII, moves nothing
const result  = await ramp.submit(prepared, signer);        // IRREVERSIBLE
const status  = await ramp.status(result.paymentId);
```

`prepare` is safe and reversible; `submit` is not, past `BROADCASTED`. Always
gate it behind an explicit confirmation.

When the funds owner signs in their **own browser wallet**, use `submitSigned`
instead — `submit` assumes the signer is reachable from wherever the API key
lives, which is true for a server key and false for a browser one:

```ts
const typedData  = normalizeTypedData(prepared.transaction.messageToBeSigned);
const signature  = await walletClient.signTypedData(typedData);   // in the browser
await ramp.submitSigned(prepared, signature);                     // on the server
```

That is the path proven from a zero Permit2 allowance: approve 15 USDC, spend it
on a 15 USDC → 12.95 EUR cash-out, allowance back to 0, row stamped
`signed_by: "wallet"`.

## 9. Webhooks

Verify before you trust — `verifyAndInterpretCpn` checks Circle's signature
before any reducer sees the body, and the reducers refuse to regress out of a
terminal state.

```ts
import { verifyAndInterpretCpn, applyCpnEventToStore } from "rivokit";

export async function POST(req: Request) {
  const raw   = await req.text();
  const event = await verifyAndInterpretCpn(raw, req.headers, resolvePublicKey);  // throws on a bad signature
  await applyCpnEventToStore(store, event);   // writes only when the state actually moved
  return new Response(null, { status: 200 });
}

export async function HEAD() {
  return new Response(null, { status: 200 });   // REQUIRED — see below
}
```

**Two things that are easy to get wrong and hard to diagnose:**

- **Export `HEAD`.** Circle v2 validates a subscription URL with `HEAD`, not an
  SNS handshake (that is the v1/Mint path). A route exporting only `POST` answers
  405 and the subscription is refused before hosting is even a question.
- **The public-key endpoint differs per product.** The signature scheme is
  shared; the path is not. Wallets/Contracts/Gateway live at
  `/v2/notifications/publicKey/{id}`, **CPN at
  `/v2/cpn/notifications/publicKey/{id}`**. Asking the wrong one returns 404, so
  every CPN webhook is refused `401 unverifiable` while the code still looks
  correct. Both authenticate with `CIRCLE_API_KEY`. Resolve with a fallback to
  the other product — the `webhooks.test` Circle fires at a brand-new
  subscription carries no `cpn.` prefix but belongs to the CPN subscription that
  triggered it, and repeated rejections disable the subscription.

CPN subscriptions are created from the **Console**, not the API:
`CIRCLE_CPN_KEY` returns `403` on `/v2/cpn/notifications/subscriptions` while
succeeding on `/v1/cpn/payments`. Because listing is 403 too, "no subscriptions"
from a script means nothing. The prerequisite you *can* check is `HEAD <url>` →
200 — the same thing Circle checks.

## 10. Going to production

Not a checklist for a demo. Each of these is load-bearing.

1. **The host must be an onboarded OFI** with CPN, plus KYB/AML on recipients.
   RivoKit is not a licensed operator and cannot be one for you.
2. **Separate the keys.** Deployer, operator and merchant are three distinct
   wallets. The hot operator key holds no deploy authority.
3. **Buyers sign in their own wallets.** `BUYER_PRIVATE_KEY` is a demo shortcut;
   the gasless ERC-3009 path is designed for exactly this replacement.
4. **Sellers sign their own cash-outs.** `submitSigned` exists so the wallet that
   *holds* the USDC is the one that authorizes it to leave.
5. **Run a durable webhook endpoint**, plus a scheduled sweep for the rows a
   missed webhook would otherwise strand: `refreshPayout` for a payout attached
   to an order, `reconcileCpnPayments` for a standalone cash-out, which belongs
   to no order and so is reachable by nothing else.
6. **Re-run `check-operator.mjs` after any collector redeploy.** The operator's
   USDC allowance is bound to the refund collector address — redeploy it and the
   allowance is 0 and `refund` reverts.
7. **Mainnet is out of scope** here: gated on audit, key timelock/multisig, legal
   review and OFI onboarding.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `fetch failed` or `CERT_HAS_EXPIRED` on any `*.circle.com` host | DNS hijack — including Circle's *documentation*. Call `installCircleDnsPinning()` (DoH via `1.1.1.1`, TLS still verified). **Never** disable TLS verification. |
| RPC errors around the third call | Public Arc RPCs rate-limit hard. Use `ARC_TESTNET_RPC_FALLBACKS` / `arcTransport()`, and design scripts to be *resumable*, not *repeatable*. |
| `PAYMENT_EXPIRED` (`PM09000`) | A CPN quote expired — they last ~30–60s. Prepare and submit without hesitating. |
| Broadcast fails immediately | The sender has not approved Permit2. Wire `ensureAllowance`. |
| `290100` on a payout | Below the corridor minimum *on the destination side*. Re-read `limits()`; the USDC threshold moves with FX. |
| `transaction_denied` with no `riskEvaluation` | A sandbox Mint account starts in Console **default-deny** with zero policies. Add one in Settings → Policies. Not a code problem. |
| `refund` reverts | The operator's USDC allowance is bound to the refund collector address. Re-run `node scripts/check-operator.mjs`. |
| Cross-chain move fails *after* the burn | One provider-backed adapter cannot serve both sides — it takes its chain from the provider. Use two chain-pinned views (`pinnedTo()` in `demo/app/wallet-rails.ts`). |
| A Gateway spend whose burn already landed | **Resume, never retry** — retrying burns twice. The error carries `recoverability: 'RESUMABLE'` plus the attestation and signature; call `gatewayMint(...)`. Simulate first: the attestation is single-use. |
| `.next` manifest corrupted | `next build demo` ran while `npm run dev` was live. Never run both. |
| A payout row stuck at `pending` | Expected until something reads the rail again. Call `refreshPayout(orderId)`, or run `scripts/live-payout-reconcile.mjs`. |
| A cash-out stuck at `CRYPTO_FUNDS_PENDING` | Its webhook never landed, and no order owns the row — so `refreshPayout` cannot see it. Run `scripts/live-cashout-reconcile.mjs`. |
| `156026: there is extra data provided in the message (0 < 4)` from Circle's typed-data signer | Circle wants the **canonical** EIP-712 JSON, with `EIP712Domain` declared in `types`. viem, wagmi and MetaMask all derive that entry and let you omit it, so a payload copied from this repo is rejected. The numbers name the cause: 4 fields in `domain`, 0 declared for them. Derive `EIP712Domain` from the domain rather than hardcoding it — Permit2 carries no `version`, and declaring a field with no value fails the same validator from the other side. `scripts/probe-circle-eoa-sign.mjs`. |
| A Circle wallet's signature is rejected by USDC, CPN or Gateway | It is almost certainly `accountType: "SCA"`, which signs for ERC-1271 — validated by calling the account contract, while all three of those recover an ECDSA signer instead. It does not fail loudly: the reply is still 65 bytes and still recovers, just to an unrelated address and a different one per message, because the owner key signed a wrapped replay-safe hash. Check *who* recovered, never the length. The type is fixed at creation; make a new wallet with `accountType: "EOA"`. Roles that only execute contracts (operator, merchant) are unaffected. `scripts/probe-circle-eoa-sign.mjs`. |
| An action refuses with "requires the demo to be unlocked" | This deployment has `DEMO_WRITE_KEY` set, so the lock is on. Enter it in the header's Unlock control. Unset the variable and the demo runs open instead — the per-action caps apply either way. |
| An amount refuses as "above this demo's per-action ceiling" | The cap, which applies whether or not you are unlocked. Raise `DEMO_CAP_TOKEN_MINOR` / `DEMO_CAP_FIAT_MINOR` only if that size is genuinely intended. |
| An order stuck at `settlement_pending` | Captured but not converted; the funds are safe with the receiver as USDC. Read `order.failureReason`, then call `retrySettlement(orderId)` — **not** `release()`, which would capture a second time. |

More context on any of these: [ARCHITECTURE.md](ARCHITECTURE.md) for why the
design is shaped this way, [LIMITATIONS.md](LIMITATIONS.md) for what is not
proven, [PROOFS.md](PROOFS.md) for what is.
