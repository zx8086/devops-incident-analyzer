# HANDOFF 2026-07-28 — report defects found in the first GOOD run after the config restore

| | |
|---|---|
| **Date** | 2026-07-28 |
| **Tickets** | [SIO-1264](https://linear.app/siobytes/issue/SIO-1264) (High), [SIO-1265](https://linear.app/siobytes/issue/SIO-1265) (High), [SIO-1266](https://linear.app/siobytes/issue/SIO-1266) (Medium), [SIO-1267](https://linear.app/siobytes/issue/SIO-1267) (Medium), [SIO-1268](https://linear.app/siobytes/issue/SIO-1268) (Low) |
| **Parent context** | [SIO-1241](https://linear.app/siobytes/issue/SIO-1241) (report-quality wave), [SIO-1262](https://linear.app/siobytes/issue/SIO-1262) (the config restore that made this run good) |
| **Also open** | [SIO-1261](https://linear.app/siobytes/issue/SIO-1261) — PR [#505](https://github.com/zx8086/devops-incident-analyzer/pull/505), `CHANGES_REQUESTED`, unfinished. See "Open PR" below. |
| **Repo state** | `main` at `b0774c3f` ("SIO-1263: pin the effective sub-agent model and turn budget (#506)") |
| **Source run** | `2445908e-c00f-4830-b9fd-fd7d36a37071` / request `277ad174-6530-43ee-8703-3a6cf48184e1` — investigation of `pvh-services-styles-v3`, written up as [DEVOPS-1407](https://pvhcorp.atlassian.net/browse/DEVOPS-1407) |
| **Suggested branches** | `claude/sio-1264-capella-ping-latency-units`, `claude/sio-1265-multi-search-schema` |

---

## TL;DR

The 2026-07-27 report-quality wave shipped and the config regression behind it was restored
(SIO-1262). The next live run was **good**: 7/7 datasources returned 6,069–12,387 chars, zero
truncations, and the analysis was properly evidenced. Reviewing that good run surfaced five *new*
defects, none of them the ones the previous handover chased.

Two matter. **SIO-1264**: `capella_get_cluster_health` emits the Couchbase SDK's `latency_us`
verbatim, the model read microseconds as milliseconds, and a 264 ms ping became "264,000 ms" — rated
**Critical** and used as one of two pillars of the stated root cause. **SIO-1265**:
`elasticsearch_multi_search` has no schema for the `searches` array, the model sent a wrong-but-natural
shape, Elasticsearch rejected it, and the report published the failed query as **"0 hits"** — a
fabricated negative. That fabricated row then tripped the absence corrector, hard-capping confidence
0.85 → 0.59 and crossing the HITL gate.

Success looks like: the Couchbase latency line reads in the hundreds of ms and is not Critical on its
own; a malformed msearch fails validation instead of becoming a finding; the run does not get
hard-capped for a reason that isn't true.

**Do SIO-1264 and SIO-1265 first.** Both are small, both live in MCP tools rather than agent logic,
and between them they produced one wrong severity and one fabricated negative. SIO-1266 largely
stops firing once SIO-1265 is fixed. SIO-1267 and SIO-1268 are efficiency, not correctness.

---

## Context — how these tickets came to be

The previous handover, `experiments/HANDOFF-2026-07-27-live-replay-defects.md`, framed a degraded
2026-07-27 run as five independent pipeline defects. That framing was **superseded** (a banner now
says so at the top of that file). The real cause was three config changes stacked between the good
2026-07-25 run and the bad one, documented in
`experiments/HANDOFF-2026-07-27-sio1241-config-regression.md` (`ea6b61f5`, corrected by `53dc4214`):

1. `cd7c628a` (SIO-1213) bumped the root model sonnet-4-6 → sonnet-5; specialists silently followed
   because their manifests were dead config.
2. `aaad8eec` (SIO-1235) made the manifests live — dropping all 7 specialists to `claude-haiku-4-5`.
3. `86a47956` (SIO-1250) added `preModelHook`, which is a graph **node**, making a ReAct cycle 3
   super-steps instead of 2 and silently costing every sub-agent ~⅓ of its recursion budget.

SIO-1262 (`c7f37e12`, PR [#503](https://github.com/zx8086/devops-incident-analyzer/pull/503)) restored
both levers. Confidence went **0.45 → 0.78** on the replay. SIO-1263 (`b0774c3f`, PR
[#506](https://github.com/zx8086/devops-incident-analyzer/pull/506)) then pinned the effective
sub-agent model and turn budget so that drift cannot be silent again.

**The five tickets in this handover come from reviewing the good run, not a failing one.** They are
what remains once capacity is no longer the bottleneck.

### The wave, for reference (all merged to `main`)

| Commit | Ticket | PR | What it did |
|---|---|---|---|
| `c7f37e12` | SIO-1262 | [#503](https://github.com/zx8086/devops-incident-analyzer/pull/503) | Probed model + honest recursion budgets. **The one that mattered.** |
| `b21cdd38` | SIO-1256 | [#498](https://github.com/zx8086/devops-incident-analyzer/pull/498) | `orderByDeclaration` — bound `aws_ecs_list_tasks` by making the belt order-independent |
| `0b73f4e5` | SIO-1257 | [#499](https://github.com/zx8086/devops-incident-analyzer/pull/499) | `SUB_AGENT_NON_INTERACTIVE_PREAMBLE` — there is no human to defer to |
| `3dd16fac` | SIO-1258 | [#500](https://github.com/zx8086/devops-incident-analyzer/pull/500) | Resolve a GitLab project once per turn, not once per call |
| `8f39beb8` | SIO-1259 | [#504](https://github.com/zx8086/devops-incident-analyzer/pull/504) | Count short "no results" prose as unproductive |
| `8ba1d548` | SIO-1260 | [#502](https://github.com/zx8086/devops-incident-analyzer/pull/502) | Truncation synthesis — a truncated sub-agent reports what it found |
| `b0774c3f` | SIO-1263 | [#506](https://github.com/zx8086/devops-incident-analyzer/pull/506) | Pin the effective model + turn budget against future drift |

### What the restore proved (run `2445908e`)

Keep these as the baseline any regression is measured against:

- **7/7 datasources returned substantive findings**, 6,069–12,387 chars each. **Zero truncations.**
- **Light-tier decoupling visibly working**: `absenceJudge` ran on Haiku with `source: "light-tier"`
  while the specialists ran Sonnet 4.6. That separation is what SIO-1262 introduced via
  `LIGHT_TIER_MODEL` in [llm.ts](packages/agent/src/llm.ts) — before it, cheap roles borrowed the
  elastic manifest's model.
- **AWS used 59 of its 60 iterations.** At the pre-restore limit of 40 that estate would have
  truncated. (That is also SIO-1268: the restored budget is masking an inefficiency, not curing it.)
- The gitlab sub-agent **correctly rejected** candidate project 852088 as an unrelated iOS framework
  rather than adopting it — the discipline SIO-1258 and SIO-1261 exist to enforce.

---

## Where the bodies are buried

### SIO-1264 — Couchbase ping latency in microseconds, unlabelled (**High**)

[packages/mcp-server-couchbase/src/tools/getClusterHealth.ts:13-27](packages/mcp-server-couchbase/src/tools/getClusterHealth.ts:13):

```ts
export const getClusterHealthHandler = async (params: { bucket_name?: string }, bucket: Bucket) => {
	try {
		const target = params.bucket_name ? resolveBucket(bucket, params.bucket_name) : bucket.cluster;
		const pingResult = await target.ping();
		// PingResult has toJSON() in the SDK; fall back to the raw object for mocks.
		const raw =
			typeof (pingResult as { toJSON?: () => unknown }).toJSON === "function"
				? (pingResult as { toJSON: () => unknown }).toJSON()
				: pingResult;
		const payload = {
			scope: params.bucket_name ? `bucket:${params.bucket_name}` : "cluster",
			ping: raw,                       // <-- latency_us passed through VERBATIM
		};
		return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
```

The SDK field is microseconds — `node_modules/couchbase/dist/diagnosticstypes.d.ts:54`
(`JsonPingReport`):

```ts
services: { [serviceType: string]: { latency_us: number; remote: string; ... }[] }
```

**Impact.** The report stated *"query-service ping latency 264,000–280,000 ms (vs. normal
single-digit ms) … KV latency 14,000–22,000 ms"*. Real values: **264–280 ms** query, **14–22 ms** KV.
Elevated under load, entirely plausible — not "extreme". A 264,000 ms ping is a 4.4-minute round
trip, i.e. a dead cluster. That number was rated **Critical** in the correlated timeline, was one of
two pillars of the stated Root Cause, and produced a Monitor recommendation calibrated to a
fictional baseline. The other pillar (`SslHandler.channelInactive` from AWS stack traces) and the 2
FFDC records on `svc-qi-node-135` still stand; the "extreme latency" claim does not.

### SIO-1265 — `elasticsearch_multi_search` has no schema (**High**)

[packages/mcp-server-elastic/src/tools/search/multi_search.ts:18-25](packages/mcp-server-elastic/src/tools/search/multi_search.ts:18):

```ts
const multiSearchValidator = z.object({
	searches: z.array(z.object({}).passthrough()),   // no shape, no .describe()
	index: z.string().optional(),
	maxConcurrentSearches: z.number().optional(),
	...
});
```

Passed straight through at [:110-118](packages/mcp-server-elastic/src/tools/search/multi_search.ts:110):

```ts
const result = await esClient.msearch({
	searches: params.searches as unknown as estypes.MsearchRequestItem[],
	index: params.index,
	...
});
```

Elasticsearch `msearch` requires an **alternating** array — metadata line, then body line, repeating.
Nothing in the schema, the tool description, or a `.describe()` says so. The model guessed a
natural-but-wrong `{header, body}` shape and ES returned
`illegal_argument_exception: key [header] is not supported in the metadata section`.

**Two compounding problems, not one:**

1. The schema teaches the model nothing, so the wrong shape is the likely guess.
2. The failure is **invisible in the tool result the sub-agent reads**. The handler counts
   `failedSearches` and calls `notificationManager.sendWarning(...)` at
   [:183-200](packages/mcp-server-elastic/src/tools/search/multi_search.ts:183) — but notifications
   do **not** reach the sub-agent. The only thing that does is
   [:202-204](packages/mcp-server-elastic/src/tools/search/multi_search.ts:202):

```ts
return {
	content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
};
```

The per-response `error` objects are in there, buried, with no summary line saying "N of M searches
failed". The model skimmed it as an empty result.

**Impact.** The correlated timeline published:

> `| 2026-07-28T05:12:46Z-06:12:46Z (investigation window) | Elastic | 0 hits for CHANNEL_CLOSED_WHILE_IN_FLIGHT in exact window per elasticsearch_multi_search | - |`

The Gaps section separately admits the tool malfunctioned, so the report contradicts itself — and the
fabricated direction is the dangerous one ("the error is not happening now").

### SIO-1266 — absence corrector: right cap, wrong reason (**Medium**, downstream of SIO-1265)

The corrector capped confidence **0.85 → 0.59** (`capMode: "hard"`, `capReasons: ["premature-absence"]`),
crossing the HITL threshold of 0.6. **The cap was correct** — the flagged claim was genuinely
unsupported. **The stated reason was not.**

[packages/agent/src/aggregator.ts:1024-1025](packages/agent/src/aggregator.ts:1024):

```ts
const CONTRADICTED_ABSENCE_NOTE =
	"The labelled datasource returned data matching this claim, so the absence is not supported. Treat the returned data as ground truth.";
```

Elastic returned 121 hits over **30 days**. The claim was about a **1-hour** window. Those do not
contradict each other. The mechanism is at
[packages/agent/src/aggregator.ts:966-998](packages/agent/src/aggregator.ts:966):

```ts
export function detectPrematureAbsence(
	answer: string,
	results: DataSourceResult[],
): { contradicted: string[]; overgeneralized: string[]; contradictedDetails: AbsenceClaim[] } {
	const dataByDs = new Map<string, boolean>();
	for (const r of results) {
		dataByDs.set(r.dataSourceId, (dataByDs.get(r.dataSourceId) ?? false) || dataSourceReturnedData(r));
	}
	...
		const ds = attributeAbsenceLine(line, (id) => dataByDs.get(id) === true);
```

`dataSourceReturnedData(r)` is **turn-wide**. It has no notion of the window the claim was about, and
no notion of "the specific call behind this claim errored". `absenceJudge` did not catch the
difference either (`verdicts: [{index: 0, keep: true}]`) — it is not given the turn's tool-error list.

### SIO-1267 — gitlab burned 8 iterations on duplicate searches (**Medium**, efficiency)

`subagent.loop_guard_stop` fired **8 times** on `gitlab_search` — iterations 6, 8, 9, 10, 11, 14, 15,
16 — every one with `unproductiveSearches: 0`. That counter being 0 means these were
**duplicate-signature** stops, not unproductive-result stops: the agent kept re-issuing searches it
had already made. The guard did its job (nothing reached GitLab), but 8 of 29 messages were spent on
refused calls. gitlab still returned 6,069 chars and did not truncate, so this is cost, not
correctness.

`agents/incident-analyzer/agents/gitlab-agent/skills/project-resolution/SKILL.md` says "resolve ONCE
PER DISTINCT PROJECT" (SIO-1258). It does **not** say "do not repeat a search you have already run".

### SIO-1268 — AWS spends 191s / 59-of-60 iterations proving a negative (**Low**, efficiency)

| Estate | Service present? | Duration | messageCount | Peak iteration |
|---|---|---|---|---|
| eu-shared-services-prd | **yes** | 117s | 29 | ~21 |
| eu-oit-prd | **no** | **191s** | **78** | **59** (limit 60) |

The estate where the service does **not** exist cost 63% more wall clock and 2.7× the messages. Most
of it was CloudWatch Insights polling against empty results — `subagent.aws_empty_results_advice`
(the SIO-1141 widen-window advice) fired at iterations 26, 32, 33, 51, and
`aws_logs_get_query_results` returned ~340-byte empty payloads at 19, 26–34, 47, 51, 54, 56, 58.

The agent had the decisive evidence by roughly iteration 15: `aws_ecs_list_clusters` +
`aws_ecs_list_services` across all 7 clusters returned no match. Everything after was re-confirming a
negative. Note this run used `sourceMethod: "ui-selected"` — the user picked both estates explicitly,
so `awsEstateRouter` was never consulted; an early-exit inside the sub-agent is the general fix.

---

## The fix (step-by-step)

### Step 1 — SIO-1264: convert microseconds to milliseconds

In [packages/mcp-server-couchbase/src/tools/getClusterHealth.ts](packages/mcp-server-couchbase/src/tools/getClusterHealth.ts),
map the ping report before returning it. Preferred shape: emit `latencyMs` as the primary field so
the LLM never sees an ambiguous unit, and keep `latency_us` alongside for fidelity.

```ts
// SIO-1264: the SDK reports latency in MICROSECONDS (JsonPingReport.latency_us). Passed through
// verbatim, run 2445908e read 264000 us as 264,000 ms and rated a healthy-under-load cluster
// Critical. Emit an explicitly-named millisecond field; keep the raw value beside it.
function withLatencyMs(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const report = raw as { services?: Record<string, Array<Record<string, unknown>>> };
	if (!report.services) return raw;
	const services: Record<string, Array<Record<string, unknown>>> = {};
	for (const [serviceType, entries] of Object.entries(report.services)) {
		services[serviceType] = entries.map((entry) => {
			const us = entry.latency_us;
			return typeof us === "number" ? { ...entry, latencyMs: Math.round(us / 1000) } : entry;
		});
	}
	return { ...report, services };
}
```

Then `ping: withLatencyMs(raw)`. Rounding to whole ms is deliberate — sub-millisecond precision is
noise for an incident report and a bare integer is harder to misread than `0.264`.

Also update the tool description at
[getClusterHealth.ts:38-40](packages/mcp-server-couchbase/src/tools/getClusterHealth.ts:38) to name
the unit.

**Audit the same class.** Any tool returning an SDK `toJSON()` straight through may carry
unit-suffixed fields. `capella_get_system_vitals` is the obvious next one.

### Step 2 — SIO-1265: give `searches` a real schema, and make failure visible

Two changes in
[packages/mcp-server-elastic/src/tools/search/multi_search.ts](packages/mcp-server-elastic/src/tools/search/multi_search.ts).

**(a) Accept a shape the model cannot get wrong, and build the alternating array in the tool.** This
is preferred over validating the raw msearch contract — it removes a footgun the model cannot see.

```ts
// SIO-1265: msearch takes an ALTERNATING metadata/body array. Nothing in the old
// `z.array(z.object({}).passthrough())` said so, so run 2445908e sent {header, body} and ES
// returned illegal_argument_exception. Accept the obvious per-search shape and flatten here.
const searchSpec = z
	.object({
		index: z.string().optional().describe("Index or pattern for this search. Falls back to the top-level `index`."),
		query: z.record(z.unknown()).describe("The query DSL body, e.g. {\"query\":{\"match_all\":{}},\"size\":10}"),
	})
	.describe('One search. Example: {"index":"logs-*","query":{"query":{"term":{"level":"error"}},"size":5}}');
```

Keep backwards compatibility with the raw alternating form via a union if any caller depends on it —
check first, and if nothing does, don't add the union.

**(b) Put the failure in the tool result, not only in a notification.** The sub-agent only ever reads
`content`. Prepend an explicit summary so a failed search cannot be skimmed as an empty one:

```ts
// SIO-1265: notificationManager output never reaches the sub-agent -- only `content` does. A
// per-response error buried in the raw msearch JSON was read as "0 hits" and published as a
// finding. State the failure count first, in prose.
const header =
	failedSearches > 0
		? `WARNING: ${failedSearches} of ${searchCount} searches FAILED. A failed search is not a zero-hit search. Do not report absence based on this result.\n\n`
		: "";
return { content: [{ type: "text", text: header + JSON.stringify(result, null, 2) }] };
```

Add a `.describe()` with a copy-pasteable example on the `searches` array itself — per memory
`reference_sio1085_query_examples_and_malformed_syntax`, these prompts need literal examples, not
prose.

### Step 3 — SIO-1266: separate "contradicted" from "unverifiable"

Do this **after** Step 2, and treat it as independently worth fixing (any future failed call
reproduces it).

1. In [aggregator.ts](packages/agent/src/aggregator.ts), split
   `CONTRADICTED_ABSENCE_NOTE` into two notes and `buildPrematureAbsenceCaveats` into two guards:
   `premature-absence-contradicted` (data genuinely contradicts) and a new
   `premature-absence-unverifiable` (the call behind the claim errored). A failed call is a
   **coverage gap**, not a synthesis error, and arguably warrants the soft cap rather than the hard
   0.59 — decide explicitly and say so in the PR body.
2. Window-scope the contradiction check: when a claim cites a specific window, compare against data
   **from that window**, not any data the datasource returned that turn. `detectPrematureAbsence`'s
   `dataByDs` map at [aggregator.ts:970-973](packages/agent/src/aggregator.ts:970) is turn-wide today.
3. Give `judgeContradictedAbsenceClaims`
   ([packages/agent/src/absence-judge.ts:142](packages/agent/src/absence-judge.ts:142)) the turn's
   tool-error list so it can veto on "the call errored" grounds. Note `SIO-1195`: 0.59 is the **hard**
   cap and crossing 0.6 gates HITL — changing which cap fires is a behaviour change, not a wording fix.

### Step 4 — SIO-1267: mark a search term exhausted

In `agents/incident-analyzer/agents/gitlab-agent/skills/project-resolution/SKILL.md`, add an explicit
rule: once a given search term has returned empty, treat that term as **exhausted** — try a
materially different term or STOP per STEP 3; do not re-issue it. Check whether the loop guard's
refusal text reads as a transient failure; if it does, the model will keep retrying regardless of the
prose.

**Budget canary still applies** — gitlab-agent must report **16** backticked tool names (ceiling 17):

```bash
cd agents/incident-analyzer/agents/gitlab-agent
grep -ohE '`gitlab_[a-z0-9_]+`' SOUL.md skills/*/SKILL.md | tr -d '`' | sort -u | wc -l
```

### Step 5 — SIO-1268: early-exit when an estate has been enumerated clean

When a full ECS enumeration of an estate yields zero matches for every focus token, record "service
not deployed in this estate" and stop — do not proceed to log-group discovery and Insights polling.
The widen-window advice (`subagent.aws_empty_results_advice`) should probably also not fire once the
service has been shown absent from the estate.

---

## Verification

```bash
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer
bun run typecheck && bun run lint && bun run test
bun run --filter '@devops-agent/mcp-server-couchbase' test
bun run --filter '@devops-agent/mcp-server-elastic' test
bun run --filter '@devops-agent/agent' test
bun run yaml:check
```

Existing Couchbase tool tests live in `packages/mcp-server-couchbase/tests/tools.test.ts` — extend
that file rather than creating a sibling.

**Unit assertions to add:**

- SIO-1264: `264000` us → `latencyMs: 264`. Pin the exact number from the run so a future reader can
  trace it back to DEVOPS-1407.
- SIO-1265: a `{header, body}` payload fails schema validation with an actionable message **before**
  reaching ES; and a result with `failedSearches > 0` produces content whose first line names the
  failure count.
- SIO-1266: a claim about a 1-hour window is not flagged as contradicted by data from a 30-day query.

**Live probe for SIO-1264** (the MCP tool, not just the unit test — CLAUDE.md requires running tool
changes, and this defect is precisely about what the *live* payload looks like):

```bash
lsof -nP -iTCP:9082 -sTCP:LISTEN     # must be empty before you start anything
# start the couchbase MCP, then:
curl -s http://localhost:9082/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capella_get_cluster_health","arguments":{}}}' \
  | grep -o 'latency[^,]*'
```

Expected: a `latencyMs` in the tens-to-hundreds, alongside a `latency_us` three orders of magnitude
larger. **Kill what you start, by tracked PID, and prove the port is free afterwards** — see
`feedback_always_kill_own_background_processes_safely`.

**End-to-end**: re-run the `pvh-services-styles-v3` investigation. The Couchbase latency line should
read in the hundreds of ms and should NOT be rated Critical on its own; the exact-window Elastic
query should either succeed or be reported as "query failed", never as "0 hits"; and confidence
should not be hard-capped at 0.59 for a contradiction that isn't one.

Replay recipe (`reference_worktree_web_server_replay_env`): the user's `:5173` runs MAIN code and must
not be touched. Start a second server from the worktree on `:5174` with `cp MAIN/.env .env && cp .env
apps/web/.env`, appending `KNOWLEDGE_GRAPH_MCP_PORT=9187`, `LIVE_MEMORY_ENABLED=false`,
`AGENT_MEMORY_ENABLED=false`. Track the PID, kill it, `rm .env apps/web/.env && rm -rf
apps/web/.data`, and prove `lsof -nP -iTCP:5174 -sTCP:LISTEN` is empty.

---

## Files to modify

| File | Change | Ticket |
|---|---|---|
| `packages/mcp-server-couchbase/src/tools/getClusterHealth.ts` | Convert `latency_us` → `latencyMs`; name the unit in the tool description | SIO-1264 |
| `packages/mcp-server-couchbase/tests/tools.test.ts` | Pin 264000 us → 264 ms | SIO-1264 |
| `packages/mcp-server-elastic/src/tools/search/multi_search.ts` | Real `searches` schema + `.describe()` with example; failure header in `content` | SIO-1265 |
| `packages/agent/src/aggregator.ts` | Split contradicted vs unverifiable; window-scope the contradiction check | SIO-1266 |
| `packages/agent/src/absence-judge.ts` | Pass the turn's tool errors to the judge | SIO-1266 |
| `agents/incident-analyzer/agents/gitlab-agent/skills/project-resolution/SKILL.md` | "A term that returned empty is exhausted" | SIO-1267 |
| `packages/agent/src/sub-agent.ts` (or AWS RULES.md) | Early-exit on a clean full ECS enumeration | SIO-1268 |

---

## Workflow

Branch off `main` (`b0774c3f`) — never push to `main` for code. One PR per ticket; SIO-1264 and
SIO-1265 are independent and can go in parallel. SIO-1266 lands **after** SIO-1265.

Linear transitions: Backlog → In Progress on start, → In Review on PR open, → **Done only with
explicit user approval**. All five are already in the DevOps Incident Analyzer project.

PRs are **ready for review, never draft**. Wait for CodeRabbit's SHA-scoped review of the latest
commit before merging (see CLAUDE.md "CodeRabbit Review Lifecycle" — the completion check is
commit-SHA-scoped, and an empty result does not automatically mean pending).

```bash
git commit -m "$(cat <<'EOF'
SIO-1264: report Couchbase ping latency in milliseconds, not raw microseconds

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Open PR — SIO-1261 / #505 (unfinished, blocking)

[PR #505](https://github.com/zx8086/devops-incident-analyzer/pull/505), branch
`claude/sio-1261-probe-gitlab-scope`, state **OPEN / CHANGES_REQUESTED**. It group-scopes the gitlab
probe and stops it adopting an unmatched project. Two CodeRabbit findings are outstanding:

1. **Major** — the `GITLAB_RESOLUTION_GROUP` override does not propagate.
   `agents/incident-analyzer/agents/gitlab-agent/skills/project-resolution/SKILL.md` STEP 1 still
   hard-codes `group_id: "pvhcorp"`, so an `other-corp` override fails on the very fallback path the
   PR relies on.
2. **Minor** — `docs/architecture/resolve-identifiers.md:145-150` still documents selection as
   falling back to the first row, which the PR removed.

The relevant code is in [packages/agent/src/resolve-identifiers.ts](packages/agent/src/resolve-identifiers.ts):

```ts
export function getGitlabResolutionGroup(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.GITLAB_RESOLUTION_GROUP?.trim();
	return raw && raw !== "" ? raw : "pvhcorp";
}
// group-scoped invoke; and NO `?? rows[0]` fallback:
const match = rows.find((r) => matchesFocus(r.pathWithNamespace ?? r.name ?? "", focusServices));
if (!match) return {};
```

Note this overlaps SIO-1267 — both touch `project-resolution/SKILL.md`. **Land #505 first** to avoid
a conflict.

---

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Changing the Couchbase ping payload shape breaks a downstream extractor or KG writer | Medium | Add `latencyMs` **alongside** `latency_us`; do not remove or rename the SDK field. Grep for `latency_us` across `packages/` before committing. |
| A stricter `searches` schema rejects a caller that depends on the raw alternating form | Medium | Grep for `elasticsearch_multi_search` / `multiSearch` callers first. If nothing depends on it, do not add a compatibility union — the union re-opens the footgun. |
| Splitting the absence cap changes which runs cross the HITL gate | **High** | 0.59 is the HARD cap (`reference_confidence_two_class_policy_sio1194_1195`). State the intended cap for the new "unverifiable" guard explicitly in the PR body; extend `confidence-policy.test.ts` rather than editing existing assertions. |
| SIO-1267's SKILL.md edit adds a backticked tool name and breaks the budget canary | Low | Headroom is exactly 1 slot (16 of 17). Run the canary; phrase the new rule without backticked tool names. |
| SIO-1268's early-exit suppresses a genuine finding in a partially-enumerated estate | Medium | Gate the exit on a **complete** enumeration of all clusters, not a partial one; log the decision so a replay can audit it. |
| PR #505 and SIO-1267 conflict in `project-resolution/SKILL.md` | **High** | Land #505 first. |

---

## Out of scope

- Re-litigating the SIO-1241 framing. That is settled: the cause was config, not the five defects.
  `experiments/HANDOFF-2026-07-27-sio1241-config-regression.md` is the record.
- The run's **analysis quality**. Setting aside the two bad inputs, the reasoning was sound — it
  refused to over-claim, listed its gaps, and correctly rejected a wrong-looking GitLab project.
- Raising `MAX_TOOLS_PER_AGENT` from 25, and cumulative-with-decay for the loop guard. Both flagged
  in the previous wave, neither built.
- `konnect` MCP being down — intentional (`reference_konnect_mcp_intentionally_disabled`).
- Operational follow-ups that belong to the user, not a coding session: restarting the agent (nothing
  auto-deploys), watching the ~3× LLM invoice from the Sonnet restore, and running more real incidents.

---

## Related code references (already correct — use as patterns)

- [packages/agent/src/llm.ts](packages/agent/src/llm.ts) — `LIGHT_TIER_MODEL` and `isLightweightRole`.
  This is why `absenceJudge` runs on Haiku while specialists run Sonnet. Do not re-couple them.
- [packages/agent/src/sub-agent-truncation-synthesis.ts](packages/agent/src/sub-agent-truncation-synthesis.ts)
  — SIO-1260's synthesis backstop. `synthesizeTruncatedFindings` **never throws**; that guarantee is
  load-bearing and pinned by test.
- [packages/gitagent-bridge/src/skill-loader.ts:148](packages/gitagent-bridge/src/skill-loader.ts:148)
  — `SUB_AGENT_NON_INTERACTIVE_PREAMBLE`, with the comment explaining why the gate is at the call
  site rather than a `LoadedAgent` flag.
- [packages/agent/src/sub-agent-loop-guard.ts](packages/agent/src/sub-agent-loop-guard.ts) —
  `isUnproductiveResult`'s string branch (SIO-1259) and `GENERIC_GUARD_EXEMPT_TOOLS`. SIO-1267 is
  about the *duplicate-signature* path, which is separate.
- [packages/agent/src/aggregator.ts:1010-1014](packages/agent/src/aggregator.ts:1010) —
  `appendSuffixToLine` and the SIO-1158 table-row rule. Any new caveat text must respect it.

---

## Memory references

`reference_sio1241_live_replay_defect_wave` (the corrected three-config-change account),
`reference_confidence_two_class_policy_sio1194_1195` (0.59 is the HARD cap),
`reference_absence_judge_premature_absence_veto`, `reference_grounded_gaps_confidence_cap`,
`reference_couchbase_query_response_shapes`, `reference_sio1085_query_examples_and_malformed_syntax`
(Haiku-era lesson: literal copy-paste examples beat prose — still true for tool `.describe()`),
`reference_gitlab_search_first_and_elastic_loop_guard`, `reference_subagent_tool_budget_calibration`,
`reference_worktree_web_server_replay_env`, `feedback_always_kill_own_background_processes_safely`,
`reference_pr_merge_no_branch_protection_and_worktree_gh_quirk`,
`feedback_validate_every_claim_against_source`.
