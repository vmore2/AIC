# Designing teams

Defining a team means listing its roles. For each role you write a title, a sentence about what it
does, what it works with, and what it delivers. The platform derives everything else: tools,
acceptance criteria, review chain, Rule-of-Two profile, reporting lines, workflow gates, budgets,
and prompts. It then enforces the same architecture rules on the result as on every other team.

There are two catalogs:

| Catalog | Where | Who maintains it |
|---|---|---|
| **Recommended teams** | `templates/recommended/` (ships with the platform) | The AI Company: your curated teams, e.g. Design and HR |
| **Custom teams** | the company's `teams/` folder (`teams_path` in `aic.config.yaml`) | Each company |

A custom team with the same key as a recommended team overrides it for that company. That is how a
company adopts a recommended team and then adjusts it.

## Three ways to create a team

1. **Dashboard → Build a team.** Fill in the roles in a form. *Check* shows exactly what the
   platform derived and any problems. *Save & hire* writes `teams/<key>.yaml` and hires the team.
2. **CLI:** `aic teams new growth_marketing --name "Growth Marketing"` writes a valid starter file.
   Edit the roles, then run `aic teams check growth_marketing` and `aic hire growth_marketing`.
3. **Copy a recommended team:** in the dashboard, click *Copy as custom team* on a short-spec team.

## The short team spec

```yaml
team: growth_marketing          # unique key (snake_case)
name: Growth Marketing
purpose: >
  Find and test growth channels with reviewed experiment briefs and honest metrics.
mode: plan_gates                # autonomous | exceptions | milestones | plan_gates | supervised
risk: standard                  # low | standard | high | critical
recommended: false              # true for teams you publish in templates/recommended
publisher: The AI Company       # optional

roles:
  - title: Growth Lead
    lead: true                  # exactly one; plans the work and reports to the CEO
    does: Turns growth goals into experiment plans with measurable success criteria.

  - title: Growth Analyst
    count: 2
    does: Designs experiments and writes a brief with hypothesis, setup, and success metric.
    works_with: [documents, analytics]
    delivers:
      - document: growth/EXPERIMENT.md
        sections: [Hypothesis, Setup, Success Metric]
    human_judges: The CEO approves the experiment before launch

  - title: Growth Reviewer
    reviews: [Growth Analyst]   # makes this an independent reviewer (reports to the CEO)
    does: Independently checks each brief for a testable hypothesis and an honest metric.

never_autonomous:
  - Spending money on ads
```

### Role fields

| Field | Meaning | Default |
|---|---|---|
| `title` | Role name; the key is derived from it (`Growth Analyst` → `growth_analyst`) | required |
| `does` | One or two sentences: the role's charter and core instruction | required |
| `count` | Seats to hire | 1 |
| `lead: true` | The team head: plans, delegates, reports to the CEO | — |
| `reviews: [titles]` | Independent reviewer of those roles; read-only tools; outside the producer chain | — |
| `qa: true` | Writes tests/checks independently of producers; reports to the CEO | — |
| `works_with` | Capabilities → tools (see below) | `[documents]` |
| `delivers` | `document` (+ `sections`), `file`, or `check: "<command>"`; each becomes a platform-verified acceptance criterion | a document at `<team>/<role>.md` |
| `human_judges` | A human must accept this role's work (adds a human criterion and gate) | — |
| `affects_people: true` | Work affecting individuals: always human-decided (GDPR Art. 22) | — |
| `reports_to` | Override the reporting line (another title, or `ceo`) | the lead |
| `instructions` | Extra instructions appended to the role prompt | — |
| `budget_per_run_usd` | Per-run spend ceiling | by role type |
| `key` | Explicit role key (needed if two teams use the same title) | from title |
| `advanced` | Any field of the full role schema, for fine control | — |

### Capabilities (`aic teams capabilities`)

| Capability | Tools | Note |
|---|---|---|
| `code` | `sandbox.exec`, `repo.commit_and_push` | Adds an "all tests pass" criterion (`${test_command}`) |
| `documents` | (file tools are always available) | |
| `web_research` | `web.search`, `web.fetch`, `docs.read_external` | Untrusted content → researcher profile |
| `design_files` | `design.read`, `design.write` | |
| `email_drafts` / `send_email` | `email.draft` / `+ email.send_external` | Sending always needs approval |
| `crm`, `tickets`, `analytics`, `finance_records`, `contracts`, `hr_records`, `calendar` | the matching connector tools | |
| `publish` | `social.publish` | Always needs approval |
| `customer_inbox` | inbound email, tickets, CRM, `support.reply_customer` | Replies always need approval |

Reviewers only receive the read-only tools of their capabilities.

## What the platform derives

- **Structure:** the lead reports to the CEO. Reviewers and QA report to the CEO, outside the
  producer chain. Everyone else reports to the lead.
- **Acceptance criteria per role:**
  - deterministic checks from `delivers`, plus tests for `code`;
  - an independent review criterion if someone `reviews` the role;
  - a human criterion from `human_judges` or `affects_people`.
- **Rule-of-Two profile:** builder, researcher, communicator, or mixed. A role that combines untrusted
  input, private data, and external communication is flagged, and each of its external actions needs
  human approval.
- **Workflow:** plan (CEO approval), then one stage per producing role, gated by review or human
  acceptance. High-risk teams get a final human acceptance stage.
- **Budgets, task kinds, prompts:** by role type and capabilities.

Run `aic teams show <team>` to see everything that was derived.

## The full template format (advanced)

Recommended teams can also use the full department format, as Engineering, Finance, and Legal do.
It lets you specify every tool, denied tool, budget, criterion, and workflow stage by hand. Both formats
pass through the same validator. See `templates/recommended/finance.yaml` for an example.

## Rules every team must pass (`aic teams check`)

| Rule | Why |
|---|---|
| One lead, reporting to the CEO; depth ≤ 3; span ≤ 8 | Accountability without deep, lossy hierarchies |
| Only leads hold delegation tools and propose plans | Delegation happens through the ledger |
| Reviewers record verdicts, hold no side-effecting tools, sit outside the producer chain | Separation of duties |
| Every artifact-producing role has a deterministic acceptance criterion | Verification a model can't argue past |
| Rule of Two | Limits prompt-injection blast radius |
| High-risk teams have a human gate in every workflow | Humans own consequential outcomes |
| Work affecting individuals has a human criterion | GDPR Art. 22 |
| Role keys are unique across the company | Unambiguous model assignments and audit |
