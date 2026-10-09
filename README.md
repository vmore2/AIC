# The AI Company

A governed AI-workforce platform. A CEO hires AI **departments** (engineering, design, research,
marketing, sales, support, finance, people ops, legal, operations, analytics, or custom ones), talks to
their **team leads**, approves their **proposals**, and gets work that is **independently verified**,
not merely claimed.

**You host nothing.** Each company runs the platform against **its own** infrastructure:

| The customer brings | Configured in `aic.config.yaml` |
|---|---|
| A PostgreSQL database (or the embedded one for evaluation) | `database` |
| Model providers and API keys (OpenAI-compatible, Anthropic, self-hosted via vLLM/Ollama) | `models.profiles`, keys by env var name |
| Code / deliverables hosting (a local git repo, or their GitHub repo) | `code_hosting` |
| An isolated sandbox for agent-run commands (production) | `sandbox` |

The platform owns the **architecture of employees and the system that governs them**: role and
department templates, delegation rules, the authoritative work ledger, authorization, verification,
and CEO oversight. The full design and its rationale are in [`architecture.md`](architecture.md).

---

## The core idea

> The AI reasons. The platform authorizes. The ledger records. The execution layer acts.
> Independent verification checks. The CEO keeps the control they configure.

- **The ledger is the source of truth.** Task status, approvals, criteria, and evidence live in an
  append-only, hash-chained PostgreSQL ledger. Agents can only *request* changes through validated commands.
- **Nobody self-certifies.** An employee's "done" is recorded as a *claim*. Acceptance comes from a
  deterministic Completion Evaluator over evidence produced independently against the exact submitted commit.
  Reviewers run in a clean context, preferably on a different model family. Humans accept higher-risk work.
- **Conversation never changes work by itself.** A team lead turns your request into a structured
  proposal. Nothing happens until you confirm that exact content, which is bound by hash.
- **Bounded autonomy.** Every run is budgeted, loop-detected, and fenced by a lease epoch. Six operating
  modes, from Autonomous to Safe Mode, are enforced by Cedar policies, not by prompts. An emergency stop
  fences every in-flight run.

## Quick start (local evaluation, no network, no cost)

Requires Node.js ≥ 22 and git.

```bash
npm install
npx aic init --company "Acme Inc" --ceo "Your Name"   # writes aic.config.yaml + creates the ledger
npx aic org departments                                # 11 department templates
npx aic org show engineering                           # roles, structure, workflows, safeguards
npx aic hire engineering                               # validates model capabilities per role

npx aic chat engineering_lead "I want a slugify(text) helper for our URLs: lowercase words joined by single hyphens, punctuation removed, no leading or trailing hyphens."
npx aic confirm <directive-id>                         # the lead's proposal becomes an objective
npx aic run                                            # the lead plans, then stops at your approval gate
npx aic inbox                                          # → the plan, with owners, criteria, coverage
npx aic proposal <proposal-id>
npx aic approve <proposal-id>
npx aic run                                            # engineers build; independent tests + review verify
npx aic status                                         # verified vs claimed progress
npx aic task <task-id>                                 # claim vs evidence; contradicted claims are flagged
npx aic release <objective-id>                         # CEO-approved merge of accepted work to main
npx aic audit                                          # verify the tamper-evident ledger
npx aic serve                                          # local dashboard + API (localhost, token-protected)
```

The starter config uses a **scripted model**. It is a deterministic offline stand-in that talks to the
platform through the same tool calls a real model would, so you can watch the whole system work
without paying for tokens. It handles only the bundled demo scenarios. For real work, add your own
model profile:

```yaml
models:
  profiles:
    - key: primary
      provider: openai_compatible          # OpenAI, Azure OpenAI, vLLM, Ollama, LM Studio, …
      base_url: https://api.openai.com/v1
      model: <your model>
      api_key_env: OPENAI_API_KEY
      family: openai
      price_per_million: { input: 0, output: 0 }   # your prices; used for budgets
    - key: reviewer
      provider: anthropic
      model: <your model>
      api_key_env: ANTHROPIC_API_KEY
      family: anthropic
  default: primary
  assignments: { code_reviewer: reviewer }  # reviewers on a different model family
```

See [`docs/connect-your-infrastructure.md`](docs/connect-your-infrastructure.md) for the database, GitHub,
sandbox, and production checklist.

## Departments (team architecture)

| Department | Lead | Team | Independent reviewer | Default mode | Never autonomous |
|---|---|---|---|---|---|
| Software Engineering | Engineering Lead | Software Engineers, QA Engineer | Code Reviewer | Plan Gates | merging to protected branches, deploys |
| Product Design | Design Lead | Product Designers, UX Writer | Accessibility & Design Reviewer | Plan Gates | brand-defining changes |
| Research & Market Intelligence | Research Lead | Research Analysts | Fact Checker | Exception Escalation | contacting external parties |
| Marketing | Marketing Lead | Content Writers, Channel Operator | Brand & Claims Reviewer | Milestone Gates | external publishing, paid spend |
| Sales | Sales Lead | Account Researchers, SDRs | Sales Compliance Reviewer | Milestone Gates | pricing/contract commitments, sending |
| Customer Support | Support Lead | Support Agents (*mixed* Rule-of-Two profile) | Support Quality Reviewer | Exception Escalation | refunds, legal/security replies |
| Finance | Finance Controller | Accountants, Financial Analyst | Finance Reviewer | Supervised | payments, postings |
| People Operations | People Ops Lead | Specialist, Recruiting Coordinator | HR Compliance Reviewer | Supervised | screening/ranking candidates |
| Legal Operations | Legal Ops Lead | Contract Analysts | Legal QA Reviewer | Supervised | legal conclusions, signing |
| Business Operations | Operations Lead | Operations Analysts | Process Auditor | Milestone Gates | changing production systems |
| Data & Analytics | Analytics Lead | Data Analysts | Analytics Reviewer | Exception Escalation | publishing metrics externally |

Every template is data (`templates/departments/*.yaml`) and is checked by `aic org validate` against
the architecture rules:
- separation of duties (reviewers sit outside the producer's chain and never hold side-effecting tools);
- the Rule of Two (no role may combine untrusted input, private data, and external communication unless
  every external action is approval-gated);
- hierarchy depth ≤ 3 and span of control ≤ 8;
- deterministic verification for every artifact-producing role;
- human gates for high-risk departments;
- human review for work that significantly affects individuals.

To build your own department, see [`docs/designing-departments.md`](docs/designing-departments.md).

## How a piece of work flows

```
CEO ⇄ Team Lead (conversation) → proposal (directive) → CEO confirms (hash-bound)
  → Objective with verbatim requirements → Lead's plan proposal (tasks, owners, criteria, coverage)
  → platform validation → CEO approval (mode-dependent) → tasks with frozen criteria
  → employee runs on isolated branches (via Tool Gateway, budgets, lease epochs)
  → submission (a claim) → deterministic verifiers on a fresh checkout → independent review run
  → Completion Evaluator → accepted | changes requested (feedback → next attempt) | uncertain | human acceptance
  → merged to the objective's integration branch → objective complete → CEO-approved release to main
```

## Repository map

| Path | What it is |
|---|---|
| `architecture.md` | Full architecture and research basis |
| `templates/departments/` | Department + role templates (the employee architecture) |
| `src/domain/` | Pure rules: state machine, Completion Evaluator, delegation attenuation, modes |
| `src/org/` | Template schemas, tool catalog (risk classes, Rule-of-Two traits), architecture validator |
| `src/ledger/` | Schema, Transition Engine (single writer, idempotent, hash-chained), commands |
| `src/policy/` | Cedar baseline policies + embedded PDP (fail closed) |
| `src/runtime/` | Model adapters, Tool Gateway, agent loop, context assembly, scripted model |
| `src/execution/` | Git-backed workspaces on the customer's code host; sandbox port |
| `src/verification/` | Deterministic verifiers on fresh checkouts |
| `src/orchestrator/` | Outbox-driven orchestrator with drift repair (rebuildable from the ledger) |
| `src/reports/`, `src/api/`, `src/cli/` | Ledger-derived views, local dashboard/API, `aic` CLI |
| `test/` | Property tests, invariants, red-team gateway tests, end-to-end runs |

## Tests

```bash
npm test          # 51 tests: property-based state machine, ledger invariants, gateway red-team, conversations, end-to-end
npm run typecheck
```

## Status and honest limitations

This is a working **Phase 1 foundation**. It is not a finished product. What is real: the ledger,
transition engine, Cedar authorization, verification pipeline, orchestration, conversations/proposals,
CLI and dashboard, all exercised end to end by tests.

Known gaps, deliberately documented:
- **Sandbox isolation is the customer's to provide.** The bundled local sandbox runs commands as plain
  processes (scrubbed env, timeouts) and is for evaluation only. Production needs a microVM or gVisor sandbox
  behind `SandboxPort` (architecture.md §16.7).
- **Connector tools** (GitHub PRs, email, CRM, design tools, …) are declared in the tool catalog with risk
  classes, but beyond git push/merge they need customer-installed connectors. Uninstalled connectors are refused.
- **Single orchestrator process per company.** Leases, fencing, and drift repair make crashes safe, but
  horizontal scale-out (Temporal adapter, architecture.md §4.3) is future work.
- **Local CLI = trusted CEO session.** Networked deployments need SSO + MFA in front of the API.
- **Scripted model** handles only demo scenarios; real work needs a customer model profile.
- Requirement change requests, reopen-on-regression from CI, memory curation UI, voice meetings, and the
  template marketplace are designed in architecture.md but not yet built.
