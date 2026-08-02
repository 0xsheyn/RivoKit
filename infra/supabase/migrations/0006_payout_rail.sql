-- release() reaches a bank: per-order payout target, the states that describes,
-- and a payout record that is allowed to be REAL.
--
-- Until now `release()` always stopped at EURC on Arc and always wrote a MOCK
-- instruction, so the schema could assume both. Neither assumption survives an
-- order whose money is meant to land in a bank account.

-- ── Where an order's money ends up ──────────────────────────────────────
--
-- 'wallet' is the original behaviour: capture, swap to EURC, stop. 'bank' skips
-- the swap and feeds the captured USDC to an off-ramp, whose quote locks the
-- fiat rate the way the floored swap locked the EURC one.
--
-- Defaulted rather than nullable, and backfilled, so no row is ambiguous: every
-- order that existed before this migration was a wallet order.
create type payout_target as enum ('wallet', 'bank');

alter table orders add column if not exists payout_to payout_target not null default 'wallet';

comment on column orders.payout_to is
  'wallet = settle to EURC on Arc and stop. bank = off-ramp the captured USDC to fiat.';

-- ── Two states the bank path needs ──────────────────────────────────────
--
-- `payout_pending`: broadcast, not yet delivered. The seller's USDC has left
-- their wallet for a payment network that reports asynchronously — minutes for
-- SEPA, longer if an RFI lands. This is NOT `released` (no EURC was ever
-- produced) and NOT `paid_out` (no fiat has arrived).
--
-- `paid_out`: the fiat leg completed. Terminal, unlike `released`, because
-- `released` can still be walked back by an operator-funded refund and this
-- cannot: the money is in a beneficiary's bank, beyond anything RivoKit can
-- reverse.
alter type order_state add value if not exists 'payout_pending' after 'released';
alter type order_state add value if not exists 'paid_out'       after 'payout_pending';

-- ── The off-ramp broadcast is a payment like any other ───────────────────
alter type payment_kind add value if not exists 'payout';

-- ── A payout record may now be real — but only on evidence ───────────────
--
-- 0004 hardcoded "every payout is a mock" into a constraint, which was right
-- when nothing could execute one. Relaxing it must not become permission to
-- claim a payout happened. So the replacement admits exactly two shapes and
-- nothing between them:
--
--   mock — kind 'mock', label 'MOCK', executed false, and NO reference. It
--          cannot borrow the credibility of a payment id it does not have.
--   live — a non-mock kind, label 'LIVE', and a reference carrying a paymentId.
--          That id is what makes the claim falsifiable: anyone can query the
--          rail and check it. `executed` is deliberately NOT required to be
--          true, because it means BROADCAST and a record is written the moment
--          the broadcast returns.
--
-- What the constraint forbids is the dangerous middle: a payout labelled LIVE
-- with nothing to look up, or one labelled MOCK while claiming execution.
-- Golden rule §4 survives the generalisation rather than being dropped by it.
alter table orders drop constraint if exists payout_is_labelled_mock;
alter table orders drop constraint if exists payout_label_matches_kind;
alter table orders add constraint payout_label_matches_kind check (
  payout is null
  or (
    payout ->> 'kind' = 'mock'
    and payout ->> 'label' = 'MOCK'
    and payout ->> 'executed' = 'false'
    -- Parenthesised: `and` binds tighter than `or`, so without these the
    -- "reference is JSON null" arm would escape the mock branch entirely and
    -- accept any payout at all that happened to carry a null reference.
    and (payout -> 'reference' is null or payout -> 'reference' = 'null'::jsonb)
  )
  or (
    payout ->> 'kind' <> 'mock'
    and payout ->> 'label' = 'LIVE'
    and payout -> 'reference' ->> 'paymentId' is not null
  )
);

comment on column orders.payout is
  'Payout record. kind=mock: an instruction the host must execute. kind=cpn: a real broadcast, traceable via reference.paymentId.';
