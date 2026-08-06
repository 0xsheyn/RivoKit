-- The prepared CPN transaction, held between `prepare` and `submit`.
--
-- WHY THIS COLUMN EXISTS AT ALL
--
-- It used to live in a module-level `Map` in demo/lib/cpn.server.ts. That is
-- correct for exactly one deployment shape: a single long-lived process. On
-- Vercel a cash-out spans TWO function invocations — prepare, then broadcast —
-- and nothing guarantees they land on the same instance. When they do not, the
-- Map is empty and the broadcast fails with "Payment was never prepared (or the
-- server restarted)", leaving a `cpn_payments` row stranded at CREATED: a
-- payment that exists at CPN, spent nothing, and can never be completed.
--
-- Rows at CREATED that never move are the visible symptom of this, and they are
-- indistinguishable from a genuinely abandoned prepare — which is why the fix
-- has to be storage, not a better error message.
--
-- Nullable and cleared at submit: it is live-only state, worth nothing once the
-- intent has been broadcast. Nothing secret is in it — `messageToBeSigned` is
-- the EIP-712 payload the browser is handed anyway on the wallet-signed path.

alter table cpn_payments
  add column if not exists prepared jsonb;

comment on column cpn_payments.prepared is
  'Unsigned CPN transaction + corridor, held between prepare and submit. Cleared on broadcast. Never a secret: this is the EIP-712 payload the signer sees.';
