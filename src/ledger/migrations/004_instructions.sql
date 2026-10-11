-- Standing instructions from the CEO, at any level of the org: the whole company, one team, every
-- holder of a role in a team, or one employee. They shape HOW work is done; they never grant tools or
-- permissions (the policy engine decides those) and never override an objective's verbatim requirements.
CREATE TABLE instructions (
  id          text PRIMARY KEY,
  scope_type  text NOT NULL CHECK (scope_type IN ('company','department','role','employee')),
  scope_id    text NOT NULL,          -- company id | department id | "<department id>:<role key>" | employee id
  body        text NOT NULL,
  version     int NOT NULL,
  status      text NOT NULL CHECK (status IN ('active','superseded','removed')),
  set_by      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX instructions_one_active ON instructions (scope_type, scope_id) WHERE status = 'active';
