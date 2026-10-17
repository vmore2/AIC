-- Production hardening for a customer-hosted ledger (architecture.md §13.4, INV-1, INV-10).
--
-- 1. Start the platform once as the database OWNER (e.g. `aic doctor` with the owner's DATABASE_URL):
--    that applies the migrations.
-- 2. Run this script as the owner:  psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/production-roles.sql
-- 3. Change the passwords below (ALTER ROLE ... PASSWORD), keep them in your secret manager, and run the
--    platform as aic_engine:  DATABASE_URL=postgres://aic_engine:<password>@host:5432/aic
-- After an upgrade that adds migrations, repeat steps 1–2 (this script is safe to re-run).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aic_engine') THEN
    CREATE ROLE aic_engine LOGIN PASSWORD 'change-me';    -- the platform process (Transition Engine + orchestrator)
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aic_readonly') THEN
    CREATE ROLE aic_readonly LOGIN PASSWORD 'change-me';  -- dashboards, auditors, BI
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO aic_engine, aic_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO aic_readonly;

-- The engine may read everything and write the ledger…
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO aic_engine;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aic_engine;
GRANT DELETE ON outbox TO aic_engine;               -- delivered outbox rows are removed
-- …but history is append-only, even for the engine (defense in depth beside the triggers).
REVOKE UPDATE, DELETE ON ledger_events, evidence, artifact_versions, requirement_versions FROM aic_engine;

-- Tables that later migrations create (as this owner) get the same baseline grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO aic_engine;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO aic_engine;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO aic_readonly;

-- Nobody but a migration owner may alter triggers that enforce immutability.
REVOKE ALL ON FUNCTION forbid_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION forbid_frozen_criteria() FROM PUBLIC;

-- Recommended: enable pgaudit (or your provider's audit logging) for superuser activity, and
-- schedule `aic audit` so any out-of-band modification of ledger_events is detected by the hash chain.
