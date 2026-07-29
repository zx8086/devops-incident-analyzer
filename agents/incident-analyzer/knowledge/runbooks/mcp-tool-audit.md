---
type: Runbook
title: "MCP Tool Audit (datasource-agnostic)"
description: "Datasource-agnostic audit of MCP tool availability and error modes."
status: stable
tags: [mcp, tooling, diagnostics]
generated:
  by: human:simon
  at: 2026-07-29
triggers:
  metrics:
    - mcp
    - tool_error
    - tool_not_found
    - datasource_unavailable
    - empty_results
  match: any
---
# MCP Tool Audit (datasource-agnostic)

Audit an MCP server end-to-end: live-test every tool, separate real bugs from
environment states, verify agent-side reachability, and check error-envelope
conformance. Scope one server per audit (elastic, kafka, couchbase, konnect,
gitlab, atlassian, aws).

Full method with per-phase worked examples: `docs/runbooks/mcp-tool-audit-runbook.md`.
Cross-tool skill form (agentskills.io open format, loadable by GitLab Duo CLI,
Zed, OpenCode): `.agents/skills/mcp-tool-audit/SKILL.md`.

## Symptoms
- A datasource's tools return errors, or a tool name resolves as not-found
- Suspicious empty results against an index known to hold matching data
- An upstream API or query grammar changed and tool behaviour is unverified
- A new datasource is about to be relied on for incident evidence

## Core principle
A tool that works in isolation can still be broken in three other places: the
query it builds, the agent's ability to select it, and the way its errors
classify. Audit all four layers.

## Procedure

1. **Inventory (Phase 0)**: list the server's tools live for the authoritative
   count -- never grep name literals, because filter sets and conditional
   registration make grep counts wrong. Classify each tool: custom REST /
   proxied / graph-billed. Snapshot free baselines (version, schema, index
   entity counts) with the cheap health/schema probe for the target datasource --
   `elasticsearch_get_cluster_health`, `kafka_describe_cluster`,
   `capella_get_cluster_health` or `capella_ping`, `gitlab_graph_schema` -- since
   those baselines decide later whether an empty result is PASS or FAIL.
2. **Read campaign (Phase 1)**: smoke -> discovery on a known anchor entity ->
   chained detail calls feeding REAL captured ids, never guessed ones.
   Batch-load schemas per family and parallelize independent calls. Record every
   call in a matrix using the outcome taxonomy: PASS / PASS-behavioral /
   ENV-LIMITED / ENV-DATA-EMPTY / TOOL-BUG / SKIPPED-POLICY.
3. **Rubric (Phase 2)**: control-probe a neighbouring tool on the same entity
   before classifying anything. Upstream-phrased versus locally-phrased error
   text points at the failing layer. Suspicious emptiness against a rich index
   is a finding to isolate, never a result to accept.
4. **Expensive and graph tools (Phase 3)**: respect the credit budget (roughly
   10-15 billed calls) and use free rejection paths to exercise error handling.
   Empty-result isolation recipe: (a) single-node filter alone, (b) join without
   the suspect filters, (c) the exact tool query minus one filter at a time. Any
   filter comparing a relative property to a global identifier (group path,
   account id) is suspect -- check the LIVE property values.
5. **Write tools (Phase 4)**: validation only. Tier 1 is empty arguments, where
   schema rejection proves wiring. Tier 2 is a nonexistent target id, where an
   upstream 403/404 proves the call reached the far end. Never send a valid
   payload at production.
6. **Consumption audit (Phase 5)**: cross-reference the action-to-tool map --
   a tool unreachable above the 25-tool cap is a REAL defect. Check that
   extractor and correlation inputs survive every action, that read-only
   coherence holds (multi-action tools hiding writes), and that action
   descriptions are honest. Add a fixture-drift test that parses the real YAML.
7. **Envelopes (Phase 6)**: every failure path must emit the shared error
   envelope appended AFTER the steering prose. Environment states map to
   non-degrading kinds (no-index), rejected queries to bad-query, and budget
   exhaustion to throttled.
8. **Fix and verify (Phase 7)**: open a tracked issue per concern BEFORE
   implementing. Run typecheck, lint, test and the YAML check. Restart the live
   server from merged main -- kill the exact tracked PID, and note that hot
   reload does not re-resolve modules -- then re-probe the fixed tool, the tool
   count, and one live error envelope. Triage every review-bot finding: fix it,
   or decline it with live evidence.

## Reporting

Lead with the Phase 1 matrix. For each tool give the outcome-taxonomy verdict
and the evidence justifying it. Separate genuine TOOL-BUG findings from
ENV-LIMITED and ENV-DATA-EMPTY states explicitly -- an environment state is not
a defect, and conflating the two is the failure mode this audit exists to
prevent.

## Edge cases
- Empty result against a known-rich index: isolate with the Phase 3 recipe
  before recording any verdict.
- Billed tools with an exhausted budget: record SKIPPED-POLICY rather than
  guessing an outcome.
- A tool absent from the action map: still audit it, and report the
  reachability gap as a Phase 5 finding.

## All Tools Used Are Read-Only
elasticsearch_get_cluster_health, kafka_describe_cluster, capella_get_cluster_health, capella_ping, gitlab_graph_schema

Only the Phase 0 baseline probes are named here; this runbook is
datasource-agnostic, so the rest of the audited tool set is whatever the target
server registers at run time and step 1 requires deriving it live rather than
from a hardcoded list. The audit is read-only apart from Phase 4, which is
validation-only -- empty arguments and nonexistent target ids, never a valid
write payload against production.
