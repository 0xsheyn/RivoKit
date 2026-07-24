/**
 * Unified balance — the fast funding path.
 *
 * Circle Gateway holds a chain-abstracted USDC balance: deposit once from any
 * supported chain, then spend it straight onto another chain in one step. Where
 * a payer already has a Gateway balance this is how RivoKit funds an order (PRD
 * §M2), because it settles in well under a second — no CCTP burn/attest/mint
 * wait. Bridging (see ./bridge.ts) is the fallback for payers who do not.
 *
 * Two things are worth stating plainly:
 *
 *   - Deposit is not instantly spendable. Gateway credits the balance only once
 *     the source-chain deposit is observed to a safe depth, so a deposit must be
 *     followed by polling `getBalances` until the amount is confirmed, not
 *     pending. Spending against a not-yet-confirmed deposit fails.
 *
 *   - Spend mints to an ADDRESS, not into the escrow. It cannot register a CPP
 *     payment on its own — that still needs the payer's ERC-3009 signature and
 *     the operator's `authorize`. So the funding shape is: spend → mint to the
 *     payer on Arc → authorize into escrow, exactly the tail of ./bridge.ts's
 *     flow, only reached far faster. Minting directly to the escrow address
 *     would move tokens with no payment recorded against them — never do that.
 *
 * Unified balance needs no kit key.
 */
import { AppKit } from "@circle-fin/app-kit";
import { toDecimalString } from "../settlement-fx/units.ts";

export type UbAdapter = unknown;

export type UbBalance = {
  /** Spendable now — deposits observed to a safe depth. */
  confirmedMinor: bigint;
  /** Deposited but not yet spendable. */
  pendingMinor: bigint;
  raw: unknown;
};

export type DepositParams = {
  adapter: UbAdapter;
  chain: string;
  amountMinor: bigint;
  token?: "USDC" | "EURC";
};

export type SpendParams = {
  fromAdapter: UbAdapter;
  /**
   * Pull the whole amount from this chain's Gateway balance. Without it the SDK
   * auto-allocates, which on testnet fails to find the balance and reports
   * BALANCE_INSUFFICIENT — so name the source chain explicitly.
   */
  fromChain?: string;
  /** Where to mint. Defaults to the destination adapter's own address. */
  toAdapter: UbAdapter;
  toChain: string;
  /** Override the mint recipient — e.g. the payer, ahead of `authorize`. */
  recipientAddress?: string;
  amountMinor: bigint;
  token?: "USDC" | "EURC";
};

const toMinor = (decimal: string | undefined): bigint => {
  if (!decimal) return 0n;
  const parts = decimal.split(".");
  const whole = parts[0] || "0";
  const micros = ((parts[1] ?? "") + "000000").slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(micros || "0");
};

type UbApi = {
  getBalances: (params: unknown) => Promise<unknown>;
  deposit: (params: unknown) => Promise<unknown>;
  spend: (params: unknown) => Promise<unknown>;
};

export function createUnifiedBalance(kit: AppKit = new AppKit()) {
  const ub = (kit as unknown as { unifiedBalance: UbApi }).unifiedBalance;

  return {
    /**
     * Confirmed + pending USDC across the sources an adapter can see. `pending`
     * is what a just-submitted deposit shows as until it finalizes.
     */
    async getBalance(adapter: UbAdapter, token: "USDC" | "EURC" = "USDC"): Promise<UbBalance> {
      const res = await ub.getBalances({
        token,
        sources: { adapter },
        includePending: true,
        networkType: "testnet",
      });
      const r = res as Record<string, any>;
      // Shape (SDK 1.10): { totalConfirmedBalance, breakdown: [ { totalConfirmed,
      // breakdown: [ { chain, confirmedBalance, pendingBalance } ] } ] }. The
      // top-level total is authoritative for confirmed; pending only appears on
      // the innermost per-chain entries, so sum those.
      const confirmed = toMinor(r.totalConfirmedBalance ?? r.confirmedBalance);
      let pending = 0n;
      const depositors: Array<Record<string, any>> = r.breakdown ?? [];
      for (const d of depositors) {
        for (const c of (d.breakdown ?? []) as Array<Record<string, any>>) {
          pending += toMinor(c.pendingBalance);
        }
      }
      return { confirmedMinor: confirmed, pendingMinor: pending, raw: res };
    },

    /**
     * Deposit into Gateway. Resolves when the deposit tx is mined — NOT when the
     * balance is spendable. Poll `getBalance` for the confirmed amount before
     * spending.
     */
    async deposit(params: DepositParams): Promise<{ txHash: string; raw: unknown }> {
      const res = await ub.deposit({
        from: { adapter: params.adapter, chain: params.chain },
        amount: toDecimalString(params.amountMinor),
        token: params.token ?? "USDC",
      } as never);
      return { txHash: (res as Record<string, any>).txHash, raw: res };
    },

    /**
     * Spend from the unified balance, minting USDC on the destination chain.
     * Sub-second when the balance is confirmed. `recipientAddress` aims the mint
     * at the payer so the usual `authorize` can then pull it into escrow.
     */
    async spend(params: SpendParams): Promise<{ txHash: string; recipientAddress: string; raw: unknown }> {
      const to: Record<string, unknown> = { adapter: params.toAdapter, chain: params.toChain };
      if (params.recipientAddress) to.recipientAddress = params.recipientAddress;
      const amount = toDecimalString(params.amountMinor);
      const from: Record<string, unknown> = { adapter: params.fromAdapter };
      // Explicit allocation avoids the SDK's auto-allocator, which misses the
      // testnet balance and reports BALANCE_INSUFFICIENT.
      if (params.fromChain) from.allocations = [{ amount, chain: params.fromChain }];
      // App Kit's spend uses `amount` (human-readable decimal), NOT the
      // provider-level `amountIn`; passing amountIn leaves amount unset and the
      // SDK rejects it as "Invalid amount 'unknown'".
      const res = await ub.spend({ from, to, token: params.token ?? "USDC", amount } as never);
      const r = res as Record<string, any>;
      return { txHash: r.txHash, recipientAddress: r.recipientAddress, raw: res };
    },
  };
}

export type UnifiedBalance = ReturnType<typeof createUnifiedBalance>;
