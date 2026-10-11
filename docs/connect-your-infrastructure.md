# Connect your infrastructure

The AI Company runs entirely on resources the company provides. Nothing is hosted by the platform
vendor. This guide covers each resource and the production checklist.

## 1. Database (the work ledger)

The ledger is the source of truth for all work. Use your own PostgreSQL 17+:

```yaml
database:
  url_env: DATABASE_URL     # postgres://user:pass@host:5432/aic — read from the environment
```

Migrations run automatically on start. For production, also apply
[`production-roles.sql`](production-roles.sql). It enforces at the database level that only the
Transition Engine can write protected tables (INV-1) and that history is append-only (INV-10).

For evaluation, `database: { local_path: .aic/db }` uses an embedded PostgreSQL (PGlite) with the same SQL.

Backups: enable point-in-time recovery on your database. Ledger integrity can be verified at any time
with `aic audit`, which recomputes the hash chain.

## 2. Model providers

**Easiest: the dashboard.** Open **Setup → AI models → Add a provider** and pick one:
- OpenAI
- Anthropic
- Google Gemini
- OpenRouter
- Groq
- Ollama on your own machine
- any OpenAI-compatible endpoint

Paste your key. It's checked for free (by listing the provider's models), then encrypted into your
own storage (`<storage>/secrets.vault.json`, key in `master.key` or `AIC_MASTER_KEY`). The ledger keeps
only a fingerprint. Pick the models your employees may use and confirm their prices; the spend cap
needs them. Star one as the default for new hires, and change any role's model under **Who uses which
model**.

You can also configure models in `aic.config.yaml`. There, each role can use a different model, and
keys are referenced by environment-variable name and never written to config files or the ledger.

| Provider | `provider` | Notes |
|---|---|---|
| OpenAI, Azure OpenAI, vLLM, Ollama, LM Studio, any OpenAI-compatible endpoint | `openai_compatible` | set `base_url` |
| Anthropic | `anthropic` | |
| Offline demo | `scripted` | deterministic; demo scenarios only |

Hiring validates each role's required capabilities (structured output, tool calling, context size)
against the profile you assign. Put **reviewer roles on a different model family** than producers:
R2+ rubric criteria only count reviews whose model family differs from the producer's.

Budgets use the `price_per_million` you configure. The platform never hard-codes vendor prices.

**Lifetime spend cap.** Set `AIC_SPEND_CAP_USD` (for example `AIC_SPEND_CAP_USD=2.00` in `.env`) to
cap the total spend of each API key across every run, test and process. Before each call the platform
checks the worst case (estimated input plus maximum output). It refuses the call if the call could
cross the cap. Actual usage is recorded in `~/.aic/spend-ledger.json` (override with
`AIC_SPEND_LEDGER`). The ledger stores only a hash prefix of each key, never the key itself. Real
providers without prices are refused while a cap is set, because the cap couldn't be enforced. Also
set a budget limit in your provider's console as a backstop.

## 3. Code and deliverables hosting

All departments deliver versioned files. Engineering delivers code; the other departments deliver
documents such as reports, memos, and briefs. Evidence binds to exact commits.

```yaml
code_hosting:
  kind: github
  repo: your-org/your-repo
  token_env: GITHUB_TOKEN    # fine-grained token: contents read/write on this repo only
  base_branch: main
```

With GitHub, an approved release opens (or reuses) a pull request from the integration branch into
the base branch. Its description is generated from the ledger: requirements, accepted work, and
assurance labels. The PR is merged **pinned to the exact approved commit**, and GitHub refuses if the
branch moved. Your branch protection and required checks still apply. For GitHub Enterprise, set
`api_url`.

Employees work only on `aic/<task>/<run>` branches. Accepted work merges into
`aic/<objective>/integration`. Merging into `main` happens only after the CEO approves a release
(`aic release`), and that approval is bound to the exact integration commit. Protect `main` with
branch protection so only the platform's release step can merge.

## 3b. Databases your teams use

Choose your stack (language, framework, database) in **Setup → Tech stack**; every task carries it.

**How a database gets connected:**
1. When an employee needs a database, it calls `connections.request`. Its task pauses, and your
   **Decisions** show a card with a form.
2. Enter the host, port, database, user and password, and pick read-only or read & write.
3. The platform tests the login live, encrypts the password into your vault, and the task resumes.

You can also add a database in advance under **Setup → Databases**. PostgreSQL and MySQL are supported.

**How employees use it.** Employees never see the password. They use:
- `db.schema` to see tables and columns;
- `db.query` to read. Each query is one statement, run in a read-only transaction that is always
  rolled back, with a 10-second timeout and at most 200 rows;
- `db.execute` to write, only on read & write connections. It's audited as an external action with
  the exact SQL.

The platform, not the sandbox, connects to the database. Agent code in the sandbox still has no
network.

## 4. Sandbox (required for production)

Agents run commands such as tests and builds. In production these **must** run in an isolated
sandbox. The simplest option uses your own Docker:

```yaml
sandbox:
  kind: docker
  docker: { image: node:22-bookworm-slim, memory: 2g, cpus: 2, pids: 512, network: none }
```

Each command runs in a fresh container with no network, all capabilities dropped,
`no-new-privileges`, a read-only root filesystem, a non-root user, memory/CPU/PID limits, and only
the run's workspace mounted. Use an image that has your toolchain. With `network: none`, dependency
installs must already be in the image or the workspace.

For stronger isolation use a microVM (e.g. self-hosted E2B/Firecracker) or Kubernetes Agent Sandbox
with gVisor/Kata by implementing `SandboxPort` (`src/execution/sandbox.ts`).

`sandbox.allow_unisolated_local: true` runs commands as local processes. Those processes get a
scrubbed environment, timeouts, and output caps, but they are **not isolated**. Use it only on a
trusted evaluation machine.

## 5. Operating the platform

- `aic serve` starts the dashboard, the API (localhost only, token-protected), and the orchestrator.
  For multi-user or networked access, put it behind your SSO with MFA. Governance actions assume a
  step-up-authenticated CEO session.
- Only **one orchestrator per company** should run. Crashes are safe: leases expire, and runs are
  retried within their attempt limits.
- Customer policies: drop extra `.cedar` files into a `policies/` folder next to your templates.
  Baseline `forbid` rules cannot be weakened.

## Team access

The owner token printed by `aic serve` acts as the CEO. Give teammates their own tokens:

```bash
aic users add "Ava Patel" --role approver   # decide approvals, accept work, curate team notes
aic users add "Sam Lee" --role viewer       # read-only
aic users revoke <user-or-token-id>
```

Roles are enforced by the policy engine on every action. Governance (hiring, modes, emergency
stop, team definitions) requires the owner session or a fresh Google sign-in.

### Sign in with Google (optional)

People can sign in with their Google account instead of a token. Only emails the CEO added get in.
Google proves the email; the platform decides what that person may do.

1. In **your** Google Cloud project: APIs & Services → Credentials → Create credentials → OAuth client
   ID → *Web application*. Add the authorized redirect URI `http://localhost:4100/auth/google/callback`.
   Use your public URL instead if you serve the dashboard elsewhere; production must use `https://`.
2. Put the secret in `.env`: `GOOGLE_CLIENT_SECRET=...`. Optionally set `AIC_SESSION_SECRET`;
   otherwise a key is generated into your storage directory.
3. Add to `aic.config.yaml`:
   ```yaml
   auth:
     google:
       client_id: 1234-abc.apps.googleusercontent.com
       public_url: http://localhost:4100
       # allowed_domain: example.com   # only accounts from your Google Workspace domain
   ```
4. Give each person an email: `aic users email ceo you@example.com` and
   `aic users add "Ava Patel" --role approver --email ava@example.com`.

How it works:
- **Sign-in flow.** Authorization code with PKCE, plus state and nonce checks. The ID token is
  fetched directly from Google's token endpoint, and its issuer, audience, expiry, nonce and verified
  email are all checked.
- **Sessions.** Sessions are HMAC-signed, HttpOnly, SameSite=Lax cookies lasting 12 hours.
- **CSRF protection.** Dashboard writes made with a session cookie must carry the dashboard's own
  `x-requested-with` header, and the server enables no CORS.
- **Step-up for governance.** Governance needs a sign-in from the last 15 minutes. Otherwise the
  dashboard sends you back to Google to re-authenticate (`max_age=0`), and you repeat the action.

## CI as a regression signal

Point your CI at `POST /api/hooks/ci` with JSON `{ "sha", "status": "success"|"failure", "name", "url", "branch", "delivery_id" }`
and header `x-aic-signature: sha256=<HMAC-SHA256 of the raw body with AIC_CI_WEBHOOK_SECRET>`. A
failure on a commit the platform produced or merged is attributed through the ledger and reopens the
responsible task, with the CI link included as feedback. Redeliveries with the same `delivery_id` are
ignored. The platform also re-runs each task's checks on the integration branch after every merge.

## Readiness check

`aic doctor` checks the database, ledger integrity, provider keys and prices, reviewer model-family
independence, the team catalog, code hosting, sandbox isolation, secrets, and dashboard access. It
tells you what to fix before production.

## Production checklist

- [ ] PostgreSQL with PITR backups; `production-roles.sql` applied
- [ ] Model profiles for every role; reviewers on a different model family
- [ ] Isolated sandbox implemented; `allow_unisolated_local` disabled
- [ ] Code host with branch protection on the base branch; least-privilege token
- [ ] `AIC_CREDENTIAL_SECRET` set from your secret manager
- [ ] Google sign-in (or your SSO) with MFA on the Google accounts; dashboard served over HTTPS; `AIC_DASHBOARD_TOKEN` and `AIC_SESSION_SECRET` set
- [ ] `AIC_SPEND_CAP_USD` and a provider-side budget limit
- [ ] Operating modes chosen per department (finance, legal, people ops default to Supervised)
- [ ] `aic audit` scheduled; alerts on failure
