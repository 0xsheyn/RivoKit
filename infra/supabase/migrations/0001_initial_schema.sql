-- RivoKit — off-chain order state.
--
-- Per RIVOKIT_PRD.md §12. The chain is the source of truth for FUNDS; this
-- database is the source of truth for ORDER METADATA and UI status only
-- (PRD §8, "on-chain / off-chain split"). Nothing here can move money.
--
-- Money rule (CLAUDE.md §0.3): every monetary column is BIGINT holding
-- integer minor units — micro-USDC / micro-EURC, 6 decimals. Never NUMERIC,
-- never floating point. €18.50 is stored as 18500000.

-- ── Enums ──────────────────────────────────────────────────────────────

create type order_mode as enum ('escrow', 'direct');

create type order_wedge as enum (
  'contractor_payout',
  'digital_goods',
  'invoice',
  'physical_demo'
);

-- Mirrors the state machine in API.md §OrderState.
create type order_state as enum (
  'created',
  'funding_pending',
  'funded',
  'shipped',
  'released',
  'refund_pending',
  'refunded',
  'failed'
);

-- reclaim = pro-buyer (weak proof), auto_capture = pro-seller (strong proof).
create type timeout_kind as enum ('reclaim', 'auto_capture');

create type payment_kind as enum (
  'funding',
  'authorize',
  'capture',
  'void',
  'refund',
  'reclaim',
  'swap',
  'rebate',
  'bridge_back'
);

create type payment_status as enum ('pending', 'confirmed', 'failed');

-- ── orders ─────────────────────────────────────────────────────────────

create table orders (
  id text primary key,

  payer    text not null,
  receiver text not null,

  -- The amount GUARANTEED to the recipient, in micro-EURC. The FX swap
  -- carries stopLimit = price_eur, so the recipient receives >= this or the
  -- swap reverts (CLAUDE.md §0.4).
  price_eur bigint not null check (price_eur > 0),

  -- FX cushion and the source of the buyer's rebate. 150 = 1.5%.
  buffer_bps integer not null default 150
    check (buffer_bps >= 0 and buffer_bps <= 10000),

  -- What the buyer is locked to at checkout, in micro-USDC. Null until the
  -- quote is locked inside createOrder.
  usdc_amount bigint check (usdc_amount is null or usdc_amount > 0),

  -- Refund destination. Required at creation — invariant 5 in PRD §10 says
  -- refunds always go to the chain recorded on the order, so it can never be
  -- inferred later.
  receiving_chain text not null,

  mode  order_mode  not null,
  wedge order_wedge not null,
  state order_state  not null default 'created',

  timeout_kind     timeout_kind not null,
  timeout_deadline timestamptz  not null,

  -- Settlement results, written on release.
  eurc_out bigint check (eurc_out is null or eurc_out >= 0),
  rebate   bigint check (rebate   is null or rebate   >= 0),

  -- Why the order failed, for the human-readable message the host shows.
  failure_reason text,

  created_at timestamptz not null default now(),
  funded_at  timestamptz,
  settled_at timestamptz,

  -- The floor guarantee, enforced by the database and not merely asserted in
  -- application code: a released order must have paid the recipient at least
  -- price_eur. If this constraint ever fires, the invariant was broken
  -- upstream and the order must not be recorded as settled.
  constraint released_meets_floor check (
    state <> 'released'
    or (eurc_out is not null and eurc_out >= price_eur)
  ),

  -- rebate = max(0, actualOutput - priceEUR) — invariant 6, PRD §10.
  constraint rebate_matches_surplus check (
    rebate is null
    or eurc_out is null
    or rebate = greatest(0, eurc_out - price_eur)
  ),

  -- A funded order must know when it was funded.
  constraint funded_has_timestamp check (
    state not in ('funded', 'shipped', 'released') or funded_at is not null
  )
);

create index orders_state_idx      on orders (state);
create index orders_payer_idx      on orders (payer);
create index orders_created_at_idx on orders (created_at desc);

-- Orders awaiting an external event (CCTP attestation) — the reconciliation
-- sweep reads this. PRD §18 R1.
create index orders_pending_idx on orders (state)
  where state in ('funding_pending', 'refund_pending');

-- ── payments ───────────────────────────────────────────────────────────
-- One row per on-chain action attempted for an order.

create table payments (
  id         uuid primary key default gen_random_uuid(),
  order_id   text not null references orders (id) on delete cascade,

  -- Idempotency and anti-replay (PRD §16.3). UNIQUE is what actually makes
  -- cross-chain retries safe: a retried step reuses its nonce and collides
  -- rather than double-spending. ERC-3009 authorization nonces land here too.
  nonce text not null unique,

  kind    payment_kind   not null,
  status  payment_status not null default 'pending',
  tx_hash text,
  chain   text,

  -- Amount moved, in that token's minor units.
  amount bigint check (amount is null or amount >= 0),

  error_reason text,

  created_at   timestamptz not null default now(),
  confirmed_at timestamptz,

  constraint confirmed_has_tx check (
    status <> 'confirmed' or tx_hash is not null
  )
);

create index payments_order_id_idx on payments (order_id);
create index payments_status_idx   on payments (status);

-- ── events ─────────────────────────────────────────────────────────────
-- Inbound webhooks from Circle (transactions.*, gateway.deposit.finalized)
-- and SCP escrow event-monitor.

create table events (
  id       uuid primary key default gen_random_uuid(),
  order_id text references orders (id) on delete cascade,

  type    text  not null,
  payload jsonb not null,

  -- Whether the Circle webhook signature verified (PRD §M6/F6.2). An event
  -- with sig_verified = false must never drive a state transition.
  sig_verified boolean not null default false,

  received_at timestamptz not null default now()
);

create index events_order_id_idx    on events (order_id);
create index events_type_idx        on events (type);
create index events_received_at_idx on events (received_at desc);

-- ── Row Level Security — deny by default ───────────────────────────────
--
-- RLS is enabled with NO policies, so anon and authenticated roles can read
-- nothing and write nothing. Only the service role (which bypasses RLS)
-- touches these tables, and it lives server-side.
--
-- This enforces PRD §16.4: "validasi & screening di server, bukan klien."
-- Order state must never be writable from a browser — a client that could
-- set state = 'funded' would bypass the escrow entirely.

alter table orders   enable row level security;
alter table payments enable row level security;
alter table events   enable row level security;
