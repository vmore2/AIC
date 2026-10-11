-- CEO-managed setup: model providers and models chosen in the dashboard, and connections (databases)
-- that employees request and the CEO provides. Secret VALUES live in the customer's encrypted vault;
-- these rows hold only vault ids and non-reversible fingerprints.

CREATE TABLE model_providers (
  id              text PRIMARY KEY,
  kind            text NOT NULL,                 -- openai | anthropic | gemini | openrouter | groq | ollama | custom
  label           text NOT NULL,
  api             text NOT NULL CHECK (api IN ('openai_compatible','anthropic')),
  base_url        text,
  secret_id       text,                          -- vault id; NULL for keyless local endpoints (e.g. Ollama)
  key_fingerprint text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_profiles (
  key          text PRIMARY KEY,
  provider_id  text REFERENCES model_providers(id),
  profile      jsonb NOT NULL,                   -- ModelProfile (api_key_secret = vault id, never the key)
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connections (
  id                       text PRIMARY KEY,
  kind                     text NOT NULL CHECK (kind IN ('postgres','mysql')),
  name                     text NOT NULL,
  purpose                  text NOT NULL,
  status                   text NOT NULL CHECK (status IN ('requested','active','declined','revoked')),
  access                   text NOT NULL DEFAULT 'read' CHECK (access IN ('read','read_write')),
  department_id            text REFERENCES departments(id),
  requested_by_employee_id text REFERENCES employees(id),
  task_id                  text REFERENCES tasks(id),
  config                   jsonb NOT NULL DEFAULT '{}',   -- host, port, database, user, ssl (no password)
  secret_id                text,
  key_fingerprint          text,
  last_check               jsonb,
  decided_by               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  version                  bigint NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX connections_one_live_per_name ON connections (coalesce(department_id, ''), kind, lower(name)) WHERE status IN ('requested','active');
