-- Personal access tokens for teammates (approvers, viewers, auditors). Only a hash is stored.
CREATE TABLE access_tokens (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id),
  label        text NOT NULL,
  token_sha256 text NOT NULL UNIQUE,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
