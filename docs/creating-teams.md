# Creating teams

A team is a department of AI employees: a **lead** who plans, **specialists** who produce the work, and
usually an independent **reviewer** or **QA** role who checks it. Creating a team means describing those
roles in a short YAML file. The platform derives the rest:

- the tools each role gets;
- acceptance criteria that are checked automatically;
- who reviews whom, and who reports to whom;
- the approval gates in the workflow;
- budgets and prompts.

It then refuses designs that break its safety rules, such as a reviewer who reports to the person they review.

This guide covers:

1. [Your first team in five minutes](#1-your-first-team-in-five-minutes)
2. [The same in the dashboard](#2-the-same-in-the-dashboard)
3. [Starting from a recommended team](#3-starting-from-a-recommended-team)
4. [The team file, field by field](#4-the-team-file-field-by-field)
5. [What the platform derives](#5-what-the-platform-derives)
6. [Recipes](#6-recipes)
7. [Rules every team must pass](#7-rules-every-team-must-pass)
8. [Fixing common errors](#8-fixing-common-errors)
9. [After you hire](#9-after-you-hire)
10. [Advanced: the full template format](#10-advanced-the-full-template-format)
11. [Publishing a recommended team](#11-publishing-a-recommended-team)

---

## 1. Your first team in five minutes

You need a company folder that has been initialized (`npx aic init`; see the [README](../README.md#quick-start)).

### Step 1: scaffold the file

```bash
npx aic teams new growth_marketing --name "Growth Marketing"
```

This writes `teams/growth_marketing.yaml`: a valid starter team with a lead, two specialists, and a reviewer.
Your custom teams live in the `teams/` folder next to `aic.config.yaml` (change it with `teams_path`).

### Step 2: describe the roles

Open the file and replace the placeholders with what this team really does:

```yaml
team: growth_marketing
name: Growth Marketing
purpose: >
  Find and test growth channels with reviewed experiment briefs and honest metrics.
mode: plan_gates          # the CEO approves every plan before work starts
risk: standard

roles:
  - title: Growth Lead
    lead: true
    does: Turns growth goals into experiment plans with measurable success criteria.

  - title: Growth Analyst
    count: 2
    does: Designs experiments and writes a brief with hypothesis, setup, and success metric.
    delivers:
      - document: growth/EXPERIMENT.md
        sections: [Hypothesis, Setup, Success Metric]
    human_judges: The CEO approves the experiment before launch

  - title: Growth Reviewer
    reviews: [Growth Analyst]
    does: Independently checks each brief for a testable hypothesis and an honest metric.

never_autonomous:
  - Spending money on ads
```

Each role takes one sentence about what it does (`does`) and what it delivers (`delivers`). Everything else
has a sensible default.

### Step 3: check it

```bash
npx aic teams check growth_marketing
```

```
custom      growth_marketing ok …/teams/growth_marketing.yaml
1 team(s), 3 roles, 0 error(s)
```

Errors explain exactly what to change; see [Fixing common errors](#8-fixing-common-errors).
*Notes* are informational: they tell you what the platform assumed.

### Step 4: see what the platform derived

```bash
npx aic teams show growth_marketing
```

This prints the reporting structure, each role's tools and acceptance criteria, who reviews whom, and the
workflow with its approval gates. Read it once: it is exactly how your team will be governed.

### Step 5: hire the team and give it work

```bash
npx aic hire growth_marketing
npx aic chat growth_lead "Plan an experiment to test a referral program for our newsletter."
```

From here the team works like any other: the lead drafts a proposal, you confirm it, and the lead plans.
After you approve the plan, the analysts write their briefs. The platform checks each brief for the
required sections and for leftover placeholder text. The reviewer checks it independently, and then you
accept it.

> The offline `scripted` model in the starter config only plays the bundled demo scenario (a `slugify`
> helper). For your own teams, connect a real model first (Dashboard → **Setup → AI models**, or a
> profile in `aic.config.yaml`). Otherwise the employee raises a blocker that says exactly that.

---

## 2. The same in the dashboard

Start the dashboard with `npx aic serve` and open the link it prints.

1. Go to **Company → Design a team**.
2. Name the team and say what it is for. The key is derived from the name.
3. Pick an oversight level and a risk level.
4. Add roles. Each role has a type:
   - **Lead**: plans and reports to you.
   - **Builder**: does the work.
   - **Reviewer**: independently checks the work of the roles you tick.
   - **QA**: tests from outside the chain.
5. For each role, set what it *works with* and the document it delivers (with required sections). If a
   person must accept the work, say who.
6. Click **Check design** to see exactly what the platform derived, plus any problems.
7. Click **Save** (writes `teams/<key>.yaml`), or **Save & hire**.

Saving a team definition is a governance action: only the CEO or an admin, in an owner session or after a
fresh sign-in, can do it.

---

## 3. Starting from a recommended team

The platform ships eleven recommended teams in `templates/recommended/`. List them with `npx aic teams`.

- **In the dashboard:** go to **Company → Hire a team** and click **Copy** on any team written in the
  short format (for example Product Design or People Operations). The copy opens in the builder.
- **From the command line:** copy the file into your `teams/` folder and edit it:

  ```bash
  cp templates/recommended/product_design.yaml teams/product_design.yaml
  ```

**A custom team with the same key as a recommended team replaces it in your company.** That is how you
adopt a recommended team and adjust it. Keep the same `team:` key to replace it, or pick a new key to have
both.

---

## 4. The team file, field by field

### Team fields

| Field | Required | Meaning | Values / default |
|---|---|---|---|
| `team` | yes | Unique key, snake_case | e.g. `growth_marketing` |
| `name` | yes | Display name | |
| `purpose` | yes | What the team is for and what good output looks like (at least a sentence) | |
| `mode` | | How much the CEO oversees by default (changeable per team later) | `autonomous`, `exceptions`, `milestones`, `plan_gates` (default), `supervised` |
| `risk` | | Risk floor for the team's work | `low`, `standard` (default), `high`, `critical` |
| `roles` | yes | At least two roles, exactly one with `lead: true` | see below |
| `never_autonomous` | | Things the team must never do without a human, shown to the team and the CEO | list of sentences |
| `kpis` | | What success is measured by | defaults to verified completion rate, rework rate, cost per deliverable |
| `version` | | Bump when you change the team | `1` |
| `recommended`, `publisher` | | Only for teams you publish in `templates/recommended/` | |

**Oversight modes**, from least to most supervision:

| `mode` | Code | What you approve |
|---|---|---|
| `autonomous` | M1 | Plans start without you; leads approve plan changes. You still approve external actions (unless you gave a standing approval) |
| `exceptions` | M2 | Plans start without you. You decide escalations and approve consequential and external actions |
| `milestones` | M3 | Plans start without you; leads approve plan changes and routine consequential actions. You approve external actions |
| `plan_gates` | M4 | Every plan before work starts, and every plan change (recommended) |
| `supervised` | M5 | Every plan and every step that changes work |

In every mode, releasing to your main branch needs your approval, and so does anything with
`human_judges`, `affects_people`, or a `critical` risk level. An emergency stop (`aic stop`) puts the whole
company into Safe Mode (M6), where only reading is allowed.

**Risk** sets the floor for every task. `high` and `critical` teams always end in a human acceptance step,
and reviews only count when the reviewer uses a *different model family* than the producer.

### Role fields

| Field | Meaning | Default |
|---|---|---|
| `title` | Role name. The role key is derived from it: `Growth Analyst` → `growth_analyst` | required |
| `does` | One or two full sentences (at least 20 characters): the role's charter and core instruction | required |
| `lead: true` | The team head. It plans, delegates, answers its team's questions, and reports to the CEO | exactly one per team |
| `count` | Number of seats to hire (1–10) | `1` |
| `reviews: [titles]` | Makes this role an independent reviewer of those roles. Reviewers get only read-only tools and report to the CEO | |
| `qa: true` | A QA role: writes tests or checks independently of the producers and reports to the CEO | |
| `works_with` | What the role works with, which decides its tools (see [Capabilities](#capabilities)) | `[documents]` |
| `delivers` | What the role hands in. Each item becomes an acceptance criterion the platform checks itself (see [Deliverables](#deliverables)) | a document at `<team>/<role_key>.md` |
| `human_judges` | A person must accept this role's work, e.g. `The CEO approves the messaging` | |
| `affects_people: true` | The work significantly affects individuals (hiring, performance): always decided by a human | `false` |
| `reports_to` | Override the reporting line: another role's title, or `ceo` | the lead |
| `instructions` | Extra instructions appended to the role's prompt | |
| `responsibilities` | Bullet list shown on the role (purely descriptive) | `[does]` |
| `budget_per_run_usd` | Spend ceiling for one work session | lead $10, reviewer $5, code roles $20, others $6 |
| `key` | Explicit role key. Needed when another team already uses the same title | derived from `title` |
| `advanced` | Any field of the full role schema, for fine control (see [section 10](#10-advanced-the-full-template-format)) | |

### Deliverables

Each `delivers` item becomes a criterion that the **platform** verifies on a fresh checkout of the exact
submitted commit. The employee's own claim never counts.

| Item | Checked by the platform | Example |
|---|---|---|
| `document: path` (+ `sections`) | The file has every listed `## Section` with real content, and no placeholder text (TODO, lorem ipsum, …) | `{ document: research/BRIEF.md, sections: [Question, Findings, Sources] }` |
| `file: path` | The file exists | `{ file: data/export.csv }` |
| `check: "command"` (+ `says`) | The command exits 0 in the sandbox | `{ check: "node scripts/validate.js", says: "The export passes validation" }` |

Without `sections`, a document must have `Summary`, `Details`, and `Open Questions`. A role that works with
`code` also gets an **all tests pass** criterion that runs your project's `test_command` (set it under
`defaults.project_settings` in `aic.config.yaml`; the starter uses `node --test`).

### Capabilities

`works_with` decides the tools a role gets. List them any time with `npx aic teams capabilities`.

| Capability | Tools | Works today |
|---|---|---|
| `documents` | read/write files in the team's repository (always available) | ✅ |
| `code` | `sandbox.exec`, `repo.commit_and_push`; adds an "all tests pass" criterion | ✅ |
| `databases` | `connections.request`, `db.schema`, `db.query`, `db.execute`. Employees ask for a database; you connect it; they never see the password | ✅ |
| `email_drafts` | `email.draft` (written, never sent) | ✅ |
| `analytics` | `analytics.query` (connector), `sandbox.exec` | partly: `sandbox.exec` only |
| `web_research` | `web.search`, `web.fetch`, `docs.read_external` (untrusted content) | needs a connector |
| `design_files` | `design.read`, `design.write` | needs a connector |
| `send_email` | `email.draft`, `email.send_external` (each send needs approval) | drafting only |
| `crm`, `tickets`, `finance_records`, `contracts`, `hr_records`, `calendar` | the matching business-system tools | needs a connector |
| `publish` | `social.publish` (each post needs approval) | needs a connector |
| `customer_inbox` | inbound email, tickets, CRM, `support.reply_customer` (replies need approval) | needs a connector |

"Needs a connector" means the capability is part of the design, with its risk class, the Rule-of-Two
analysis, and approval gates, but its tools are not offered to employees until your company installs a
connector for that system. If an employee calls one anyway, the call is refused and audited.

**Reviewers only receive the read-only tools of their capabilities.** For example, a reviewer that
`works_with: [design_files]` can read designs but not change them.

---

## 5. What the platform derives

Run `npx aic teams show <team>` to see all of this for your team.

- **Reporting lines.** The lead reports to the CEO. Reviewers and QA report to the CEO, outside the
  producers' chain. Everyone else reports to the lead, unless `reports_to` says otherwise.
- **Tools.**
  - Leads get the planning and delegation tools.
  - Producers get the work tools, plus those of their capabilities.
  - Reviewers get only read-only tools and `review.record_verdict`.
- **Acceptance criteria**, frozen into every task when the CEO approves the plan:
  - one platform check per deliverable;
  - "all tests pass" for code roles;
  - an independent review criterion for any role someone `reviews`;
  - a human criterion from `human_judges` or `affects_people`.
- **Rule-of-Two profile.** A role is a *builder*, *researcher* (reads untrusted content), *communicator*
  (talks to the outside world), or *mixed*. A role that combines untrusted input, private data, and
  external communication is flagged, and every external action it takes needs human approval.
- **Workflow.** First the plan stage (CEO approval). Then one stage per producing role, gated by
  independent review or human acceptance. High-risk teams get a final human acceptance stage.
- **Task kinds, budgets, step limits, and the prompt**, all derived from the role type and its
  capabilities. The prompt is built from `does`, the deliverables, and `instructions`, plus the platform rules.

---

## 6. Recipes

### A research team that writes briefs

```yaml
team: market_research
name: Market Research
purpose: >
  Answer the CEO's market questions with sourced, fact-checked briefs that separate evidence from opinion.
mode: exceptions
roles:
  - title: Research Director
    lead: true
    does: Turns the CEO's questions into research plans with clear scope and a deadline per brief.
  - title: Market Analyst
    count: 2
    does: Researches one question at a time and writes a brief that cites every claim.
    delivers:
      - document: research/BRIEF.md
        sections: [Question, Findings, Evidence, Confidence, Open Questions]
  - title: Research Fact Checker
    reviews: [Market Analyst]
    does: Independently checks every claim in a brief against its cited source and flags unsupported ones.
```

### A software team with QA

```yaml
team: platform_team
name: Platform Team
purpose: >
  Build and maintain internal services with tested code that independent reviewers have checked.
roles:
  - title: Platform Lead
    lead: true
    does: Splits engineering goals into small, testable tasks with interface contracts and owners.
    works_with: [code]
  - title: Platform Engineer
    count: 2
    does: Implements one task at a time on its own branch with tests for every acceptance criterion.
    works_with: [code, databases]
  - title: Platform QA
    qa: true
    does: Writes acceptance tests from the requirements against the real delivered code, never a copy or a mock.
    works_with: [code]
  - title: Platform Code Reviewer
    reviews: [Platform Engineer, Platform QA]
    does: Independently reviews each change for correctness, security, and fit with the requirements.
```

Set the team's test command in `aic.config.yaml` (`defaults.project_settings.test_command`, e.g. `npm test`).
Give the reviewer a model from a different family (see [After you hire](#9-after-you-hire)).

### A team whose work reaches customers

```yaml
team: lifecycle_email
name: Lifecycle Email
purpose: >
  Draft onboarding and re-engagement emails that match the brand and never overpromise.
mode: milestones
roles:
  - title: Lifecycle Lead
    lead: true
    does: Plans email sequences around one goal each and gets the CEO's approval for the messaging.
  - title: Email Copywriter
    does: Drafts each email in the sequence with subject lines, body copy, and the call to action.
    works_with: [documents, email_drafts]
    delivers:
      - document: email/SEQUENCE.md
        sections: [Goal, Audience, Emails, Claims To Verify]
    human_judges: The CEO approves the copy before anything is sent
  - title: Lifecycle Brand Reviewer
    reviews: [Email Copywriter]
    does: Independently checks every email for brand voice, accuracy of claims, and compliance wording.
never_autonomous:
  - Sending any email to customers
```

### A high-risk team whose work affects people

```yaml
team: talent
name: Talent
purpose: >
  Prepare job descriptions and interview kits; never screen, rank, or decide about candidates.
mode: supervised
risk: high
roles:
  - title: Talent Lead
    lead: true
    does: Plans hiring material for each open role and routes anything about a person to a human.
  - title: Talent Partner
    does: Writes inclusive job descriptions and structured interview kits grounded in the role's real needs.
    delivers:
      - document: talent/ROLE_KIT.md
        sections: [Role, Responsibilities, Interview Questions, Scoring Guide]
    affects_people: true
    human_judges: A human hiring manager approves the kit
  - title: Talent Compliance Reviewer
    reviews: [Talent Partner]
    does: Independently reviews material for biased language and legal-risk wording, citing the exact line.
never_autonomous:
  - Screening or ranking candidates
```

`risk: high` adds a final human acceptance stage, and `affects_people` makes a human the decider.

---

## 7. Rules every team must pass

`aic teams check`, the dashboard's **Check design**, and hiring all enforce the same rules. A team that
breaks one cannot be hired.

| Rule | Why |
|---|---|
| Exactly one lead, reporting to the CEO | One accountable owner for every plan |
| At most 3 layers below the CEO; at most 8 direct reports per manager | Accountability without deep, lossy hierarchies |
| Only leads hold delegation tools and propose plans | Delegation happens through the ledger, not side channels |
| Reviewers record verdicts, hold no side-effecting tools, and sit outside the chain of the roles they review | Separation of duties |
| Every role that produces work has at least one check the platform runs itself | Verification a model cannot argue past |
| Rule of Two: no role combines untrusted input, private data, and unapproved external communication | Limits the blast radius of prompt injection |
| `high`/`critical` teams have a human gate in every workflow | Humans own consequential outcomes |
| Work affecting individuals has a human criterion | GDPR Art. 22 and the EU AI Act |
| Role keys are unique across the whole company | Unambiguous model assignments and audit |

---

## 8. Fixing common errors

These are the exact messages `aic teams check` prints.

| Message | Fix |
|---|---|
| `Exactly one role must have "lead: true" (found 0)` (or `found 2`) | Mark exactly one role `lead: true` |
| `roles: A team needs at least a lead and one other role` | Add a role that does the work |
| `roles.1.does: Describe what this role does in at least one full sentence` | Write a full sentence of at least 20 characters |
| `team: team must be a snake_case key, e.g. growth_marketing` | Lowercase letters, digits, and underscores, starting with a letter |
| `"Growth Reviewer" reviews "Growth Analysts", which is not a role in this team` | `reviews` must match another role's `title` exactly (case-insensitive) |
| `"Growth Analyst" reports to "Head of Growth", which is not a role in this team` | `reports_to` must be another role's title, or `ceo` |
| `roles.1.works_with.0: Invalid enum value. Expected 'code' \| 'documents' \| …` | Use a capability from `npx aic teams capabilities` |
| `mode "hands_off" is not one of: autonomous, …` | Use one of the listed modes |
| `"growth_lead" has 9 direct reports (max 8) (span_of_control)` | Lower `count`, or add a second-level lead with `reports_to` |
| `Role "software_engineer" also defined in "engineering" — give the role an explicit "key"` | Two teams use the same title. Add `key: growth_engineer` (any unique snake_case key) to one of them |
| `Mixed-profile roles may only communicate externally via approval-gated (A5+) tools: calendar.schedule (mixed_profile_gated)` | The role reads untrusted content *and* has an external tool that isn't approval-gated. Move that capability to another role |

**Notes** (not errors) worth acting on:

- `"X" has no reviewer and no human judge; only deterministic checks will verify its work`: add a reviewer
  that `reviews: [X]`, or a `human_judges`, if the work needs judgment.
- `Nobody reviews "X QA": its tests are only checked for running, not for testing the real thing`: add the
  QA role to a reviewer's `reviews`.
- `"X" has no deliverables listed; defaulting to a document at …`: name the real deliverable.

---

## 9. After you hire

- **Models per role.** In the dashboard, go to **Setup → AI models → Who uses which model**. In
  `aic.config.yaml`, use `models.assignments: { growth_reviewer: reviewer }`. Put reviewers on a different
  model family than producers, and give leads your strongest model: planning is the hardest job.
- **Instructions without editing the team.** Go to **Setup → Instructions** to give standing instructions to
  the whole company, one team, one role, or one employee. Instructions shape behavior but never grant
  permissions, and requirements win on conflict.
- **Oversight level.** Change a team's oversight level any time in the dashboard, or with
  `npx aic mode M3 --department growth_marketing -m "why"`.
- **Changing the team itself.** Hired employees keep the role definition they were hired with, and a team
  key can only be hired once. Edits to `teams/<key>.yaml` apply to teams you hire from then on. So finish
  `aic teams check` before hiring. Use instructions and per-role models to adjust a team that is already
  working. To roll out a redesigned team, hire it under a new key (for example `growth_marketing_v2`).
- **Version your teams in git.** `teams/` is plain YAML, so review changes like code.

---

## 10. Advanced: the full template format

Recommended teams can also use the full department format, as Engineering, Finance, and Legal do. It lets
you set every tool, denied tool, budget, criterion, and workflow stage by hand. See
`templates/recommended/finance.yaml`. Both formats pass through the same validator.

For one-off tweaks inside a short spec, use `advanced` on a role to set any field of the full role schema.
For example, to deny a tool or raise the step limit:

```yaml
  - title: Platform Engineer
    does: Implements one task at a time on its own branch with tests for every acceptance criterion.
    works_with: [code]
    advanced:
      denied_tools: [db.execute]
      budget: { per_run: { max_steps: 200, max_cost_usd: 25, max_wall_minutes: 120 }, per_day_usd: 200 }
```

The validator still applies to whatever `advanced` produces.

---

## 11. Publishing a recommended team

Recommended teams ship with the platform, for every company.

1. Write the team in `templates/recommended/<key>.yaml`, with `recommended: true` and a `publisher`.
2. Check it: `npx aic teams check <key>`.
3. Run the test suite (`npm test`). `test/teams.test.ts` and `test/org.test.ts` validate every recommended
   team, and role keys must stay unique across all of them.
4. Add it to the table in the [README](../README.md#teams).
