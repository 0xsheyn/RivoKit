/**
 * Settlement FX — quote-lock and floored swap.
 *
 * The floor is the whole point. `stopLimit` tells the service the minimum
 * tokenOut it may deliver; below that the swap does not partially fill, it
 * fails, and the funds stay where they were. That is what lets RivoKit promise
 * the recipient "at least €P or nothing happens" (CLAUDE.md §0.4) instead of
 * "roughly €P, we hope".
 *
 * Shape follows circlefin/arc-stablecoin-fx:
 *   - `new AppKit()` takes NO arguments; the kit key travels in `config`
 *   - the adapter is built from Circle API credentials, and the wallet address
 *     is passed per call in `from.address`
 *   - amounts crossing this boundary are decimal strings, never minor units
 *     (see units.ts — App Kit's "1000000" means a million tokens)
 */
import { AppKit, SwapChain } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";
import {
  computeRebate,
  fromDecimalString,
  toDecimalString,
  usdcAmountFromQuote,
} from "./units.ts";

export type FxToken = "USDC" | "EURC";

export type SettlementFxConfig = {
  kitKey: string;
  circleApiKey: string;
  circleEntitySecret: string;
  chain?: SwapChain;
  /** Integrator fee, in bps. PRD §9 defaults this to 25. */
  appFeeBps?: number;
  appFeeRecipient?: string;
};

export type Quote = {
  amountInMinor: bigint;
  amountOutMinor: bigint;
  /** Service's own floor, derived from slippageBps unless overridden. */
  stopLimitMinor: bigint | null;
  /**
   * Fees as App Kit reports them. `amount` is nullable there — a fee can be
   * declared without a figure — so it stays nullable here rather than being
   * coerced to "0", which would understate cost.
   */
  fees: ReadonlyArray<{ token: string; amount: string | null; type: string }>;
};

export type FlooredSwapResult = {
  amountOutMinor: bigint;
  txHash?: string;
  /** max(0, amountOut − floor). PRD §10 invariant 6. */
  rebateMinor: bigint;
};

export class FloorNotMetError extends Error {
  readonly code = "FLOOR_NOT_MET";
  readonly floorMinor: bigint;

  constructor(floorMinor: bigint, cause: unknown) {
    super(
      `Swap tidak mencapai floor ${toDecimalString(floorMinor)}. ` +
        "Dana TIDAK berpindah — aman di tempat semula.",
    );
    this.name = "FloorNotMetError";
    this.floorMinor = floorMinor;
    this.cause = cause;
  }
}

export class NoRouteError extends Error {
  readonly code = "NO_ROUTE";
  readonly pair: string;

  constructor(tokenIn: FxToken, tokenOut: FxToken, cause: unknown) {
    super(
      `Tidak ada rute ${tokenIn}→${tokenOut}. StableFX berbasis RFQ: ini berarti ` +
        "tak ada maker melayani arah tersebut, bukan galat konfigurasi.",
    );
    this.name = "NoRouteError";
    this.pair = `${tokenIn}->${tokenOut}`;
    this.cause = cause;
  }
}

const isNoRoute = (e: unknown): boolean =>
  /no route available|UNSUPPORTED_ROUTE/i.test(String((e as Error)?.message ?? e));

const isFloorMiss = (e: unknown): boolean =>
  /stop ?limit|slippage|insufficient output|price impact/i.test(
    String((e as Error)?.message ?? e),
  );

export function createSettlementFx(config: SettlementFxConfig) {
  const chain = config.chain ?? SwapChain.Arc_Testnet;
  const kit = new AppKit();
  const adapter = createCircleWalletsAdapter({
    apiKey: config.circleApiKey,
    entitySecret: config.circleEntitySecret,
  });

  const baseFrom = (address: string) => ({ adapter, chain, address });

  return {
    /**
     * Quote without executing.
     *
     * Quote at a size close to the real order. Rates move sharply with size on
     * thin testnet liquidity — measured 1.488 at one unit versus 1.028 at a
     * million, so a rate sampled at 1 unit is not a rate.
     */
    async quote(params: {
      address: string;
      tokenIn: FxToken;
      tokenOut: FxToken;
      amountInMinor: bigint;
    }): Promise<Quote> {
      try {
        const est = await kit.estimateSwap({
          from: baseFrom(params.address),
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: toDecimalString(params.amountInMinor),
          config: { kitKey: config.kitKey },
        });

        return {
          amountInMinor: params.amountInMinor,
          amountOutMinor: fromDecimalString(est.estimatedOutput.amount),
          stopLimitMinor: est.stopLimit ? fromDecimalString(est.stopLimit.amount) : null,
          fees: est.fees ?? [],
        };
      } catch (e) {
        if (isNoRoute(e)) throw new NoRouteError(params.tokenIn, params.tokenOut, e);
        throw e;
      }
    },

    /**
     * Lock the payer's amount at checkout.
     *
     * Quotes the settlement direction, then inverts to find how much tokenIn
     * clears `priceOutMinor`, plus a buffer. The buffer absorbs rate drift
     * between checkout and settlement and is the source of any rebate.
     */
    async lockQuote(params: {
      address: string;
      tokenIn: FxToken;
      tokenOut: FxToken;
      priceOutMinor: bigint;
      bufferBps: number;
      /** Probe size; use something near the expected order value. */
      probeInMinor: bigint;
    }): Promise<{ amountInMinor: bigint; quote: Quote }> {
      const quote = await this.quote({
        address: params.address,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountInMinor: params.probeInMinor,
      });

      const amountInMinor = usdcAmountFromQuote(
        params.priceOutMinor,
        { usdcInMinor: quote.amountInMinor, eurcOutMinor: quote.amountOutMinor },
        params.bufferBps,
      );

      return { amountInMinor, quote };
    },

    /**
     * Execute with an explicit floor.
     *
     * `floorOutMinor` becomes `stopLimit`. Pass the guaranteed price — not a
     * slippage-derived number — or the guarantee is only as strong as the
     * default 300 bps tolerance.
     */
    async swapWithFloor(params: {
      address: string;
      tokenIn: FxToken;
      tokenOut: FxToken;
      amountInMinor: bigint;
      floorOutMinor: bigint;
      slippageBps?: number;
    }): Promise<FlooredSwapResult> {
      const swapConfig: Record<string, unknown> = {
        kitKey: config.kitKey,
        slippageBps: params.slippageBps ?? 300,
        stopLimit: toDecimalString(params.floorOutMinor),
      };

      if (config.appFeeBps && config.appFeeRecipient) {
        swapConfig.customFee = {
          percentageBps: config.appFeeBps,
          recipientAddress: config.appFeeRecipient,
        };
      }

      const call = (extra: Record<string, unknown> = {}) =>
        kit.swap({
          from: baseFrom(params.address),
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: toDecimalString(params.amountInMinor),
          config: { ...swapConfig, ...extra },
        });

      let result;
      try {
        result = await call();
      } catch (e) {
        // A counterfactual Circle smart wallet cannot produce an EIP-1271
        // signature before it exists on-chain. Falling back to an on-chain
        // approval deploys it as a side effect of the first transaction.
        if (/undeployed wallet/i.test(String((e as Error)?.message ?? e))) {
          result = await call({ allowanceStrategy: "approve" });
        } else if (isNoRoute(e)) {
          throw new NoRouteError(params.tokenIn, params.tokenOut, e);
        } else if (isFloorMiss(e)) {
          throw new FloorNotMetError(params.floorOutMinor, e);
        } else {
          throw e;
        }
      }

      const amountOutMinor = fromDecimalString(String(result.amountOut ?? "0"));

      // Belt and braces: the service should never settle below stopLimit, but
      // the floor is the product promise, so verify rather than trust.
      if (amountOutMinor < params.floorOutMinor) {
        throw new FloorNotMetError(params.floorOutMinor, result);
      }

      return {
        amountOutMinor,
        txHash: result.txHash,
        rebateMinor: computeRebate(amountOutMinor, params.floorOutMinor),
      };
    },
  };
}

export type SettlementFx = ReturnType<typeof createSettlementFx>;
