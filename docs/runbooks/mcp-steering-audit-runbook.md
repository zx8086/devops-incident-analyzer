# MCP Steering Audit Runbook (datasource-agnostic)

A repeatable method for auditing whether an agent's steering -- SKILL.md files, the knowledge-graph runbooks, SOUL.md, RULES.md, and the `tools/<ds>-api.yaml` action map -- actually drives the sub-agent's live behavior, not just whether the prose exists. Distilled from the SIO-1320/SIO-1322 GitLab audit (2026-07-31): SIO-1320 encoded four new investigation behaviors into the gitlab-agent's steering; SIO-1322 live-replayed a real incident against the merged steering and found two of the four never fired organically, traced both to root cause, and fixed one.

Core principle, complementary to `mcp-tool-audit-runbook.md`: that runbook proves a tool WORKS and is REACHABLE (registered, in an action group, schema-valid). This runbook proves the sub-agent actually CHOOSES to call it, with the right arguments, when steering says it should. A tool can pass every phase of the tool audit and still never fire in practice if the prose steering it is ambiguous, contradicts a live tool schema, or is gated behind a judgment call the model silently skips. Audit both -- tool correctness and steering correctness are different failure classes with different fixes.

Two condensed forms of this runbook exist, deliberately (mirroring the mcp-tool-audit pattern, SIO-1278):

- **Cross-tool skill form**: `.agents/skills/mcp-steering-audit/SKILL.md`, in the Agent Skills open format.
- **Agent form**: not registered as a runbook the incident pipeline selects (this is an operator workflow, not an incident-time skill) -- invoke it directly as a Claude Code skill instead.

When editing the method, update both files together; they must not drift.

## Phase 0: Scope and ground truth

1. Identify what steering exists for this datasource, layer by layer:
   - `agents/incident-analyzer/agents/<ds>-agent/SOUL.md` -- sub-agent identity/priorities, always in the prompt.
   - `agents/incident-analyzer/agents/<ds>-agent/RULES.md` -- hard constraints, always in the prompt.
   - `agents/incident-analyzer/agents/<ds>-agent/skills/*/SKILL.md` -- sub-agent-facing, in-flight tool-call steering. Every skill body is unconditionally in the system prompt on every turn (no `activeSkills` filtering in production, see the dead-seam note below).
   - `agents/incident-analyzer/knowledge/runbooks/*.md` -- aggregator-facing only, reaches the LLM only when `selectRunbooks` (SIO-640) picks it (0-3 per turn, LLM discretion) or it is in `always_select`.
   - `agents/incident-analyzer/tools/<ds>-api.yaml` -- the action-tool-map; determines which concrete tool names are even bound/visible to the sub-agent this turn (1-3 action groups selected per turn by `extractEntities()`, `packages/agent/src/entity-extractor.ts`), separate from whichever ones survive the prompt-name budget (`MAX_TOOLS_PER_AGENT=25`, `PROMPT_TOOL_BUDGET=17`, see `packages/gitagent-bridge/src/skill-tool-coverage.test.ts`).
2. For each behavior you intend to verify, write down: which file states it, what tool call(s) it implies, what arguments/parameter values are load-bearing, and what triggers it (unconditional vs. conditional on a judgment call).
3. Run `packages/gitagent-bridge`'s skill-tool-coverage test suite before touching anything -- confirms the prompt-name budget has headroom and the runbook-validator's tool-citation contract is currently clean, so any budget/citation regression you introduce is visible immediately, not discovered later.

   ```bash
   bun run --filter '@devops-agent/gitagent-bridge' test
   ```

4. **Verify every tool schema claim against the LIVE server AND the upstream API docs before writing steering that depends on it.** This is the single most expensive mistake in the SIO-1322 case study: a claim that `gitlab_search`'s `scope: "issues"` was invalid, based on reading the MCP tool's `inputSchema.scope` DESCRIPTION TEXT (which omitted it), led to committing a wrong "fix," which had to be reverted after review. The description text is documentation the wrapper author wrote, not the authoritative contract. Do BOTH before trusting a "this value isn't valid" conclusion:
   - `curl` the live server's `tools/list` and test the disputed value directly against a definitely-invalid value for contrast (a genuinely invalid value is rejected outright with an explicit error like `"scope does not have a valid value"`; a valid-but-undocumented value returns real data with no error).
   - Fetch the upstream API's own documentation (WebFetch/WebSearch the vendor docs) -- this is fast and authoritative, and should be the FIRST check, not a fallback after a live probe.
5. **Enum-list hygiene**: while auditing, check every parameter description that lists specific values in prose (not a JSON Schema `enum`). It must either list every valid value (verified against the upstream API) or list none with illustrative examples instead ("e.g. projects, issues, merge_requests"). A partial list reads as exhaustive to both humans and LLMs and induces exactly the false-negative class of error in step 4. Flag any partial enum-shaped list you find as a doc-quality finding even if it isn't the thing you're auditing this session.

## Phase 1: Pick a representative incident and get ground truth

1. Pick (or reuse) a real incident with a known-correct answer -- a specific service, error class, timestamp, and (ideally) a prior live investigation's ground-truth findings to compare against (e.g. which MR actually shipped the bug, which symbol has the real blast radius). Steering audits without a ground-truth answer can't distinguish "the agent found nothing because there was nothing" from "the agent found nothing because it didn't look."
2. Write the pass criteria BEFORE running anything, one row per steering behavior under test, each with: the exact tool call (and load-bearing arguments) that should appear, and how you'll verify it (SSE `toolsUsed[]` for "did it fire at all"; LangSmith child-run arguments for "did it use the right parameters").
3. Note the LLM-noise allowance up front: one soft miss earns exactly one re-run (fresh threadId) before you classify a behavior as a genuine steering defect, not two, and not zero -- see Phase 3.

## Phase 2: Fresh-process replay setup

Agent knowledge (SOUL/RULES/skills/runbooks) is cached per-process in `packages/agent/src/prompt-context.ts`'s `agentRegistry` -- a running web server holds whatever steering was on disk when it booted, not what's on disk now. Always replay against a FRESH process started after your steering edits (or after the merge you're verifying), never the user's long-running `:5173`.

```bash
# Preflight any MCP-backed steering claims first (see Phase 0.4)
curl -sS -m 30 -X POST http://localhost:<mcp-port>/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}'

# From the worktree/checkout you want to verify:
cd apps/web
KNOWLEDGE_GRAPH_ENABLED=false LIVE_MEMORY_ENABLED=false AGENT_MEMORY_ENABLED=false \
  PORT=5174 nohup bun run dev -- --port 5174 > /tmp/scratch-5174.log 2>&1 &
echo "TRACKED_PID:$!"; disown
```

`KNOWLEDGE_GRAPH_ENABLED=false` is required whenever the user's own `:5173` is running (the in-process KG server would collide on `:9087`). Wait for the port to actually bind (`lsof -nP -iTCP:5174 -sTCP:LISTEN`) before sending traffic -- don't sleep-and-hope.

**Port-tracking gotcha**: killing a tracked PID does not guarantee the port is free if an earlier, untracked instance of the same dev server is still running -- Vite silently falls back to the next port (`:5175`, etc.) instead of erroring, so checking only your intended port can show clean while a collision is happening one port over. After any restart, check `lsof` on the EXACT port you expect (not just "is something listening"), and if a replay unexpectedly targets a different port than you started, `ps aux | grep vite` to find the full parent/child chain before assuming the new instance is the one you're testing.

**Session-drop gotcha**: if a background replay is interrupted by a session or connection drop, don't assume anything is orphaned -- check whether the tracked PID and the port listener are both already gone (the process tree usually tears down cleanly) before doing any cleanup. Verify with `lsof` and `ps -p <pid>`, don't guess.

## Phase 3: Replay and collect evidence

```bash
curl -sS -X POST http://localhost:5174/api/agent/stream \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"<incident prompt>"}],"dataSources":["<ds>"]}' \
  --max-time 300 -o steering-replay.sse
```

1. Extract the `{"type":"done"}` event's `toolsUsed[]` -- the fastest "did this tool fire at all" check, but it proves nothing about arguments.
2. For argument-level verification (which scope value, which symbol, which project/MR id), pull the LangSmith trace:
   ```bash
   LANGSMITH_API_KEY=<key> LANGSMITH_PROJECT=<project> langsmith run list \
     --run-type tool --name <tool_name> --last-n-minutes <N> --limit 5 --format json
   LANGSMITH_API_KEY=<key> langsmith run get <run_id> --full
   ```
   `--last-n-minutes` windows can catch stale runs from an earlier test in the same session -- always cross-check the `trace_id` against the SSE response's `runId`/`threadId` before trusting a match.
3. Reassemble the final streamed answer (`{"type":"message"}` chunks, concatenate `content`) and check whether the tool call's result actually reached the report in the expected form -- a tool firing with the right arguments is necessary but not sufficient; also check whether an empty/negative result is reported as the designed "this is normal" language or misreported as a gap.
4. Also check the dev server's own log for structural signals that don't show up in the trace at all -- e.g. `Runbook selection complete ... always_select:"<name>"` proves a runbook reached the aggregator regardless of LLM router discretion, which is a different (and often more reliable) signal than anything in the tool-call trace.

**Scoring rule**: a soft miss (a behavior that should fire but doesn't, once) earns EXACTLY ONE re-run with a fresh threadId before you classify it as a genuine steering defect. Two independent misses (0/2) is a real finding, not noise -- do not keep re-running hoping for a different result; two data points is the budget, and if you're tempted to run a third "just to be sure" without a strong prior reason, that's a sign you should be looking for a root cause instead of gathering more samples.

## Phase 4: Root-cause and fix (only if a genuine defect is found)

1. **Don't assume the fix is "make the instruction stronger" or "make it mandatory."** Check first whether the steering is already correctly scoped as conditional/optional and whether making it a hard mandate would actually be counterproductive (a cheap, low-value-when-empty check like a prior-art search doesn't need to become a blocking requirement just because it's unreliable). If the user or the steering's own design intent says "this shouldn't be a strict rule unless skipping it is unhelpful," respect that -- fix clarity, not compliance-forcing.
2. Look for STRUCTURAL causes before assuming pure prompt-following failure:
   - Two behaviors sharing one ambiguous trigger condition, where the model treats the whole block as skippable together even though only one branch of the condition was false (this was SIO-1322's actual root cause for the notes-step miss -- two steps shared a "pipeline is failing" gate; all pipelines were green, so both steps got skipped even though the OTHER trigger branch, "changed files overlap," was independently true).
   - A steering instruction referencing a tool parameter value that is wrong, outdated, or simply undocumented in the wrapper's schema (Phase 0.4's class of bug).
   - Compare the failing behavior's phrasing against a KNOWN-RELIABLE behavior in the same file (find one whose `toolsUsed` evidence shows it firing consistently) -- a flat, unconditional imperative that doesn't reference a prior judgment call tends to fire more reliably than a nested "also for the X picked in step Y" dependency.
3. Apply the fix, then re-verify against the SAME Phase 2/3 replay procedure, not just typecheck/lint -- a documentation-only or prose-only change still needs a live behavioral re-test, because the whole point of this runbook is that prose existing is not the same as prose working.
4. Run the full verification stack before committing: `bun run typecheck && bun run lint`, plus the gitagent-bridge test suite (skill-tool-coverage budget canary, runbook-validator tail-citation contract -- watch for citing a tool name with call-syntax like `` `tool(arg: val)` `` inside one backtick span, which breaks the tail-section citation regex that expects a bare snake_case token).
5. One allowed re-run per behavior applies to the FIX verification too -- if a fix doesn't reproduce cleanly across the minimum evidence bar you set in Phase 1, don't declare it fixed; document it honestly as "improved but not resolved," including partial/positive-but-inconclusive signals (a check that fires once with clean arguments after 3 failed prior attempts is a positive data point, not a fix).

## Phase 5: Report and disposition

1. Score each audited behavior independently: FIXED (reproduced across the minimum evidence bar), PARTIAL (the underlying mechanism works but a different pre-existing issue prevents useful output -- e.g. the SIO-1318/1322 case where blast-radius's tool-layer fix was proven live but the agent anchored on the wrong symbol, a separate steering question), NOT FIXED / OPEN (still an undiagnosed prompt-following gap), or PASS (already worked, no fix needed).
2. Write up root-cause analysis with concrete evidence (thread IDs, trace IDs, exact tool arguments), not just verdicts -- the report should let a future session reproduce your reasoning without re-running the replay.
3. If review (CodeRabbit or human) surfaces a claim you made that turns out to be wrong, correct it explicitly in the doc rather than quietly editing it away -- a documented self-correction (what was claimed, why it was wrong, how it was caught, what changed) is more valuable to future sessions than a clean-looking doc that hides the mistake.
4. Track disposition in Linear per this repo's normal workflow: issue before implementation, In Review (not Done) pending any required live smoke-test, never Done without explicit user approval.

## Case study anchors (GitLab, 2026-07-31)

- SIO-1320 encoded 4 new steering behaviors (review-notes step, conditional prior-art check, blast-radius pipeline integration, aggregator investigation checklist) across SKILL.md and the runbook.
- SIO-1322 live-replayed a styles-v3 incident twice pre-fix (0/2 on two of the four behaviors -- a genuine structural gap, not noise), diagnosed root cause, fixed the notes-step (2/2 post-fix, confirmed again on a post-merge replay), and caught a self-inflicted false claim about an "invalid" tool scope value mid-fix (caught via CodeRabbit review + live schema + upstream docs, reverted before merge).
- Full evidence: `experiments/gitlab-code-analysis-orbit-deep-test-2026-07-31.md` ("SIO-1322 verification", "SIO-1322 follow-up", "CodeRabbit triage", "Post-merge confirmation replay" sections). Fix: PR #558.
