-- A state for "captured, not yet converted".
--
-- Capture and swap cannot be atomic — they are separate transactions against
-- separate protocols. Between them the recipient holds the source token, not
-- the currency they were promised. That is neither `funded` (escrow is empty)
-- nor `released` (no EURC yet) nor `failed` (nothing failed; the floor held and
-- the funds are safe).
--
-- Without this state the condition would have to be recorded as `failed`, which
-- reads as "something broke" and would push an operator toward refunding an
-- order that only needs its swap retried.

alter type order_state add value if not exists 'settlement_pending' after 'funded';
