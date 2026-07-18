# adapters

Implementasi konkret dari `../ports`. Satu file per vendor-primitif:

| File | Port | Vendor |
|---|---|---|
| `circle-wallets.ts` | `WalletPort` | Circle Wallets (SCA) + passkey |
| `circle-stablefx.ts` | `FxPort` | StableFX (TEST env → mock data; magic numbers `23.66`/`23.67`) |
| `circle-cpn.ts` | `RampPort` | CPN off-ramp (sandbox + magic values) |
| `circle-paymaster.ts` | `GasPort` | Paymaster / Gas Station |
| `circle-bridge.ts` | `BridgePort` | App Kit / CCTP (Arc domain `26`) |
| `arc-chain.ts` | `ChainPort` | viem + Arc RPC |
| `escrow-contract.ts` | `EscrowContractPort` | kontrak escrow + CREATE2 factory |

**Aturan:** logika keputusan TIDAK boleh hidup di sini — adapter hanya menerjemahkan
port ke API vendor. Planner/Saga tetap vendor-agnostik.
