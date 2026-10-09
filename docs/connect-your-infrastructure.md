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

Each role can use a different model. Keys are referenced by environment-variable name and are never
written to config files or the ledger.

| Provider | `provider` | Notes |
|---|---|---|
| OpenAI, Azure OpenAI, vLLM, Ollama, LM Studio, any OpenAI-compatible endpoint | `openai_compatible` | set `base_url` |
| Anthropic | `anthropic` | |
| Offline demo | `scripted` | deterministic; demo scenarios only |

Hiring validates each role's required capabilities (structured output, tool calling, context size)
against the profile you assign. Put **reviewer roles on a different model family** than producers:
R2+ rubric criteria only count reviews whose model family differs from the producer's.

Budgets use the `price_per_million` you configure. The platform never hard-codes vendor prices.

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

Employees work only on `aic/<task>/<run>` branches. Accepted work merges into
`aic/<objective>/integration`. Merging into `main` happens only after the CEO approves a release
(`aic release`), and that approval is bound to the exact integration commit. Protect `main` with
branch protection so only the platform's release step can merge.

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
- [ ] Dashboard behind SSO + MFA; `AIC_DASHBOARD_TOKEN` set
- [ ] Operating modes chosen per department (finance, legal, people ops default to Supervised)
- [ ] `aic audit` scheduled; alerts on failure
