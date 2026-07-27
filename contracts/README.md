# Contracts - Commerce Payments Protocol (pinned)

The escrow + ERC-3009 token collector this app deploys to Arc Testnet. Arc
addresses and ABIs are pinned to a protocol commit so the app builds against a
single, fixed version.

## Provenance

- **Source:** https://github.com/base/commerce-payments
- **Pinned commit:** `3f77761cf8b174fdc456a275a9c64919eda44234`
- **Compiler:** solc `0.8.29`, `evm_version = "cancun"`, `via_ir = true`,
  `optimizer_runs = 100000` (the repo's `[profile.deploy]`).

## What we deploy

Three contracts, in this order — the collectors take the escrow address, so the
escrow must exist first.

| Contract | Constructor args | Creation size |
|----------|------------------|---------------|
| `AuthCaptureEscrow` | none (deploys its own `TokenStore`) | ~12.0 KB |
| `ERC3009PaymentCollector` | `(authCaptureEscrow, multicall3)` | ~4.2 KB |
| `OperatorRefundCollector` | `(authCaptureEscrow)` | ~1.0 KB |

`ERC3009PaymentCollector` is the token collector used here: the shopper signs an
ERC-3009 `transferWithAuthorization` and the operator relays it. The Permit2 /
SpendPermission / PreApproval collectors are not deployed.

`OperatorRefundCollector` funds refunds from the **operator's own** balance, not
from escrow — so the operator must hold a USDC allowance for it or `refund`
reverts. That is why a refund costs the operator far more than a void.

Both collectors store the escrow as an `immutable`, so a collector deployed
against the wrong escrow still deploys successfully and is then permanently
useless. All three addresses must come from the same setup run;
`scripts/check-cpp.mjs` verifies the wiring explicitly rather than assuming it.

## Arc EVM compatibility (verified 2026-06-10)

Arc Testnet targets the **Osaka** hardfork - newer than Cancun - so it supports
PUSH0, transient storage (TSTORE/TLOAD), and MCOPY. The escrow uses solady's
`ReentrancyGuardTransient` (override forces transient storage on all chains);
this runs fine on Arc. **Deploy compiled with `cancun`, no source changes.**

> The Circle SCP skill's "compile with `evmVersion: paris` to avoid PUSH0 on
> Arc" note is **stale** for current (Osaka) Arc. Do not downgrade - a paris
> compile also fails because the unused SpendPermission/Permit2 collectors
> require the `transient` keyword.

## Dependency on Arc

- **Multicall3** `0xcA11bde05977b3631167028862bE2a173976CA11` - confirmed present
  on Arc Testnet; passed to the collector constructor.

## Artifacts

`artifacts/*.json` hold `{ abi, bytecode }` for each contract, consumed by
`scripts/setup.mjs` (deploy). The app-side ABI is separate and hand-narrowed:
`src/escrow/abi.ts` exports only the escrow functions the SDK actually calls.
Regenerate the artifacts by building the pinned source with
`FOUNDRY_PROFILE=deploy forge build --evm-version cancun` and copying
`out/<C>.sol/<C>.json`.

No Solidity source lives in this repo — only these compiled artifacts. RivoKit
writes no contracts of its own; it deploys its own instances of the pinned
upstream protocol.

## Source verification (Arc Testnet, 2026-07-27)

Every deployed contract is source-verified on the Arc Testnet Blockscout
explorer, as a *full* match — the on-chain creation bytecode reproduces
byte-for-byte from the pinned commit with the settings above.

| Contract | Address |
|----------|---------|
| `AuthCaptureEscrow` | [`0x6bfd1895…700253`](https://testnet.arcscan.app/address/0x6bfd1895d519d2ec936038824b8c7ab4ff700253) |
| `ERC3009PaymentCollector` | [`0x1a9cb462…fb77b0`](https://testnet.arcscan.app/address/0x1a9cb4622e0b2985a6e2a6a3f5be613309fb77b0) |
| `OperatorRefundCollector` | [`0x6d6d512e…70ab32`](https://testnet.arcscan.app/address/0x6d6d512e3a0d26d22a69127b98460001ef70ab32) |
| `TokenStore` (deployed by the escrow) | [`0x5f903018…52997D`](https://testnet.arcscan.app/address/0x5f9030187dc31551E7B37d5343207FaeC752997D) |

Reproduce: build the pinned source with `FOUNDRY_PROFILE=deploy forge build
--evm-version cancun --use 0.8.29`, then submit the standard-JSON input to
`POST /api/v2/smart-contracts/<address>/verification/via/standard-input`.
Note that `forge --show-standard-json-input` emits `optimizer.enabled: false`
regardless of the profile — patch it to `{enabled: true, runs: 100000}` before
submitting, or the match fails.

The `OperatorRefundCollector` address above is a **redeploy**. The artifact
previously checked in here (creation 1185 B) did not reproduce from the pinned
commit — its provenance could not be established, so the collector was rebuilt
from `3f77761` (creation 980 B) and redeployed. The old instance
`0x5080a2a2…af6f4` is abandoned; it was only ever reachable from the refund
path, and the operator's USDC allowance now points at the new one.
