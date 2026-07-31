# HANDOFF 2026-07-31: SIO-1322 -- live-verify the SIO-1320 steering in a full styles-v3 incident replay

- Date: 2026-07-31
- Ticket for THIS work: https://linear.app/siobytes/issue/SIO-1322 (Todo -- set In Progress when you start; NEVER Done without user approval)
- Parent context (all Done, merged to main):
  - https://linear.app/siobytes/issue/SIO-1316 -- 37-tool deep test + log parity (PR #555, `e5d08a3e`)
  - https://linear.app/siobytes/issue/SIO-1318 -- Orbit >= 0.91 traversal-shape fix, tool handler + agent extractor (PR #555)
  - https://linear.app/siobytes/issue/SIO-1320 -- steering changes under test here (PR #556, merged 19:08Z as `79b560c9`)
- Repo state: `main` @ `79b560c9` (or later). Branch: none needed -- this is a read-only verification; branch only if defects need fixing.
- Companion doc (different scope -- curl-level MCP tool replay, no agent): `experiments/HANDOFF-2026-07-31-gitlab-37-tool-deep-test-styles-v3-replay.md`
- Full deep-test results + steering audit: `experiments/gitlab-code-analysis-orbit-deep-test-2026-07-31.md`

## TL;DR

SIO-1320 added three behaviors to the gitlab-agent's steering: (1) `gitlab_get_merge_request_notes` on the strongest culprit MR, (2) a conditional prior-art check (`gitlab_search` scope=issues with ERROR-CLASS vocabulary), (3) an Investigation Question Checklist in the code-change-correlation runbook (aggregator-side). This session must prove the sub-agent follows them ORGANICALLY in a real pipeline run -- evidence from the LangSmith trace / SSE `toolsUsed`, not from final prose. The styles-v3 Couchbase timeout is the incident; success = the four pass criteria below.

## What changed (verify against these exact places)

- `agents/incident-analyzer/agents/gitlab-agent/skills/code-change-correlation/SKILL.md`: deploy-vs-runtime chain step 4 (notes for STRONGEST candidate only, max 2 cited notes, "empty or purely procedural discussion is reported as nothing"); new section "Prior-art check (one cheap query, only when the error class is distinctive)" -- ERROR-CLASS vocabulary, never service names, zero hits is normal, no synonym retries.
- `agents/incident-analyzer/knowledge/runbooks/code-change-correlation.md`: "Investigation Question Checklist" section after "When This Applies"; Step 4 item 4 (notes); frontmatter tools + tail CSV extended (notes, pipeline jobs, job log, get_issue).
- Budget fact: skill-promised backticked names are now 17/17 (AT the belt cap). If the canary (`packages/gitagent-bridge` skill-tool-coverage test) fails on your branch, someone added an 18th name -- that is a real failure, not noise.

## The incident prompt (send verbatim as the user message)

```
Investigate this production incident: styles-v3 service is throwing Couchbase timeouts.

@timestamp Jul 30, 2026 @ 16:40:04.086, service.name pvh-services-styles-v3, production.
message: styles-v3-service exception: com.couchbase.client.core.error.UnambiguousTimeoutException: GetRequest, Reason: TIMEOUT {"cancelled":true,"completed":true,"idempotent":true,"lastDispatchedTo":"private-endpoint.mn1uxqblvorb0cle.cloud.couchbase.com:11213","requestType":"GetRequest","retried":0,"service":{"bucket":"default","collection":"product2g","documentId":"PRODUCT_2027WISPSP_LV04F3853G","scope":"styles","type":"kv","vbucket":495},"timeoutMs":2500,"timings":{"totalMicros":2531694}}
error.exception.type: com.couchbase.client.core.error.UnambiguousTimeoutException
surfaced by pvh.services.styles.exception.GlobalExceptionHandler (OTel Java agent).
Did a recent code change or deployment cause this?
```

The trailing question nudges the classifier to complex + the router toward code-change correlation. Known ground truth: project `pvhcorp/b2b/shared-services/pvh.services.styles` id 43242609; MRs 376-383 merged Jul 23-30 (379 = last main merge before onset, its notes are procedural merge-automation notes; 380/381/383 modify Couchbase index JSONs); blast radius for `getStyleByStyleCode` -> `StyleController.java`, `listsapi/StylesAPIRestClient.java`, TS contract, with mrByFile MR 355/352/11.

## Setup (do NOT touch the user's :5173 or :9084 processes)

1. Preflight the gitlab MCP on :9084 (it must run post-`e5d08a3e` code). One curl:
   ```bash
   curl -sS -m 120 -X POST http://localhost:9084/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gitlab_blast_radius","arguments":{"symbol":"getStyleByStyleCode","limit":20}}}' | grep '^data:' | sed 's/^data: //' | grep -o 'definition-name-match' | head -1
   ```
   Expect `definition-name-match`. If absent, the :9084 process predates the fix -- ask the user to restart it (it is THEIR server; never kill it yourself). This costs ~2 billed Orbit queries.
2. Start a throwaway web app on :5174 from the MAIN checkout (agent knowledge -- skills/runbooks -- is cached per-process, so a fresh process is the point; the user's :5173 may hold stale knowledge):
   ```bash
   cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer/apps/web
   KNOWLEDGE_GRAPH_ENABLED=false LIVE_MEMORY_ENABLED=false AGENT_MEMORY_ENABLED=false PORT=5174 bun run dev -- --port 5174 > /tmp/scratch-5174.log 2>&1 &
   ```
   Track the PID. `KNOWLEDGE_GRAPH_ENABLED=false` is REQUIRED while the user's :5173 runs (the in-process KG MCP would collide on :9087). MCP URLs are in the main root `.env` (base URLs, no `/mcp` suffix -- the bridge appends it).
3. Kick off the replay (SSE, 60-180s; `messages[]` shape, NOT a bare `message` string):
   ```bash
   curl -sS -X POST http://localhost:5174/api/agent/stream \
     -H "Content-Type: application/json" \
     -d '{"messages":[{"role":"user","content":"<the incident prompt above>"}],"dataSources":["gitlab"]}' \
     --max-time 300 -o "$SCRATCH/steering-replay.sse"
   ```
   `{"type":"done"}` carries `toolsUsed[]` -- the fastest first check. The final answer streams as many `{"type":"message"}` chunks; concatenate `content` to reassemble.

## Pass criteria (all evidence-based)

| # | Behavior (source) | Evidence to collect | Expected |
|---|---|---|---|
| 1 | Review-notes step (SKILL step 4, NEW) | `gitlab_get_merge_request_notes` in toolsUsed / LangSmith tool runs, on the strongest candidate MR | Called once; notes are procedural -> agent cites nothing and does NOT report a gap |
| 2 | Prior-art check (SKILL new section, NEW) | a `gitlab_search` tool run with scope issues | Query uses ERROR-CLASS vocabulary (e.g. "UnambiguousTimeoutException"), NOT "styles"; 0 hits treated as normal; no synonym retries |
| 3 | Blast radius through the pipeline (SIO-1318) | `gitlab_blast_radius` tool run output + aggregator input / final report | radiusMode "definition-name-match" rows; downstream `listsapi` / `StylesAPIRestClient` named in findings (orbitFindings.blastRadius non-empty) |
| 4 | Runbook checklist reaches the aggregator | router selection log / aggregator prompt in LangSmith | IF code-change-correlation is selected, its body contains "Investigation Question Checklist". Non-selection = SIO-1302 limitation, NOT a failure |

Scoring: 1-3 are the SIO-1320/1318 verdicts. LLM behavior is probabilistic -- a soft miss earns EXACTLY ONE re-run (fresh threadId) before classifying as a steering defect. The strongest candidate may be MR 379 or 383; either is valid for criterion 1.

## LangSmith evidence commands

```bash
grep "^LANGSMITH_API_KEY=" /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer/.env
# batch traces (single-trace fetch returns incomplete data):
LANGSMITH_API_KEY=<key> LANGSMITH_PROJECT=<project from .env> langsmith-fetch traces /tmp/traces --limit 5 --last-n-minutes 15 --include-metadata
# per-tool child runs need the Go CLI, not langsmith-fetch:
langsmith run list --run-type tool --name gitlab_get_merge_request_notes --last-n-minutes 15 --limit 5 --format json
langsmith run get <run_id> --full
```

## Cleanup (non-negotiable)

- Kill YOUR :5174 web app by tracked PID; prove `lsof -nP -iTCP:5174 -sTCP:LISTEN` empty.
- Never kill :5173 (user's web app), :9084 (user's gitlab MCP), or any process you did not start.
- Billed budget: preflight ~2 + replay ~3-8 Orbit queries per run (cap 20/60s -- one replay cannot hit it).
- Results: append a "SIO-1322 verification" section to `experiments/gitlab-code-analysis-orbit-deep-test-2026-07-31.md` or a short new experiments/ note; update SIO-1322 with the verdict (In Progress -> user decides Done).

## Risks / gotchas

- Agent knowledge cached per-process: verifying against a web app started before the #556 merge silently tests the OLD steering. The :5174 fresh process exists to rule this out.
- Router discretion: code-change-correlation runbook selection is max-3-picks LLM discretion (SIO-1302 open). The SKILL behaviors (criteria 1-2) do not depend on runbook selection -- skills always ship with the sub-agent.
- `gitlab_get_merge_request_conflicts` returns isError:true for "no conflicts" (benign upstream quirk) -- do not count it as a failure if the agent calls it.
- The done-event `toolsUsed[]` proves a tool ran but not its arguments -- criterion 2's vocabulary check needs the LangSmith tool run input.
- Orbit "migrating" flips self-heal per-call (SIO-1295); a lone no-index envelope deserves one retry.

## Out of scope

SIO-1302 (mandatory runbook selection), SIO-1300 (TYPED_FINDING_TOOLS persist cap -- a huge blast-radius envelope can still truncate at 64KB in persisted state; note it if seen, do not fix here), wiki action mapping, Capella-side root-cause work.

## Memory references

`reference_sio1318_orbitrows_traversal_shape_bug` (fix + steering-audit state, belt cap 17/17), `reference_orbit_steering_audit_and_replay` (prior live replay proof + recipe), `reference_agent_stream_curl_endpoint`, `reference_worktree_web_server_replay_env` (env gotchas; here main-checkout :5174 suffices), `reference_agent_knowledge_cached_per_process`, `reference_session_gitlab_mcp_is_stdio_not_9084`, `reference_langsmith_child_runs_via_sdk`.
