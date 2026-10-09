-- Production hardening for a customer-hosted ledger (architecture.md §13.4, INV-1, INV-10).
-- Apply after the first `aic` start has run migrations. Then run the platform as `aic_engine`.
-- Adjust role names / passwords to your standards; store credentials in your secret manager.

CREATE ROLE aic_engine LOGIN PASSWORD 'change-me';   -- the platform process (Transition Engine + orchestrator)
CREATE ROLE aic_readonly LOGIN PASSWORD 'change-me'; -- dashboards, auditors, BI

GRANT USAGE ON SCHEMA public TO aic_engine, aic_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO aic_readonly;

-- The engine may read everything and write the ledger…
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO aic_engine;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aic_engine;
GRANT DELETE ON outbox TO aic_engine;               -- delivered outbox rows are removed
-- …but history is append-only, even for the engine (defense in depth beside the triggers).
REVOKE UPDATE, DELETE ON ledger_events, evidence, artifact_versions, requirement_versions FROM aic_engine;

-- Nobody but a migration owner may alter triggers that enforce immutability.
REVOKE ALL ON FUNCTION forbid_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION forbid_frozen_criteria() FROM PUBLIC;

-- Recommended: enable pgaudit (or your provider's audit logging) for superuser activity, and
-- schedule `aic audit` so any out-of-band modification of ledger_events is detected by the hash chain.
