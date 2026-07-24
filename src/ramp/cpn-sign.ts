/**
 * Sign a CPN onchain transaction's payment intent.
 *
 * createTransaction returns `messageToBeSigned`: an EIP-712 typed-data object
 * (Permit2 `PermitWitnessTransferFrom`) that authorizes the settlement contract
 * to pull the sender's USDC. The funds owner signs it locally; the signature is
 * submitted back and CPN broadcasts. Only the sender's key can produce it — CPN
 * never holds it.
 *
 * CPN serializes the typed data as JSON, which does not survive a direct handoff
 * to viem: numbers arrive as decimal strings, `chainId` is a string, and the
 * `types` map includes the `EIP712Domain` entry viem derives itself. This module
 * normalizes those before signing — coercing every uint/int field to bigint per
 * the type map (recursing into struct fields like the Permit2 witness), turning
 * chainId into a number, and dropping EIP712Domain — so the recovered signer
 * matches and the settlement contract accepts the signature.
 */
import type { Account, Hex } from "viem";

export type Eip712Field = { name: string; type: string };
export type Eip712Types = Record<string, Eip712Field[]>;
export type Eip712Domain = {
  name?: string;
  version?: string;
  chainId?: string | number;
  verifyingContract?: string;
};
export type MessageToBeSigned = {
  domain: Eip712Domain;
  message: Record<string, unknown>;
  primaryType: string;
  types: Eip712Types;
};

const isIntType = (t: string): boolean => /^u?int\d*$/.test(t);

/** Coerce one value to what viem expects for its EIP-712 `type`. */
function coerceValue(value: unknown, type: string, types: Eip712Types): unknown {
  const arrayMatch = /^(.*)\[\d*\]$/.exec(type);
  if (arrayMatch) {
    const inner = arrayMatch[1] as string;
    return Array.isArray(value) ? value.map((v) => coerceValue(v, inner, types)) : value;
  }
  if (isIntType(type)) {
    // JSON gives these as decimal strings or numbers; viem wants bigint.
    return typeof value === "bigint" ? value : BigInt(value as string | number);
  }
  if (types[type] && value !== null && typeof value === "object") {
    return coerceStruct(value as Record<string, unknown>, type, types);
  }
  // address, bytes*, bool, string — already the right JS type.
  return value;
}

/** Rebuild a struct's fields in type order, coercing each. */
function coerceStruct(
  obj: Record<string, unknown>,
  typeName: string,
  types: Eip712Types,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of types[typeName] ?? []) out[f.name] = coerceValue(obj[f.name], f.type, types);
  return out;
}

export type NormalizedTypedData = {
  domain: Record<string, unknown>;
  types: Eip712Types;
  primaryType: string;
  message: Record<string, unknown>;
};

/**
 * Turn CPN's JSON messageToBeSigned into a viem-ready typed-data object. Pure —
 * unit-tested by signing then recovering the signer address.
 */
export function normalizeTypedData(m: MessageToBeSigned): NormalizedTypedData {
  const { EIP712Domain: _omitDomain, ...types } = m.types;
  const domain: Record<string, unknown> = { ...m.domain };
  if (domain.chainId !== undefined && domain.chainId !== null) domain.chainId = Number(domain.chainId);
  const message = coerceStruct(m.message, m.primaryType, types);
  return { domain, types, primaryType: m.primaryType, message };
}

/**
 * Sign the payment intent with the funds owner's account (e.g. a viem local
 * account). Returns the 65-byte EIP-712 signature to submit as
 * `signedTransaction`.
 */
export async function signPaymentIntent(account: Account, m: MessageToBeSigned): Promise<Hex> {
  if (!account.signTypedData) {
    throw new Error("signPaymentIntent: account tidak mendukung signTypedData");
  }
  const t = normalizeTypedData(m);
  // viem's typed-data generics can't infer over our runtime-shaped object; the
  // sign→recover round-trip test (cpn-sign.test.ts) guards correctness instead.
  return account.signTypedData({
    domain: t.domain,
    types: t.types,
    primaryType: t.primaryType,
    message: t.message,
  } as never);
}
