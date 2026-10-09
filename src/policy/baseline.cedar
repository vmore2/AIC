// Platform baseline policy (architecture.md §16.3, Appendix F).
// `forbid` always overrides `permit`, so customer policies can never weaken these.
// Every context attribute is always supplied by the engine (missing attributes would make a
// forbid fail open); the PDP additionally treats any evaluation error as DENY.

// ---------------- permits ----------------

// CEO and admins may issue any human command (still subject to every forbid below).
permit (principal is User, action, resource)
when { principal.role == "ceo" || principal.role == "admin" };

// Human approvers decide approvals and accept/reject work.
permit (principal is User, action in [Action::"approval.decide", Action::"task.accept", Action::"task.reject",
        Action::"task.accept_uncertain", Action::"escalation.resolve", Action::"directive.confirm", Action::"memory.curate"], resource)
when { principal.role == "approver" };

// The workflow driver performs system transitions on ledger facts.
permit (principal is System, action, resource);

// Employees act on their own task, within the current lease epoch.
permit (principal is Employee, action in [Action::"task.submit", Action::"task.raise_blocker", Action::"task.ask_question",
        Action::"task.post_update", Action::"tool.invoke", Action::"memory.remember"], resource)
when { context.is_owner && context.epoch_current };

// Managers delegate within their scope (attenuation is enforced by the Transition Engine).
permit (principal is Employee, action in [Action::"plan.propose", Action::"task.create_subtask", Action::"task.assign",
        Action::"task.cancel", Action::"escalation.resolve"], resource)
when { principal.can_manage && context.manages_scope && context.epoch_current };

// Reviewers record verdicts only on reviews assigned to them.
permit (principal is Employee, action in [Action::"review.record_verdict", Action::"tool.invoke"], resource)
when { context.is_assigned_reviewer && context.epoch_current };

// Conversation runs may only read and propose directives.
permit (principal is Employee, action in [Action::"directive.propose", Action::"tool.invoke"], resource)
when { context.in_conversation };

// ---------------- forbids (baseline) ----------------

// F2: Employees never approve, accept, or govern.
forbid (principal is Employee, action in [Action::"task.accept", Action::"task.reject", Action::"task.accept_uncertain",
        Action::"approval.decide", Action::"mode.set", Action::"employee.hire", Action::"employee.reconfigure",
        Action::"budget.adjust", Action::"emergency.stop", Action::"scope.resume", Action::"directive.confirm",
        Action::"objective.create", Action::"evidence.record_human", Action::"task.reopen", Action::"task.retry"], resource);

// F3: Stale lease epochs are fenced off (INV-7).
forbid (principal is Employee, action, resource) when { context.stale_epoch };

// F5: Held tasks admit no consequential tool actions.
forbid (principal is Employee, action == Action::"tool.invoke", resource)
when { context.task_held && context.action_class != "A0" };

// F6: Safe Mode blocks everything except reads for non-humans.
forbid (principal is Employee, action, resource)
when { context.mode == "M6" && context.action_class != "A0" };

// F4: Tools must be granted to both the employee and the task (attenuation).
forbid (principal is Employee, action == Action::"tool.invoke", resource) when { !context.tool_granted };

// F7/F8: Mode × action-class gates. Human-gated actions need a valid approval bound to the payload.
forbid (principal is Employee, action == Action::"tool.invoke", resource)
when { context.gate == "blocked" || (context.gate == "human" && !context.approval_valid) };

// F11: Separation of duties — approvers cannot be in the producer lineage (INV-2).
forbid (principal is User, action in [Action::"task.accept", Action::"task.accept_uncertain", Action::"approval.decide"], resource)
when { context.in_producer_lineage };

// F9: Governance requires step-up authentication.
forbid (principal is User, action in [Action::"mode.set", Action::"emergency.stop", Action::"scope.resume",
        Action::"employee.hire", Action::"employee.reconfigure", Action::"budget.adjust"], resource)
when { !principal.step_up };
