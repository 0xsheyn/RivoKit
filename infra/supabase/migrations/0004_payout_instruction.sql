-- Persist the payout instruction emitted on release.
--
-- It used to live in a Map inside the SDK facade, which made `payoutFor()`
-- answer correctly exactly once: in the process that ran the release. After a
-- restart — or on any other instance behind a load balancer — it answered
-- "nothing", which is indistinguishable from "no payout was ever owed". A
-- record of what the host still has to settle must outlive the request that
-- produced it.
--
-- Stored as JSONB rather than columns because the instruction is a hand-off
-- document, not queryable state: the order's own money columns (eurc_out,
-- rebate) remain the numbers this system reasons about.

alter table orders add column if not exists payout jsonb;

-- Golden rule §0.6: a mock must be unmistakable. `mockPayout()` stamps the
-- label in application code; this constraint means a future caller cannot
-- persist an instruction claiming to be real, whatever the application
-- believes. NULL stays allowed — most orders have not been released.
alter table orders drop constraint if exists payout_is_labelled_mock;
alter table orders add constraint payout_is_labelled_mock check (
  payout is null
  or (payout ->> 'label' = 'MOCK' and payout ->> 'executed' = 'false')
);

-- Amounts travel as strings, never JSON numbers: a JSON number is a float, and
-- integer minor units exist precisely so no amount is ever a float.
alter table orders drop constraint if exists payout_amounts_are_strings;
alter table orders add constraint payout_amounts_are_strings check (
  payout is null
  or (
    jsonb_typeof(payout -> 'source' -> 'amountMinor') = 'string'
    and jsonb_typeof(payout -> 'target' -> 'amountMinor') = 'string'
  )
);

comment on column orders.payout is
  'MOCK payout instruction handed to the host on release. RivoKit does not execute the fiat leg.';
