# Designing departments

A department template is a YAML file in `templates/departments/`. It describes the purpose, roles,
reporting structure, workflows, and safeguards. Templates are data, so a company can add a custom
department without writing code. Every template must pass `aic org validate`.

## Anatomy

```yaml
key: customer_success          # unique, snake_case
version: 1
name: Customer Success
purpose: >                     # what this department is for, in one paragraph
  …
default_mode: M3               # M1 Autonomous … M5 Supervised, M6 Safe Mode
risk_floor: R1                 # R0–R3; R2+ requires a human gate in every workflow
head: cs_lead                  # the role that reports to the CEO and plans work

roles:
  - key: cs_lead
    version: 1
    title: Customer Success Lead
    category: manager          # executive | manager | specialist | reviewer | qa
    charter: >                 # the job, in two sentences
      …
    responsibilities: [ … ]
    capabilities_required: { structured_output: true, tool_calling: true, min_context_tokens: 64000 }
    tools: [ledger.get_task_contract, ledger.propose_plan, …]   # from src/org/toolCatalog.ts
    denied_tools: []
    task_kinds: [planning, decision]
    can_manage: true
    rule_of_two_profile: builder   # researcher | builder | communicator | reviewer | mixed
    budget: { per_run: { max_steps: 50, max_cost_usd: 6, max_wall_minutes: 45 }, per_day_usd: 50 }
    criteria_templates: []         # acceptance criteria every task of this role starts with
    reviewer_role: cs_reviewer     # required when criteria include rubric_review
    escalation_path: [ceo]
    prompt: >                      # role instructions given to the model
      …

structure:                       # seats; reports_to is "ceo" or another role key
  - { role: cs_lead, count: 1, reports_to: ceo }
  - { role: cs_manager, count: 3, reports_to: cs_lead }
  - { role: cs_reviewer, count: 1, reports_to: ceo }   # reviewers sit outside the producer chain

workflows:
  - key: renewal
    name: Renewal preparation
    stages:
      - { key: plan, description: "…", owner_role: cs_lead, task_kind: planning, gate: ceo_approval }
      - { key: brief, description: "…", owner_role: cs_manager, task_kind: implementation, gate: independent_review }

kpis: [ … ]
never_autonomous: [ … ]          # shown to the CEO; enforce with tool risk classes and modes
```

## Acceptance criteria the platform can verify itself

| `check.type` | Verifies |
|---|---|
| `command` | A command (e.g. `${test_command}`) exits 0 on a fresh checkout of the submitted commit |
| `file_exists` | A deliverable file exists |
| `markdown_sections` | A document has every listed heading, each with real content |
| `no_placeholder_text` | A document has no TODO/TBD/lorem/placeholder text |

`${name}` placeholders resolve from project settings (`defaults.project_settings` in config, or
`--set name=value` on an objective). Criteria with kind `rubric_review` are judged by an independent
reviewer run. `human_judgment` criteria are judged by a person. A criterion with no available
verifier is recorded as an error, and the task goes to **uncertain**. The platform never assumes
such a criterion passed.

## Rules `aic org validate` enforces

| Rule | Why |
|---|---|
| Head exists, can manage, reports to the CEO | One accountable lead per department |
| Reporting depth ≤ 3 below the CEO; span ≤ 8 | Deep hierarchies lose information and add cost |
| Only managers hold delegation tools; managers plan via `ledger.propose_plan` | Delegation happens only through the ledger |
| Reviewers record verdicts, hold no side-effecting tools, and sit outside the producer's chain | Separation of duties |
| Rubric criteria need a reviewer role and an independent judge | No self-review |
| Artifact-producing roles have at least one deterministic criterion (or `human_verified_only` with a reason) | Verification is anchored in checks a model can't talk its way past |
| Rule of Two: never untrusted input + private data + external comms, unless `mixed` with approval-gated comms | Limits prompt-injection blast radius |
| `builder`/`communicator` profiles don't read untrusted content; `researcher`/`reviewer` profiles don't communicate externally | Profiles mean something |
| R2+ departments have a human gate in every workflow | High-risk work needs a human |
| `affects_individuals: true` requires a human criterion | GDPR Art. 22 |
| Every role can read its Task Contract; per-run budget ≤ per-day budget | Basics |

## Tips

- Keep leads small and explicit. Plans should have at most 12 tasks, and each task needs its own
  criteria and owner.
- Split research from action. Have an analyst read the web and produce a reviewed brief, and a
  different role act on that brief. This is how the Sales template stays within the Rule of Two.
- Put QA roles (`category: qa`) outside the producer chain. Leads can still assign them test-writing
  tasks.
