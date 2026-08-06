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

/** What one source chain holds inside Gateway, for this depositor. */
export type UbChainBalance = {
  /** App Kit's chain name, e.g. "Ethereum_Sepolia" — what an allocation names. */
  chain: string;
  confirmedMinor: bigint;
  pendingMinor: bigint;
};

export type UbBalance = {
  /** Spendable now — deposits observed to a safe depth. */
  confirmedMinor: bigint;
  /** Deposited but not yet spendable. */
  pendingMinor: bigint;
  /**
   * The same money, split by the chain it was deposited from.
   *
   * The total above is chain-abstracted and a spend is NOT: every burn intent
   * names a source chain, so what a rail can actually draw is decided here. A UI
   * that shows only the total, over a spend pinned to one chain, reports a
   * balance the transfer cannot reach — which is exactly the contradiction
   * "Available: 0 USDC" on a wallet showing a positive Gateway balance.
   */
  byChain: UbChainBalance[];
  raw: unknown;
};

/** One chain's contribution to a spend. */
export type UbAllocation = { chain: string; amountMinor: bigint };

/**
 * Gateway's own fee for a spend, per burn intent, in USDC minor units.
 *
 * Charged ON TOP of the burned value and taken from the SAME source balance:
 * spending 12.208313 from a chain holding exactly that much is refused with
 * "available 12.208313, required 13.208313". Observed at 1.000000 USDC per
 * intent on testnet — hence a reserve, not an exact figure, and hence a plan
 * that prefers few chains: each extra chain is another intent and another fee.
 */
export const GATEWAY_SPEND_FEE_MINOR = 1_000_000n;

/** The unified balance exists but cannot be reached in the shape a spend needs. */
export class GatewayBalanceShortError extends Error {
  readonly code = "GATEWAY_BALANCE_SHORT";
  readonly requiredMinor: bigint;
  readonly usableMinor: bigint;
  readonly byChain: readonly UbChainBalance[];

  constructor(requiredMinor: bigint, usableMinor: bigint, byChain: readonly UbChainBalance[]) {
    const per = byChain
      .filter((b) => b.confirmedMinor > 0n)
      .map((b) => `${b.chain} ${toDecimalString(b.confirmedMinor)}`)
      .join(", ");
    super(
      `Gateway balance cannot cover ${toDecimalString(requiredMinor)} USDC plus its per-chain spend fee. ` +
        `Usable: ${toDecimalString(usableMinor)} USDC${per ? ` (confirmed: ${per})` : " (nothing confirmed)"}. ` +
        "Deposit more into Gateway, or fund from a chain that already holds it.",
    );
    this.name = "GatewayBalanceShortError";
    this.requiredMinor = requiredMinor;
    this.usableMinor = usableMinor;
    this.byChain = byChain;
  }
}

/**
 * Decide which chains a spend draws from, and how much from each.
 *
 * Pure, so the rule is testable without a network: take the preferred chain
 * first (the one the payer picked, whose balance the UI was showing), then the
 * largest remaining balances until the amount is covered. Each chain keeps
 * `feeMinor` back, because Gateway adds its fee to the burn rather than taking
 * it out of it, and it charges once per intent — which is why the fewest chains
 * that can do the job is also the cheapest.
 *
 * Throws rather than returning a short plan: a partial allocation is rejected by
 * Gateway anyway, and rejecting here costs nothing while rejecting there costs
 * a round trip and reads as a balance error the payer cannot act on.
 */
export function planAllocations(
  balances: readonly UbChainBalance[],
  amountMinor: bigint,
  opts: { prefer?: string | undefined; feeMinor?: bigint } = {},
): UbAllocation[] {
  const fee = opts.feeMinor ?? GATEWAY_SPEND_FEE_MINOR;
  // A chain holding no more than the fee cannot contribute anything at all.
  const usable = balances
    .filter((b) => b.confirmedMinor > fee)
    .sort((a, b) => {
      if (opts.prefer) {
        if (a.chain === opts.prefer) return -1;
        if (b.chain === opts.prefer) return 1;
      }
      return a.confirmedMinor > b.confirmedMinor ? -1 : a.confirmedMinor < b.confirmedMinor ? 1 : 0;
    });

  const plan: UbAllocation[] = [];
  let remaining = amountMinor;
  for (const b of usable) {
    if (remaining <= 0n) break;
    const take = b.confirmedMinor - fee < remaining ? b.confirmedMinor - fee : remaining;
    plan.push({ chain: b.chain, amountMinor: take });
    remaining -= take;
  }

  if (remaining > 0n) {
    const usableTotal = usable.reduce((sum, b) => sum + (b.confirmedMinor - fee), 0n);
    throw new GatewayBalanceShortError(amountMinor, usableTotal, balances);
  }
  return plan;
}

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
   *
   * Only correct when that ONE chain holds the whole amount plus the fee. Where
   * it might not, pass `allocations` (see `planAllocations`) instead: the
   * unified balance is spread across the chains it was deposited from, and
   * naming one of them is how a spend gets refused against a balance the UI is
   * showing as available.
   */
  fromChain?: string;
  /**
   * Explicit per-chain allocations, summing to `amountMinor`. Takes precedence
   * over `fromChain`. One adapter can carry all of them: an EVM burn intent is
   * chain-agnostic (its EIP-712 domain has no `chainId`), so App Kit batches
   * every intent from one adapter into a single signature.
   */
  allocations?: readonly UbAllocation[];
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
      // Summed per chain across depositors: `sources` can name more than one
      // account, and two accounts holding a balance on the same chain are one
      // pot as far as an allocation is concerned.
      const perChain = new Map<string, UbChainBalance>();
      const depositors: Array<Record<string, any>> = r.breakdown ?? [];
      for (const d of depositors) {
        for (const c of (d.breakdown ?? []) as Array<Record<string, any>>) {
          pending += toMinor(c.pendingBalance);
          const chain = String(c.chain);
          const row = perChain.get(chain) ?? { chain, confirmedMinor: 0n, pendingMinor: 0n };
          row.confirmedMinor += toMinor(c.confirmedBalance);
          row.pendingMinor += toMinor(c.pendingBalance);
          perChain.set(chain, row);
        }
      }
      return {
        confirmedMinor: confirmed,
        pendingMinor: pending,
        byChain: [...perChain.values()],
        raw: res,
      };
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
      // testnet balance and reports BALANCE_INSUFFICIENT. `allocations` wins
      // over `fromChain`: the plan already knows where the money is, and the
      // single-chain shorthand is only a plan of one.
      if (params.allocations?.length) {
        from.allocations = params.allocations.map((a) => ({
          amount: toDecimalString(a.amountMinor),
          chain: a.chain,
        }));
      } else if (params.fromChain) {
        from.allocations = [{ amount, chain: params.fromChain }];
      }
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
