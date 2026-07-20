-- PaymentInfo fields — everything needed to reconstruct the on-chain struct.
--
-- The escrow keys its state by keccak(chainid, escrow, keccak(TYPEHASH, info)).
-- Every later operation (capture, void, refund, reclaim) recomputes that hash
-- from PaymentInfo, so if we cannot reproduce the struct byte-for-byte, the
-- order becomes unreachable and its funds sit until authorizationExpiry.
--
-- That is why these are stored, not derived: a value recomputed from "policy"
-- at capture time could differ from what was hashed at authorize time.

alter table orders
  -- Only this address may authorize/capture/void/refund (contract: onlySender).
  add column operator text not null,
  add column token    text not null,

  -- uint120 on-chain. BIGINT covers every realistic USDC amount; the CHECK
  -- keeps us inside int64 so a silent wrap can never reach the contract.
  add column max_amount bigint not null
    check (max_amount > 0 and max_amount <= 9223372036854775807),

  -- uint256 on-chain — far wider than BIGINT, so NUMERIC(78,0).
  add column salt numeric(78, 0) not null,

  add column min_fee_bps  integer not null default 0,
  add column max_fee_bps  integer not null default 0,
  add column fee_receiver text    not null
    default '0x0000000000000000000000000000000000000000',

  -- Three distinct deadlines. The existing timeout_kind/timeout_deadline stay:
  -- those are RivoKit's per-wedge POLICY (reclaim vs auto_capture), a different
  -- thing from the contract's hard expiries.
  add column pre_approval_expiry   timestamptz not null,
  add column authorization_expiry  timestamptz not null,
  add column refund_expiry         timestamptz not null,

  -- Computed off-chain and verified against the escrow. UNIQUE because two
  -- orders sharing a hash would share escrow state — the second authorize
  -- would revert PaymentAlreadyCollected, and worse, a capture on one could
  -- move the other's funds.
  add column payment_info_hash text unique;

-- Mirrors the contract's InvalidExpiries check. Enforced here too so a bad
-- order cannot even be persisted, let alone submitted and reverted on-chain.
alter table orders
  add constraint expiries_ordered check (
    pre_approval_expiry <= authorization_expiry
    and authorization_expiry <= refund_expiry
  );

-- Mirrors InvalidFeeBpsRange / FeeBpsOverflow.
alter table orders
  add constraint fee_bps_valid check (
    min_fee_bps >= 0
    and max_fee_bps >= min_fee_bps
    and max_fee_bps <= 10000
  );

-- A payer must be able to fund at least the quoted amount.
alter table orders
  add constraint max_amount_covers_quote check (
    usdc_amount is null or max_amount >= usdc_amount
  );

create index orders_payment_info_hash_idx on orders (payment_info_hash);
