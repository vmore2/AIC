-- The Work Ledger (architecture.md §13). One installation = one company; the customer owns the database.
-- Protected tables are written only by the Transition Engine (INV-1). For production, apply
-- docs/production-roles.sql to enforce this with database privileges.

CREATE TABLE company (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  settings    jsonb NOT NULL DEFAULT '{}',          -- default project settings (e.g. test_command)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  email       text,
  role        text NOT NULL CHECK (role IN ('ceo','admin','approver','member','viewer','auditor')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  id               text PRIMARY KEY,
  key              text NOT NULL UNIQUE,
  name             text NOT NULL,
  template_version int NOT NULL,
  template         jsonb NOT NULL,              -- immutable snapshot of the template at hiring time
  default_mode     text NOT NULL,
  risk_floor       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id                  text PRIMARY KEY,
  display_name        text NOT NULL,
  department_id       text NOT NULL REFERENCES departments(id),
  role_key            text NOT NULL,
  role_version        int NOT NULL,
  role_snapshot       jsonb NOT NULL,
  category            text NOT NULL,
  can_manage          boolean NOT NULL,
  manager_employee_id text REFERENCES employees(id),
  reports_to_user_id  text REFERENCES users(id),
  model_profile       text NOT NULL,
  model_family        text NOT NULL,
  tool_grants         jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','retired')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  version             bigint NOT NULL DEFAULT 1,
  CHECK (manager_employee_id IS NULL OR manager_employee_id <> id)
);

CREATE TABLE mode_settings (
  scope_type  text NOT NULL CHECK (scope_type IN ('company','department','objective')),
  scope_id    text NOT NULL,
  mode        text NOT NULL CHECK (mode IN ('M1','M2','M3','M4','M5','M6')),
  set_by      text NOT NULL,
  reason      text NOT NULL,
  set_at      timestamptz NOT NULL DEFAULT now(),
  version     bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (scope_type, scope_id)
);

CREATE TABLE objectives (
  id                text PRIMARY KEY,
  title             text NOT NULL,
  department_id     text NOT NULL REFERENCES departments(id),
  owner_employee_id text NOT NULL REFERENCES employees(id),
  sponsor_user_id   text NOT NULL REFERENCES users(id),
  status            text NOT NULL CHECK (status IN ('planning','active','paused','completed','cancelled')),
  risk_floor        text NOT NULL,
  budget_limit      numeric(14,4) NOT NULL,
  budget_reserved   numeric(14,4) NOT NULL DEFAULT 0,
  budget_spent      numeric(14,4) NOT NULL DEFAULT 0,
  deadline          timestamptz,
  settings          jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  version           bigint NOT NULL DEFAULT 1,
  CHECK (budget_reserved >= 0 AND budget_spent >= 0 AND budget_reserved + budget_spent <= budget_limit * 1.0001)
);

CREATE TABLE requirements (
  id              text PRIMARY KEY,
  objective_id    text NOT NULL REFERENCES objectives(id),
  key             text NOT NULL,
  current_version int NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deferred','removed')),
  UNIQUE (objective_id, key)
);

CREATE TABLE requirement_versions (
  requirement_id text NOT NULL REFERENCES requirements(id),
  version        int NOT NULL,
  text           text NOT NULL,                  -- verbatim, never summarized
  text_sha256    text NOT NULL,
  authored_by    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (requirement_id, version)
);

CREATE TABLE decisions (
  id              text PRIMARY KEY,
  scope_type      text NOT NULL,
  scope_id        text NOT NULL,
  question        text NOT NULL,
  decision_text   text NOT NULL,
  decided_by_type text NOT NULL,
  decided_by      text NOT NULL,
  authority_basis text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id                    text PRIMARY KEY,
  objective_id          text NOT NULL REFERENCES objectives(id),
  parent_task_id        text REFERENCES tasks(id),
  depth                 smallint NOT NULL CHECK (depth BETWEEN 0 AND 6),
  kind                  text NOT NULL,
  title                 text NOT NULL,
  spec                  text NOT NULL,
  status                text NOT NULL DEFAULT 'draft',
  hold                  text,
  integrity             text NOT NULL DEFAULT 'ok' CHECK (integrity IN ('ok','suspect')),
  risk_tier             text NOT NULL CHECK (risk_tier IN ('R0','R1','R2','R3')),
  owner_employee_id     text REFERENCES employees(id),
  manager_employee_id   text REFERENCES employees(id),
  created_by_type       text NOT NULL,
  created_by            text NOT NULL,
  criteria_set_id       text,
  criteria_frozen_at    timestamptz,
  attempt               smallint NOT NULL DEFAULT 0,
  max_attempts          smallint NOT NULL DEFAULT 3,
  weight                numeric(6,2) NOT NULL DEFAULT 1,
  budget_limit          numeric(14,4) NOT NULL,
  budget_spent          numeric(14,4) NOT NULL DEFAULT 0,
  tool_grants           jsonb NOT NULL,
  autonomy_ceiling      text NOT NULL DEFAULT 'M1',
  proposal_id           text,
  accepted_submission_id text,
  assurance_label       text,
  status_changed_at     timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  version               bigint NOT NULL DEFAULT 1,
  CHECK (status <> 'in_progress' OR owner_employee_id IS NOT NULL),
  -- INV-4 at the database level: no execution or acceptance without frozen criteria (except discovery).
  CHECK (status NOT IN ('in_progress','submitted','verifying','in_review','awaiting_acceptance','accepted')
         OR criteria_frozen_at IS NOT NULL OR kind = 'discovery')
);
CREATE INDEX tasks_objective_status ON tasks (objective_id, status);
CREATE INDEX tasks_owner_status ON tasks (owner_employee_id, status);

CREATE TABLE task_requirement_refs (
  task_id             text NOT NULL REFERENCES tasks(id),
  requirement_id      text NOT NULL REFERENCES requirements(id),
  requirement_version int NOT NULL,
  PRIMARY KEY (task_id, requirement_id)
);

CREATE TABLE task_dependencies (
  task_id       text NOT NULL REFERENCES tasks(id),
  depends_on_id text NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

CREATE TABLE criteria_sets (
  id             text PRIMARY KEY,
  task_id        text NOT NULL REFERENCES tasks(id),
  version        int NOT NULL,
  status         text NOT NULL CHECK (status IN ('draft','frozen','superseded')),
  frozen_at      timestamptz,
  content_sha256 text,
  UNIQUE (task_id, version)
);

CREATE TABLE criteria (
  id              text PRIMARY KEY,
  criteria_set_id text NOT NULL REFERENCES criteria_sets(id),
  ordinal         smallint NOT NULL,
  statement       text NOT NULL,
  kind            text NOT NULL,
  required        boolean NOT NULL DEFAULT true,
  independence    text NOT NULL,
  check_spec      jsonb
);

CREATE TABLE task_leases (
  task_id            text PRIMARY KEY REFERENCES tasks(id),
  epoch              bigint NOT NULL,             -- monotonic fencing token (INV-7)
  run_id             text,
  holder_employee_id text,
  state              text NOT NULL CHECK (state IN ('active','suspended','released','revoked')),
  expires_at         timestamptz,
  renewed_at         timestamptz
);

CREATE TABLE runs (
  id              text PRIMARY KEY,
  task_id         text REFERENCES tasks(id),     -- null for conversation runs
  attempt         smallint NOT NULL DEFAULT 0,
  lease_epoch     bigint NOT NULL DEFAULT 0,
  employee_id     text NOT NULL REFERENCES employees(id),
  mode            text NOT NULL CHECK (mode IN ('task','review','conversation')),
  model_profile   text NOT NULL,
  model_family    text NOT NULL,
  status          text NOT NULL CHECK (status IN ('running','suspended','submitted','failed','abandoned','cancelled','interrupted','ended_without_submission','completed')),
  failure_reason  text,
  steps           int NOT NULL DEFAULT 0,
  cost_usd        numeric(14,6) NOT NULL DEFAULT 0,
  budget_reserved numeric(14,6) NOT NULL DEFAULT 0,
  input_tokens    bigint NOT NULL DEFAULT 0,
  output_tokens   bigint NOT NULL DEFAULT 0,
  transcript_path text,
  workspace_path  text,
  branch          text,
  review_of_submission_id text,
  conversation_id text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);

CREATE TABLE tool_calls (
  id           text PRIMARY KEY,
  run_id       text NOT NULL REFERENCES runs(id),
  seq          int NOT NULL,
  tool         text NOT NULL,
  action_class text NOT NULL,
  args_sha256  text NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('allow','deny','error')),
  reasons      jsonb NOT NULL DEFAULT '[]',
  lease_epoch  bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE TABLE artifacts (
  id           text PRIMARY KEY,
  objective_id text NOT NULL REFERENCES objectives(id),
  kind         text NOT NULL,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE artifact_versions (
  id                text PRIMARY KEY,
  artifact_id       text NOT NULL REFERENCES artifacts(id),
  content_sha256    text NOT NULL,
  external_ref      text,
  storage_path      text,
  produced_by_run   text REFERENCES runs(id),
  produced_by_task  text REFERENCES tasks(id),
  producer_lineage  jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE submissions (
  id              text PRIMARY KEY,
  task_id         text NOT NULL REFERENCES tasks(id),
  run_id          text NOT NULL REFERENCES runs(id),
  criteria_set_id text NOT NULL REFERENCES criteria_sets(id),
  claim           jsonb NOT NULL,                -- the worker's self-report; never evidence
  submission_sha256 text NOT NULL,
  status          text NOT NULL CHECK (status IN ('open','accepted','rejected','superseded')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE submission_artifacts (
  submission_id       text NOT NULL REFERENCES submissions(id),
  artifact_version_id text NOT NULL REFERENCES artifact_versions(id),
  PRIMARY KEY (submission_id, artifact_version_id)
);

CREATE TABLE evidence (
  id              text PRIMARY KEY,
  task_id         text NOT NULL REFERENCES tasks(id),
  submission_id   text NOT NULL REFERENCES submissions(id),
  criterion_id    text NOT NULL REFERENCES criteria(id),
  verifier_type   text NOT NULL CHECK (verifier_type IN ('service','employee','user','external_system')),
  verifier_id     text NOT NULL,
  verifier_config jsonb NOT NULL DEFAULT '{}',
  independence    text NOT NULL,
  family_differs  boolean,
  result          text NOT NULL CHECK (result IN ('pass','fail','inconclusive','error')),
  definitive      boolean NOT NULL DEFAULT true,
  confidence      numeric(3,2),
  details         jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evidence_artifacts (
  evidence_id         text NOT NULL REFERENCES evidence(id),
  artifact_version_id text NOT NULL REFERENCES artifact_versions(id),
  PRIMARY KEY (evidence_id, artifact_version_id)
);

CREATE TABLE proposals (
  id                 text PRIMARY KEY,
  objective_id       text NOT NULL REFERENCES objectives(id),
  task_id            text REFERENCES tasks(id),   -- the planning task that produced it
  author_employee_id text NOT NULL REFERENCES employees(id),
  kind               text NOT NULL CHECK (kind IN ('plan','decision','change')),
  status             text NOT NULL CHECK (status IN ('submitted','approved','changes_requested','rejected','superseded')),
  content            jsonb NOT NULL,
  content_sha256     text NOT NULL,
  validation         jsonb NOT NULL DEFAULT '{}',
  approval_id        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  version            bigint NOT NULL DEFAULT 1
);

CREATE TABLE approvals (
  id              text PRIMARY KEY,
  subject_type    text NOT NULL CHECK (subject_type IN ('plan','task_acceptance','external_action','directive','budget_extension')),
  subject_id      text NOT NULL,
  subject_sha256  text NOT NULL,                 -- binds the decision to exact content (INV-6)
  risk_tier       text NOT NULL,
  scope_text      text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending','approved','rejected','expired','withdrawn','no_longer_required')),
  decided_by      text,
  decided_at      timestamptz,
  rationale       text,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  version         bigint NOT NULL DEFAULT 1
);

CREATE TABLE escalations (
  id            text PRIMARY KEY,
  task_id       text REFERENCES tasks(id),
  raised_by_type text NOT NULL,
  raised_by     text NOT NULL,
  type          text NOT NULL CHECK (type IN ('question','decision_required','blocker','risk','budget','uncertain_outcome','policy_violation_attempt','security')),
  body          jsonb NOT NULL,
  dedup_key     text NOT NULL,
  routed_to_type text NOT NULL,
  routed_to     text NOT NULL,
  status        text NOT NULL CHECK (status IN ('open','resolved','superseded')),
  resolution_decision_id text REFERENCES decisions(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  version       bigint NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX escalations_open_dedup ON escalations (dedup_key) WHERE status = 'open';

CREATE TABLE external_actions (
  id               text PRIMARY KEY,
  task_id          text NOT NULL REFERENCES tasks(id),
  run_id           text REFERENCES runs(id),
  lease_epoch      bigint NOT NULL,
  connector        text NOT NULL,
  action           text NOT NULL,
  action_class     text NOT NULL,
  idempotency_mode text NOT NULL CHECK (idempotency_mode IN ('native_key','natural_key','none')),
  idempotency_key  text NOT NULL UNIQUE,
  natural_key      text,
  payload          jsonb NOT NULL,
  payload_sha256   text NOT NULL,
  approval_id      text REFERENCES approvals(id),
  status           text NOT NULL CHECK (status IN ('intended','attempting','succeeded','failed','unknown','uncertain','compensated','cancelled')),
  attempts         smallint NOT NULL DEFAULT 0,
  external_ref     text,
  reconciled       boolean NOT NULL DEFAULT false,
  required_for_acceptance boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          bigint NOT NULL DEFAULT 1
);

CREATE TABLE usage_records (
  id            text PRIMARY KEY,
  run_id        text REFERENCES runs(id),
  employee_id   text,
  model_profile text NOT NULL,
  input_tokens  int NOT NULL,
  output_tokens int NOT NULL,
  cost_usd      numeric(14,6) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id           text PRIMARY KEY,
  employee_id  text NOT NULL REFERENCES employees(id),
  objective_id text REFERENCES objectives(id),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id),
  seq             int NOT NULL,
  author_type     text NOT NULL,
  author_id       text NOT NULL,
  body            text NOT NULL,
  citations       jsonb NOT NULL DEFAULT '[]',
  discrepancies   jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq)
);

CREATE TABLE directives (
  id              text PRIMARY KEY,
  conversation_id text REFERENCES conversations(id),
  proposed_by     text NOT NULL,
  directive_type  text NOT NULL,
  payload         jsonb NOT NULL,
  payload_sha256  text NOT NULL,
  status          text NOT NULL CHECK (status IN ('pending_confirmation','confirmed','rejected','applied','failed')),
  confirmed_by    text,
  confirmed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_items (
  id            text NOT NULL,
  version       int NOT NULL,
  scope_type    text NOT NULL CHECK (scope_type IN ('employee','team','project','company')),
  scope_id      text NOT NULL,
  kind          text NOT NULL,
  body          text NOT NULL,
  source_refs   jsonb NOT NULL,
  author_id     text NOT NULL,
  review_status text NOT NULL CHECK (review_status IN ('auto_accepted','proposed','approved','rejected')),
  tainted       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  PRIMARY KEY (id, version)
);

CREATE TABLE lineage_edges (
  from_type  text NOT NULL,
  from_id    text NOT NULL,
  rel        text NOT NULL,
  to_type    text NOT NULL,
  to_id      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_type, from_id, rel, to_type, to_id)
);

-- Command log: idempotency (INV-8).
CREATE TABLE command_log (
  idem_key       text PRIMARY KEY,
  command_type   text NOT NULL,
  command_sha256 text NOT NULL,
  principal      jsonb NOT NULL,
  status         text NOT NULL CHECK (status IN ('done','rejected')),
  outcome        jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Append-only, hash-chained ledger events (INV-9, INV-10) + outbox.
CREATE TABLE chain_head (
  id        int PRIMARY KEY CHECK (id = 1),
  last_seq  bigint NOT NULL,
  last_hash text NOT NULL
);
INSERT INTO chain_head VALUES (1, 0, repeat('0', 64));

CREATE TABLE ledger_events (
  seq               bigint PRIMARY KEY,
  id                text NOT NULL UNIQUE,
  type              text NOT NULL,
  aggregate_type    text NOT NULL,
  aggregate_id      text NOT NULL,
  command_key       text,
  actor             jsonb NOT NULL,
  payload           jsonb NOT NULL,
  occurred_at       timestamptz NOT NULL,
  prev_hash         text NOT NULL,
  hash              text NOT NULL
);
CREATE INDEX ledger_events_aggregate ON ledger_events (aggregate_type, aggregate_id, seq);

CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  event_seq    bigint NOT NULL REFERENCES ledger_events(seq),
  event_type   text NOT NULL,
  aggregate_id text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  last_error   text
);

-- Immutability (defense in depth beside privileges).
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER ledger_events_append_only BEFORE UPDATE OR DELETE ON ledger_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER evidence_append_only BEFORE UPDATE OR DELETE ON evidence FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER artifact_versions_append_only BEFORE UPDATE OR DELETE ON artifact_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER requirement_versions_append_only BEFORE UPDATE OR DELETE ON requirement_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Frozen criteria cannot change.
CREATE FUNCTION forbid_frozen_criteria() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text;
BEGIN
  SELECT status INTO s FROM criteria_sets WHERE id = COALESCE(NEW.criteria_set_id, OLD.criteria_set_id);
  IF s = 'frozen' THEN RAISE EXCEPTION 'criteria set is frozen'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER criteria_frozen BEFORE INSERT OR UPDATE OR DELETE ON criteria FOR EACH ROW EXECUTE FUNCTION forbid_frozen_criteria();
