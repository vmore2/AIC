# The AI Company

[![CI](https://github.com/vmore2/AIC/actions/workflows/ci.yml/badge.svg)](https://github.com/vmore2/AIC/actions/workflows/ci.yml)

**Run a company of AI employees that you can actually trust.** You hire AI **teams** (engineering, design,
research, marketing, sales, support, finance, HR, legal, operations, analytics, or your own) and brief their
**team leads** in plain language. You approve their **plans**. The work comes back **independently
verified**, not merely claimed.

```
You ⇄ Team Lead  →  proposal  →  you confirm  →  plan  →  you approve  →  employees work
     →  platform checks every deliverable itself  →  independent reviewer  →  you accept  →  release
```

**Nothing is hosted for you.** The platform runs on your machine or your servers, against infrastructure
you own:

| You bring | Needed for | Default without it |
|---|---|---|
| **An AI model and its API key** (OpenAI, Anthropic, Gemini, OpenRouter, Groq, Ollama, or any OpenAI-compatible endpoint) | Real work | An offline demo model (free, no network) |
| **A PostgreSQL database** (16 or newer) | Production | An embedded database in the company folder |
| **A GitHub repository and token** | Delivering into your own repo | A local git repository in the company folder |
| **Docker** | Isolating the commands employees run | Plain local processes (evaluation only) |
| **A Google OAuth client** | Letting your team sign in with Google | Access tokens |

Your keys and passwords stay in your `.env` file or your own encrypted vault. Each one is only ever sent
to the service it belongs to (your AI provider, GitHub, your database). Employees never see them.

---

## Contents

- [Requirements](#requirements)
- [Quick start: a working company in five minutes (offline, free)](#quick-start)
- [The dashboard](#the-dashboard)
- [Set up your real company](#set-up-your-real-company)
- [Teams](#teams)
- [How a piece of work flows](#how-a-piece-of-work-flows)
- [Command reference](#command-reference)
- [Configuration reference](#configuration-reference)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Development and tests](#development-and-tests)
- [How it works](#how-it-works)
- [Status and limitations](#status-and-limitations)

---

## Requirements

- **Node.js 22 or newer** ([nodejs.org](https://nodejs.org)). Check with `node --version`.
- **Git** ([git-scm.com](https://git-scm.com)). Check with `git --version`.
- Optional: **Docker** to isolate employee commands; a **PostgreSQL 16+** database; an AI provider API key.

Works on Windows, macOS, and Linux.

---

## Quick start

This runs a complete company on your computer using the built-in offline demo model: no API key, no
network, no cost. You'll watch an engineering team plan, build, get caught by its own tests, fix the bug, pass
independent review, and release to `main`.

### 1. Install

```bash
git clone https://github.com/vmore2/AIC.git
cd AIC
npm ci
```

### 2. Create your company

```bash
npx aic init --company "Acme Inc" --ceo "Your Name"
```

This writes `aic.config.yaml` (your company's settings) and creates the company's database in `.aic/`.
Both are git-ignored, so your company never ends up in this repository.

### 3. Hire a team

```bash
npx aic teams                    # the team catalog
npx aic teams show engineering   # roles, structure, acceptance checks, approval gates
npx aic hire engineering         # hires a lead, two engineers, a QA engineer, and a code reviewer
```

### 4. Brief the team lead

```bash
npx aic chat engineering_lead "I want a slugify(text) helper for our URLs: lowercase words joined by single hyphens, punctuation removed, no leading or trailing hyphens."
```

The lead replies and drafts a **proposal**. Nothing happens until you confirm it, and the confirmation is
bound to the proposal's exact content:

```bash
npx aic confirm <proposal-id>    # the id is printed by the chat command
```

### 5. Approve the plan

```bash
npx aic run                      # the lead plans, then stops at your approval gate
npx aic inbox                    # everything waiting on you
npx aic proposal <plan-id>       # tasks, owners, acceptance checks, requirement coverage
npx aic approve <plan-id>
```

### 6. Let the team work

```bash
npx aic run
```

The engineer builds on its own branch and submits. The platform then runs the tests itself, on a fresh
checkout of the exact submitted commit. In the demo, the first attempt has a bug: the tests catch it, the
false "done" claim is recorded as contradicted, and the engineer fixes it on the second attempt. Then the
QA engineer writes independent acceptance tests, and a code reviewer reviews the change in a clean context.

### 7. See the truth and release

```bash
npx aic status                   # verified progress vs claimed progress
npx aic task <task-id>           # claim vs evidence for one task
npx aic release <objective-id>   # you approve merging the verified work to main
npx aic audit                    # verifies the tamper-evident ledger
```

### 8. Open the dashboard

```bash
npx aic serve
```

Open the link it prints (`http://127.0.0.1:4100/#token=…`). Everything above can also be done there.

> The demo model plays only this scenario. For your own work, [connect a real model](#2-connect-an-ai-model).
> It takes two minutes in the dashboard.

---

## The dashboard

`npx aic serve` starts the dashboard, the API, and the background worker that keeps your company running.
It listens on `127.0.0.1` only, and every request needs a token or a Google sign-in.

| Page | What you do there |
|---|---|
| **Home** | What needs you, who is working, and recent activity |
| **Decisions** | Approve plans, accept work, answer questions, connect databases, release (keyboard shortcuts) |
| **Work** | Every objective: its pipeline, its task board, and its requirements; start new objectives |
| **Company** | The live floor; **Hire a team**; **Design a team** (the team builder) |
| **Talk** | Chat with team leads; their proposals appear as cards you confirm or decline |
| **Setup** | AI models and keys, who uses which model, tech stack, databases, standing instructions |
| **People** | Invite teammates by Google email, set roles, remove access |
| **Audit** | The full, tamper-evident history |

Hold the **Stop** button to stop everything at once (an emergency stop). Press **Ctrl K** for the command palette.

---

## Set up your real company

### 1. Where your company lives

A company is a folder containing these files:

| File | What it is | Commit it? |
|---|---|---|
| `aic.config.yaml` | Settings: models, database, code hosting, sandbox, sign-in. Names env variables, never contains secrets | Yes (in *your* company repo) |
| `.env` | Your secrets: API keys, tokens, passwords. Start from [`.env.example`](.env.example) | **Never** |
| `teams/` | Your custom teams | Yes |
| `policies/` | Optional extra Cedar policies | Yes |
| `.aic/` | The embedded database, encrypted vault, workspaces, transcripts | No (back it up) |

There are two ways to run it:

- **In this folder** (simplest): run `npx aic …` here. All company files are git-ignored, so `git pull`
  updates the platform without touching your company.
- **In a separate folder**: install the command once, then use it anywhere:
  ```bash
  npm install -g .                 # from this repository; afterwards `aic` works everywhere
  mkdir ~/acme && cd ~/acme && aic init --company "Acme Inc"
  ```
  The examples below use `npx aic`. With the global install, `aic` works the same.

`.env` is read from the folder you run `aic` in, and from the folder that contains `aic.config.yaml`.
Real environment variables always win.

### 2. Connect an AI model

**The easy way: the dashboard.**
1. Go to **Setup → AI models → Add a provider** and pick yours.
2. Paste the key. It is checked for free (by listing the provider's models), then encrypted into your
   vault (`.aic/storage/secrets.vault.json`). The database keeps only a fingerprint.
3. Pick the models your employees may use and confirm their prices; budgets and the spend cap use them.
4. Star a default model, and adjust any role under **Who uses which model**.

**Or in `aic.config.yaml`**, with the key in `.env`:

```yaml
models:
  profiles:
    - key: primary
      provider: openai_compatible          # OpenAI, Azure OpenAI, Gemini, Groq, OpenRouter, vLLM, Ollama, LM Studio…
      base_url: https://api.openai.com/v1
      model: gpt-4.1-mini
      api_key_env: OPENAI_API_KEY          # the NAME of the variable in .env, never the key itself
      family: openai
      price_per_million: { input: 0.40, output: 1.60 }   # your prices, used for budgets and the spend cap
    - key: reviewer
      provider: anthropic
      model: claude-sonnet-5-5
      api_key_env: ANTHROPIC_API_KEY
      family: anthropic
      price_per_million: { input: 2.00, output: 10.00 }
  default: primary
  assignments: { code_reviewer: reviewer }  # role key → profile; reviewers on a different model family
```

```bash
# .env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
AIC_SPEND_CAP_USD=5.00
```

Advice from real runs:
- **Give team leads a strong model.** Planning multi-step work is the hardest job, and small models struggle with it.
- **Put reviewers on a different model family** than the people they review. For high-risk work, reviews from
  the same family don't count.
- **Set `AIC_SPEND_CAP_USD`.** It caps the lifetime spend of each API key across every run and process.
  Before each call the worst case is checked, and a call that could cross the cap is refused. Also set a
  budget limit in your provider's console as a backstop.
- **Requirements that name files** (e.g. "in `src/slugify.js`") give the most reliable results.

### 3. Deliver into your GitHub repository

```yaml
code_hosting:
  kind: github
  repo: your-org/your-repo
  token_env: GITHUB_TOKEN
  base_branch: main
```

Put a [fine-grained token](https://github.com/settings/personal-access-tokens) in `.env` as `GITHUB_TOKEN`.
It needs access to that one repository, with **Contents** and **Pull requests** set to read and write.

Employees only ever push to `aic/<task>/<run>` branches. Accepted work merges into an integration branch for
each objective. Only your release approval opens a pull request to `main`, and the merge is **pinned to the
exact commit you approved**. Protect `main` with branch protection; your required checks still apply.

### 4. Isolate employee commands with Docker

```yaml
sandbox:
  kind: docker
  docker: { image: node:22-bookworm-slim, memory: 2g, cpus: 2, network: none }
```

Each command runs in a fresh container with no network, no Linux capabilities, a read-only root
filesystem, a non-root user, memory/CPU/process limits, and only the run's workspace mounted. Use an image
that has your toolchain. Pull it once with `docker pull node:22-bookworm-slim`. Commands never run as root.
On Linux they run as the user the platform runs as, so run the platform as a regular user (`aic doctor`
checks that sandboxed commands can read and write a workspace).

Without Docker, `sandbox: { kind: local, allow_unisolated_local: true }` runs commands as plain local
processes, with a scrubbed environment and timeouts but **no isolation**. Use that only for evaluation on a
machine you trust.

### 5. Use your own PostgreSQL

```yaml
database:
  url_env: DATABASE_URL
```

```bash
# .env
DATABASE_URL=postgres://user:password@db.example.com:5432/aic
```

PostgreSQL 16 or newer (tested on 16 and 17). Tables are created on first start. For production, also
lock it down with [`docs/production-roles.sql`](docs/production-roles.sql), so the platform runs as a role
that cannot rewrite history. Enable point-in-time recovery backups.

### 6. Let your team sign in

The owner token printed by `aic serve` acts as you, the CEO. Set `AIC_DASHBOARD_TOKEN` in `.env` to keep it
stable across restarts. For teammates:

```bash
npx aic users add "Ava Patel" --role approver   # decides approvals, accepts work
npx aic users add "Sam Lee" --role viewer       # read-only
```

Each command prints a personal access token. For **Google sign-in**, create an OAuth client in *your* Google
Cloud project, then add `auth.google` to the config and `GOOGLE_CLIENT_SECRET` to `.env`. Step-by-step:
[docs/connect-your-infrastructure.md](docs/connect-your-infrastructure.md#sign-in-with-google-optional).

### 7. Check readiness

```bash
npx aic doctor
```

`aic doctor` checks your database, ledger integrity, model keys and prices, reviewer independence, teams,
code hosting, sandbox, and secrets, and says exactly what to fix. When it reports no blocking issues, you are
ready to evaluate. The full production checklist is in
[docs/connect-your-infrastructure.md](docs/connect-your-infrastructure.md#production-checklist).

---

## Teams

Eleven recommended teams ship with the platform (`templates/recommended/`):

| Team | Key | Lead | Members | Independent reviewer | Default oversight | Never without a human |
|---|---|---|---|---|---|---|
| Customer Support | `customer_support` | Support Lead | Support Agent ×4 | Support Quality Reviewer | Exceptions | Refunds; Account deletion; Legal or security responses |
| Data & Analytics | `data_analytics` | Analytics Lead | Data Analyst ×2 | Analytics Reviewer | Exceptions | Publishing metrics externally |
| Software Engineering | `engineering` | Engineering Lead | Software Engineer ×2, QA Engineer | Code Reviewer | Plan gates | Merging to protected branches; Production deployments |
| Finance | `finance` | Finance Controller | Accountant ×2, Financial Analyst | Finance Reviewer | Supervised | Payments; Posting journal entries; Changing payment details |
| Legal Operations | `legal` | Legal Operations Lead | Contract Analyst ×2 | Legal QA Reviewer | Supervised | Signing or sending contracts; Legal conclusions; Communications with counterparties |
| Marketing | `marketing` | Marketing Lead | Content Writer ×2, Channel Operator | Brand & Claims Reviewer | Milestones | Publishing externally; Paid spend changes |
| Business Operations | `operations` | Operations Lead | Operations Analyst ×2 | Process Auditor | Milestones | Changing production systems directly; Vendor commitments |
| People Operations (HR) | `people_ops` | People Operations Lead | People Operations Specialist, Recruiting Coordinator | HR Compliance Reviewer | Supervised | Screening or ranking candidates; Compensation decisions; Terminations; Updating HR records |
| Product Design | `product_design` | Design Lead | Product Designer ×2, UX Writer | Accessibility Reviewer | Plan gates | Publishing brand-defining visual changes |
| Research & Market Intelligence | `research` | Research Lead | Research Analyst ×3 | Fact Checker | Exceptions | Contacting external parties |
| Sales | `sales` | Sales Lead | Account Researcher ×2, Sales Development Representative ×2 | Sales Compliance Reviewer | Milestones | Pricing or contractual commitments; Sending external messages |

**Creating your own team means listing its roles.** You write a title, one sentence about what the role does,
and what it delivers. The platform derives the tools, acceptance checks, review chain, reporting lines,
approval gates, budgets, and prompts. It then refuses unsafe designs:

```yaml
team: growth_marketing
name: Growth Marketing
purpose: Find and test growth channels with reviewed experiment briefs and honest metrics.
roles:
  - title: Growth Lead
    lead: true
    does: Turns growth goals into experiment plans with measurable success criteria.
  - title: Growth Analyst
    count: 2
    does: Designs experiments and writes a brief with hypothesis, setup, and success metric.
    delivers: [{ document: growth/EXPERIMENT.md, sections: [Hypothesis, Setup, Success Metric] }]
    human_judges: The CEO approves the experiment before launch
  - title: Growth Reviewer
    reviews: [Growth Analyst]
    does: Independently checks each brief for a testable hypothesis and an honest metric.
```

```bash
npx aic teams new growth_marketing --name "Growth Marketing"   # or: Dashboard → Company → Design a team
npx aic teams check growth_marketing
npx aic hire growth_marketing
```

**→ Full guide: [docs/creating-teams.md](docs/creating-teams.md)**. It covers a five-minute tutorial, every
field, recipes, the rules every team must pass, and fixes for every error message.

---

## How a piece of work flows

```
CEO ⇄ Team Lead (conversation) → proposal (directive) → CEO confirms (bound to its exact content)
  → objective with verbatim requirements → lead's plan (tasks, owners, acceptance checks, coverage)
  → platform validation → CEO approval (depends on the oversight level) → tasks with frozen criteria
  → employee works on its own branch (through the Tool Gateway; budgets; leases)
  → submission (a claim) → platform checks on a fresh checkout → independent review in a clean context
  → Completion Evaluator → accepted | changes requested (feedback → next attempt) | uncertain | human acceptance
  → merged into the objective's integration branch → objective complete → CEO-approved release to main
```

Along the way:
- employees can ask questions, and leads answer what's within their authority (anything else comes to you);
- you can change a requirement mid-flight, and the lead re-plans only the affected work;
- an emergency stop fences every in-flight run.

---

## Command reference

Run `npx aic help` for the full list. The essentials:

| Command | What it does |
|---|---|
| `aic init [--company "Acme"] [--ceo "Name"]` | Create `aic.config.yaml` (if missing) and the company |
| `aic teams` · `teams show <team>` · `teams new <key>` · `teams check [team]` · `teams capabilities` | Browse, design, and validate teams |
| `aic hire <team>` · `aic org` | Hire a team; see your org chart with live workload |
| `aic chat <role> "message"` | Talk to a team lead |
| `aic directive <id>` · `confirm <id>` · `decline <id> -m "why"` | Review, confirm, or decline a lead's proposal |
| `aic objective <team> --title "…" --req "REQ-1=…" --budget 50` | Start an objective directly |
| `aic run [--timeout 600]` | Let the company work until it needs you |
| `aic inbox` | Everything waiting on you |
| `aic proposal <id>` · `approve <id>` · `changes <id> -m "…"` | Review and decide a plan |
| `aic status` · `aic task <id>` | Verified vs claimed progress; claim vs evidence |
| `aic accept <task>` · `reject <task> -m "…"` · `resolve <question> "answer"` | Human decisions |
| `aic requirement <objective> <REQ-n> "new text" -m "why"` | Change a requirement; the lead re-plans |
| `aic reassign <task> <employee> -m "why"` | Move a task to another team member |
| `aic release <objective>` | Approve merging verified work to your main branch |
| `aic mode <M1..M6> [--department key] -m "why"` | Change the oversight level |
| `aic stop -m "why"` · `aic resume --ack` | Emergency stop / resume |
| `aic users` · `users add "Name" --role approver` · `users revoke <id>` · `users email <id\|ceo> <email>` | Who has access |
| `aic notes [approve\|reject <id>]` | Team knowledge proposed by employees (visible to the team only after you approve it) |
| `aic doctor` · `aic audit` | Readiness checks; verify the tamper-evident ledger |
| `aic serve [--port 4100]` | Dashboard + API + background worker |

Add `--config path/to/aic.config.yaml` to use another company folder, and `--verbose` for details.

---

## Configuration reference

`aic init` writes a commented `aic.config.yaml`. Every key:

| Key | Meaning | Default |
|---|---|---|
| `company.name` | Your company's name | required |
| `database` | `{ local_path: .aic/db }` (embedded) or `{ url_env: DATABASE_URL }` (your PostgreSQL) | embedded |
| `models.profiles[]` | `key`, `provider` (`openai_compatible` · `anthropic` · `scripted`), `model`, `base_url`, `api_key_env`, `family`, `price_per_million`, `context_tokens` | the offline demo model |
| `models.default` · `models.assignments` | Default profile; role key → profile | |
| `code_hosting` | `{ kind: local, path }` or `{ kind: github, repo, token_env, base_branch, api_url }` | local repo in `.aic/repo` |
| `sandbox` | `{ kind: docker, docker: { image, memory, cpus, pids, network, user } }` or `{ kind: local, allow_unisolated_local: true }` | local, refused unless allowed |
| `defaults.mode` | Oversight level for new teams (`M1`…`M5`) | `M4` (plan gates) |
| `defaults.project_settings.test_command` | How code is tested | `npm test` (starter: `node --test`) |
| `auth.google` | `client_id`, `client_secret_env`, `public_url`, `allowed_domain` | off |
| `storage_path` · `teams_path` · `policies_path` | Where data, custom teams, and extra policies live | `.aic/storage` · `teams` · `policies` |
| `master_key_env` · `credential_secret_env` · `auth.session_secret_env` | Env variables holding platform keys | generated into storage if unset |

All secrets are in [`.env.example`](.env.example), with a comment on each. Copy it to `.env` and fill in what
you use.

---

## Updating

```bash
git pull
npm ci
```

Database changes apply automatically on the next start. If you run the platform as the restricted production
role, follow the note at the top of [`docs/production-roles.sql`](docs/production-roles.sql) once after
updating. Your company files (`aic.config.yaml`, `.env`, `teams/`, `.aic/`) are never touched by an update.

---

## Troubleshooting

| You see | Do this |
|---|---|
| `Config not found … Run aic init` | Run `npx aic init` in your company folder, or pass `--config path/to/aic.config.yaml` |
| `Environment variable X is not set` | Add `X=…` to `.env` next to `aic.config.yaml` (see `.env.example`) |
| `… looks like a secret value, not a variable name` | `*_env` fields take the **name** of a variable (e.g. `GITHUB_TOKEN`). Put the secret itself in `.env` |
| An employee raises *"running on the offline scripted model"* | Connect a real model ([step 2](#2-connect-an-ai-model)), then resolve the blocker in **Decisions** |
| `Spend cap reached` | Intended: the cap protects you. Raise `AIC_SPEND_CAP_USD` deliberately to continue |
| `aic doctor`: Sandbox fails with Docker | Start Docker Desktop and `docker pull node:22-bookworm-slim` (or your image) |
| Windows: `Filename too long`, or doctor warns about storage path length | Keep the company folder near the drive root, or set `storage_path: C:/aic/storage` |
| Port 4100 in use | `npx aic serve --port 4200` (and update `auth.google.public_url` if you use Google sign-in) |
| `npm audit` reports issues | It flags `vitest`, the test runner, which is a development dependency. A production install (`npm ci --omit=dev`) reports 0 vulnerabilities |
| Anything else | Re-run with `--verbose` for the full error, and run `npx aic doctor` |

---

## Development and tests

```bash
npm test             # the full suite (Docker/PostgreSQL/MySQL tests run when Docker is available)
npm run typecheck
```

The suite covers:
- property-based state-machine tests and ledger invariants;
- red-team tests of the Tool Gateway;
- team specs and the docs' own examples;
- requirement changes and model adapters;
- Docker sandbox isolation, real PostgreSQL (including the restricted production role) and MySQL;
- Google sign-in against a mock;
- conversations, end to end, and the README quickstart through the real `aic` command.

**Real-model tests are opt-in and spend-capped.** They need `AIC_LIVE=1`, `OPENAI_API_KEY`, and
`AIC_SPEND_CAP_USD`; see `test/live*.test.ts`. CI never runs them.

| Path | What it is |
|---|---|
| `src/domain/` | Pure rules: task state machine, Completion Evaluator, delegation, oversight modes |
| `src/org/` | Team spec compiler, catalog, schemas, tool catalog, architecture validator |
| `src/ledger/` | Schema, Transition Engine (single writer, idempotent, hash-chained), commands |
| `src/policy/` | Cedar baseline policies and the embedded policy engine (fails closed) |
| `src/runtime/` | Model adapters, Tool Gateway, agent loop, context assembly, spend cap, offline demo model |
| `src/execution/` | Git workspaces on your code host, GitHub releases, sandboxes |
| `src/verification/` | Platform checks on fresh checkouts |
| `src/orchestrator/` | Outbox-driven orchestrator with drift repair (rebuildable from the ledger) |
| `src/reports/`, `src/api/`, `src/cli/` | Ledger-derived views, dashboard and API, `aic` CLI |
| `templates/recommended/` | The recommended teams |
| `docs/` | [Creating teams](docs/creating-teams.md), [connecting your infrastructure](docs/connect-your-infrastructure.md), production database roles |
| `architecture.md` | The full architecture and its research basis |

---

## How it works

> The AI reasons. The platform authorizes. The ledger records. The execution layer acts.
> Independent verification checks. The CEO keeps the control they configure.

- **The ledger is the source of truth.** Task status, approvals, acceptance criteria, and evidence live in an
  append-only, hash-chained PostgreSQL ledger. Employees can only *request* changes through validated commands.
- **Nobody self-certifies.**
  - An employee's "done" is recorded as a *claim*.
  - Acceptance comes from a deterministic Completion Evaluator, over evidence produced independently against
    the exact submitted commit.
  - Reviewers work in a clean context, preferably on a different model family.
  - Humans accept higher-risk work.
- **Conversation never changes work by itself.** A team lead turns your request into a structured proposal.
  Nothing happens until you confirm that exact content.
- **Bounded autonomy.**
  - Every run is budgeted, loop-detected, and fenced by a lease.
  - Oversight levels from Autonomous to Supervised are enforced by Cedar policies, not by prompts.
  - An emergency stop fences every in-flight run.

The full design and its rationale are in [`architecture.md`](architecture.md).

---

## Status and limitations

This is a working foundation, not a finished product. What is real and tested end to end: the ledger,
transition engine, Cedar authorization, verification pipeline, orchestration, conversations and
proposals, the CLI and dashboard, GitHub releases, the Docker sandbox, and database connections.

**Verified with real models.** A four-requirement engineering objective and a Product Design objective both
complete end to end on gpt-4.1-mini, each for a few cents. Each mistake those runs exposed is now caught by
the platform and covered by a regression test:
- test runs that executed zero tests;
- files a requirement names but the delivered work lacks;
- QA tests that check a mock instead of the real code;
- work put in the wrong file;
- accepted work that never merged;
- questions nobody answered.

**Verified live on GitHub.** A real objective was released through a pull request merged at exactly the
approved commit, with no token in any clone, log, or transcript.

Known gaps:
- **Connectors.** Web research, email sending, CRM, tickets, design tools, and other business systems are
  part of the team architecture, with risk classes and approval gates. But their tools need connectors that
  don't exist yet, and until they do they are refused. Working today: code, documents, databases
  (PostgreSQL/MySQL), and email drafts.
- **One orchestrator per company.** Crashes are safe (leases expire, runs are retried), but horizontal
  scale-out is future work.
- **Sign-in.** Google and access tokens only; no SAML or other SSO yet. Serve the dashboard over HTTPS
  when it isn't on localhost.
- **Sandboxes.** Docker is built in. MicroVM/gVisor isolation plugs into the same `SandboxPort` interface
  but isn't included.
- **Hired teams.** A hired team keeps the role definitions it was hired with. Edits to a team file apply
  to new hires.
- **The offline demo model** handles only the bundled demo scenario.
