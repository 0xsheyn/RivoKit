/**
 * Money adalah objek kelas satu. `amount` SELALU string desimal —
 * jangan pernah float untuk uang (CLAUDE.md § Konvensi).
 */
export type Currency = "USD" | "EUR";

/** Bentuk uang: on-chain stablecoin, atau fiat di rekening bank. */
export type Form = "stablecoin" | "fiat";

export interface Money {
  readonly amount: string;
  readonly currency: Currency;
}

/** Titik dalam graf routing: (mata uang × bentuk × lokasi). */
export interface MoneyState {
  readonly currency: Currency;
  readonly form: Form;
  /** `"arc"` = hub; chain lain = spoke; `"bank"` = di luar chain. */
  readonly location: string;
}

/** Preferensi akun — menentukan rute yang dipilih Planner. */
export interface Preference {
  readonly currency: Currency;
  readonly form: Form;
}

/** USDC/EURC = 6 desimal untuk display. */
export const DISPLAY_DECIMALS = 6;

const AMOUNT_RE = /^-?\d+(\.\d+)?$/;

export function isValidAmount(amount: string): boolean {
  return AMOUNT_RE.test(amount);
}

export function money(amount: string, currency: Currency): Money {
  if (!isValidAmount(amount)) {
    throw new Error(`Invalid Money amount: ${amount}`);
  }
  return { amount, currency };
}
