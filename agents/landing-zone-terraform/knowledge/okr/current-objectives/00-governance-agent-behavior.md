[← Back to index](README.md)

# 0. Governance & Agent Behavior

*(Meta-layer. Not a topic on the LZ KB itself — this is how an agent is expected to operate across every category in this bundle.)*

```
Category: Governance
Status:   Draft — no companion ADR; internal to the agent prompt itself
Owner:    CCoE Platform Team
```

## Objective

Every piece of Terraform an agent writes for the Landing Zone is verifiable against a live source of truth, not the model's memory.

## Key Results

- [ ] **KR1 —** 100% of AWS resource arguments and shared-module inputs are confirmed via the Terraform MCP (`search_modules`, `get_module_details`, `get_provider_details`, `get_provider_capabilities`) before being written. Zero invented arguments. *(AGENT_PROMPT §2, §17.14)*
- [ ] **KR2 —** Every generated repo passes all 14 items on the Authoring Checklist (§17) before being returned — archetype, backend, variables, region typing, tagging, naming, module pinning, outputs, multi-region handling, lifecycle rules, no secrets/hardcoding, smoke test, pre-commit hooks, MCP verification.
- [ ] **KR3 —** 100% of deliverables use the mandated output format: one fenced block per file, path as a comment header, deviations explained rather than boilerplate narrated. *(AGENT_PROMPT §18)*
- [ ] **KR4 —** Zero uses of a legacy/deprecated pattern (e.g. `?ref=main`, `use_lockfile = false` without a documented reason, DynamoDB-vs-native-lockfile confusion) without flagging it explicitly rather than silently copying it forward.

## Conflict handling — resolved in the local operating contract

The workspace `AGENTS.md` now defines an explicit precedence order: user request, checked-out repository, current Accepted ADRs, released shared-module/provider contracts, the July 2026 knowledge base and later remediation research, then the older guides and validation reports. Repository behavior remains evidence of deployed reality rather than automatic approval for new work. Unresolved platform decisions still stop authoring instead of being settled by inference. The 2026-09-21 [repository refresh](findings/repository-refresh-2026-09-21.md) follows that rule and keeps the code and ADR freshness dates separate.

---
[← Back to index](README.md) · [Next: Strategy →](01-strategy.md)
