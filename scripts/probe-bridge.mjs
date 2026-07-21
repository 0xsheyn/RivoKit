// What does kit.bridge() actually return, and does it need an event handler?
import { readFileSync } from "node:fs";
import { AppKit, BridgeChain } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";

const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && m[2]) env[m[1]] = m[2];
}

const kit = new AppKit();

// App Kit exposes on/off — a bridge probably reports progress through them,
// which would explain an instant "success" with nothing moved.
for (const evt of ["*", "bridge", "transaction", "step", "progress", "error", "action"]) {
  try {
    kit.on(evt, (...a) => {
      console.log(`  [event ${evt}]`, JSON.stringify(a, (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 300));
    });
  } catch {
    /* event name not supported */
  }
}

const arcAdapter = createViemAdapterFromPrivateKey({
  privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Arc_Testnet,
});
const sepoliaAdapter = createViemAdapterFromPrivateKey({
  privateKey: env.BUYER_PRIVATE_KEY, chain: BridgeChain.Ethereum_Sepolia,
});

console.log("memanggil kit.bridge() dengan 1 USDC...\n");
const t0 = Date.now();
let res;
try {
  res = await kit.bridge({
    from: { adapter: arcAdapter, chain: BridgeChain.Arc_Testnet },
    to: { adapter: sepoliaAdapter, chain: BridgeChain.Ethereum_Sepolia },
    amount: "1",
    config: { kitKey: env.KIT_KEY },
  });
} catch (e) {
  console.log("THROW:", e?.code, String(e?.message).slice(0, 300));
  process.exit(1);
}

console.log(`\nselesai dalam ${Math.round((Date.now() - t0) / 1000)} detik`);
console.log("tipe   :", typeof res);
console.log("keys   :", res && typeof res === "object" ? Object.keys(res).join(", ") : "(bukan objek)");
console.log("\nisi lengkap:");
console.log(JSON.stringify(res, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)?.slice(0, 2000));

// If it returned a handle with methods, list them.
if (res && typeof res === "object") {
  const proto = Object.getPrototypeOf(res);
  const methods = proto ? Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor") : [];
  if (methods.length) console.log("\nmetode pada hasil:", methods.join(", "));
}
