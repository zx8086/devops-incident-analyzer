---
name: mcp-steering-audit
description: Audit an MCP-backed agent's steering end-to-end - prove SKILL.md/RULES.md/SOUL.md/runbook prose actually drives the sub-agent's live tool calls, not just that the prose exists. Use when steering was recently added or changed, when a sub-agent seems to ignore documented behaviors, or before trusting a new steering claim. Complementary to mcp-tool-audit (that proves a tool WORKS; this proves the agent CHOOSES to call it correctly). Args - the datasource name (elastic|kafka|couchbase|konnect|gitlab|atlassian|aws).
version: 1.0.0
category: Agent Tooling
metadata:
  audience: operators
  workflow: mcp
---

# MCP Steering Audit

Follow `docs/runbooks/mcp-steering-audit-runbook.md` exactly. Condensed checklist:

1. **Scope (Phase 0)**: inventory every steering layer for the datasource -- SOUL/RULES (always in prompt), SKILL.md (sub-agent-facing, always in prompt), knowledge-graph runbooks (aggregator-facing, LLM- or `always_select`-gated), and the `tools/<ds>-api.yaml` action map (determines what's even bound this turn). For each behavior under test, write down the implied tool call, load-bearing arguments, and trigger condition. Run the gitagent-bridge test suite first to confirm the prompt-name budget has headroom. **Verify any disputed tool-parameter claim against BOTH the live server (`tools/list`, then test the disputed value against a known-invalid one for contrast) AND the upstream API's own docs -- never trust a wrapper's `inputSchema` description text alone; a partial enum-shaped list in a description reads as exhaustive and induces false "invalid value" claims.**
2. **Ground truth (Phase 1)**: pick a real incident with a known-correct answer. Write pass criteria BEFORE running anything -- exact tool call + arguments per behavior, and how you'll verify each (SSE `toolsUsed[]` for "fired at all", LangSmith trace arguments for "fired correctly").
3. **Fresh-process replay (Phase 2)**: agent knowledge is cached per-process -- always replay against a freshly started server (not the user's `:5173`), booted AFTER your steering edits. `KNOWLEDGE_GRAPH_ENABLED=false` when the user's server is also running. Verify the port actually bound before sending traffic; after any restart, `lsof` the EXACT port you expect (a stray earlier instance makes Vite silently fall back to the next port instead of erroring).
4. **Replay and evidence (Phase 3)**: `toolsUsed[]` from the `done` SSE event first, then LangSmith (`langsmith run list --run-type tool --name <tool>`, `langsmith run get <id> --full`) for exact arguments -- cross-check trace/thread IDs, don't trust a time-window match alone. Reassemble the final answer and check the result reached the report in the designed form. One re-run (fresh threadId) per soft miss before calling it a genuine defect -- two independent misses (0/2) is a real finding, not noise; don't keep sampling past that.
5. **Root-cause and fix (Phase 4)**: don't default to "make it mandatory" -- respect intentionally-conditional/optional steering design. Look for structural causes first: two behaviors sharing one ambiguous trigger (so an unrelated false branch skips both), a steering instruction referencing a wrong/undocumented tool parameter, or a nested judgment-call dependency versus a flat reliable imperative. Re-verify fixes against the SAME live replay, not just typecheck/lint -- prose existing is not prose working.
6. **Report (Phase 5)**: score each behavior independently (FIXED / PARTIAL / NOT FIXED-OPEN / PASS) with concrete evidence (thread/trace IDs, exact arguments). Correct any wrong claim explicitly in the doc rather than silently editing it away. Linear issue before implementation; In Review (not Done) pending any required live smoke-test.
