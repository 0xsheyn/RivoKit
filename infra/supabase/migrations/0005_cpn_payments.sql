-- Durable record of a CPN cash-out.
--
-- Until now a cash-out lived entirely in one request: prepare returned an
-- intent, broadcast polled a few times, and whatever CPN did afterwards — an
-- RFI, a delayed settlement, a failure an hour later — reached nobody. The
-- webhook reducer existed but had nothing to write to.
--
-- This is a table of its own rather than columns on `orders` because the two
-- surfaces really are separate: a seller cashes out an ACCUMULATED balance,
-- not one order. `order_id` is therefore nullable — a link when the host can
-- attribute the payout, absent when it spans many orders.

create table if not exists cpn_payments (
  payment_id            text primary key,
  order_id              text references orders(id) on delete set null,
  corridor              text not null,
  sender_address        text not null,
  -- Who authorized the spend: the demo's server-held key, or the wallet that
  -- actually holds the USDC. Worth recording because it is the difference
  -- between a demo and a non-custodial cash-out.
  signed_by             text not null check (signed_by in ('server', 'wallet')),
  -- Money stays integer minor units. USDC is 6dp; the fiat side carries its own
  -- scale because corridors do not agree on one (EUR/BRL/MXN/USD are 2dp today,
  -- a 0dp currency would break a hard-coded assumption).
  source_minor          bigint not null check (source_minor > 0),
  source_currency       text not null,
  destination_minor     bigint not null check (destination_minor > 0),
  destination_currency  text not null,
  destination_scale     smallint not null default 2 check (destination_scale between 0 and 6),
  status                text not null check (status in (
                          'CREATED', 'CRYPTO_FUNDS_PENDING', 'FIAT_PAYMENT_INITIATED',
                          'COMPLETED', 'FAILED')),
  transaction_id        text,
  failure_reason        text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists cpn_payments_order_id_idx on cpn_payments (order_id);
create index if not exists cpn_payments_status_idx on cpn_payments (status);

-- RLS deny-all, like every other table here: only the service role reads or
-- writes, and it must never reach a browser.
alter table cpn_payments enable row level security;

comment on table cpn_payments is
  'CPN cash-outs. Separate from orders on purpose: a payout spans an accumulated balance, not one order.';
