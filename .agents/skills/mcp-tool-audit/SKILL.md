---
name: mcp-tool-audit
description: Audit an MCP server end-to-end - live-test every tool, separate bugs from environment states, verify agent-side reachability and error envelopes. Use when tools are erroring, after upstream or query-grammar changes, or before relying on a new datasource. Args - the server name (elastic|kafka|couchbase|konnect|gitlab|atlassian|aws).
version: 1.0.0
category: Agent Tooling
metadata:
  audience: operators
  workflow: mcp
---

# MCP Tool Audit

Follow `docs/runbooks/mcp-tool-audit-runbook.md` exactly. Condensed checklist:

1. **Inventory (Phase 0)**: `tools/list` against the live server for the authoritative count (never grep name literals). Classify each tool: custom REST / proxied / graph-billed. Snapshot free baselines (version, schema, index entity counts) -- they decide later whether empty results are PASS or FAIL.
2. **Read campaign (Phase 1)**: smoke -> discovery on a known anchor entity -> chained detail calls feeding REAL captured ids (never guess). Batch-load schemas per family; parallelize independent calls. Record every call in a matrix with the outcome taxonomy: PASS / PASS-behavioral / ENV-LIMITED / ENV-DATA-EMPTY / TOOL-BUG / SKIPPED-POLICY.
3. **Rubric (Phase 2)**: control-probe a neighbor tool on the same entity before classifying; upstream-phrased vs locally-phrased error text points at the layer; suspicious emptiness against a rich index is a finding to isolate, never a result to accept.
4. **Expensive/graph tools (Phase 3)**: respect the credit budget (~10-15 billed calls); use free rejection paths to test error handling. Empty-result isolation recipe: (a) single-node filter alone, (b) join without suspect filters, (c) exact tool query minus one filter at a time. Any filter comparing a relative property to a global identifier (group path, account id) is suspect -- check LIVE property values.
5. **Write tools (Phase 4)**: validation-only. Tier 1 = empty args (schema rejection proves wiring). Tier 2 = nonexistent target id (upstream 403/404 proves end-to-end). Never a valid payload at production.
6. **Consumption audit (Phase 5)**: cross-reference the action_tool_map (unreachable above the 25-tool cap is REAL), RESOLUTION_TOOLS_BY_DATASOURCE (extractor/correlation inputs must survive every action), read_only coherence (multi-action tools with hidden writes), and action_descriptions honesty. Add a fixture-drift test parsing the real YAML.
7. **Envelopes (Phase 6)**: every failure path emits the shared `{_error}` envelope appended AFTER the steering prose; environment states map to non-degrading kinds (no-index), rejected queries to bad-query, budgets to throttled.
8. **Fix + verify (Phase 7)**: tracked issue per concern BEFORE implementing; typecheck/lint/test/yaml:check; restart the live server from merged main (kill exact PID; --hot does not re-resolve) and re-probe the fixed tool, the tool count, and one live error envelope. Triage every review-bot finding -- fix, or decline with live evidence.
