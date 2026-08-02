-- Constraints that reference the order states 0006 added.
--
-- Separate file on purpose: Postgres refuses to USE an enum value that was
-- added by `alter type ... add value` in the same transaction, and each
-- migration runs in one. Folding these into 0006 fails with "unsafe use of new
-- value of enum type" — not a style preference, a hard rule.

-- A funded order must know when it was funded, and the bank path reaches two
-- states 0001 could not have listed. Both sit downstream of capture, so an
-- order in either without `funded_at` is a record that lost its own history.
alter table orders drop constraint if exists funded_has_timestamp;
alter table orders add constraint funded_has_timestamp check (
  state not in ('funded', 'shipped', 'released', 'payout_pending', 'paid_out')
  or funded_at is not null
);

-- Only a bank order may enter the off-ramp states.
--
-- This is the database half of the check `release()` makes in application code.
-- A wallet order that somehow reached `payout_pending` would mean the target
-- was ignored — the seller's money routed somewhere they did not choose, which
-- is the one mistake on this path that cannot be undone afterwards.
alter table orders drop constraint if exists offramp_states_require_bank_target;
alter table orders add constraint offramp_states_require_bank_target check (
  state not in ('payout_pending', 'paid_out') or payout_to = 'bank'
);

-- A payout state must have a payout record to point at, and it must be a real
-- one. Reaching `payout_pending` means something was broadcast; if no live
-- record was written alongside it, the order claims an irreversible action with
-- no evidence that it happened.
alter table orders drop constraint if exists offramp_states_have_live_payout;
alter table orders add constraint offramp_states_have_live_payout check (
  state not in ('payout_pending', 'paid_out')
  or (payout is not null and payout ->> 'kind' <> 'mock')
);

-- Orders that never reach a bank keep the index cheap; the reconciliation
-- sweep only ever asks for the ones still in flight.
create index if not exists orders_payout_pending_idx on orders (state)
  where state = 'payout_pending';
