# HANDOFF 2026-09-16 -- Backlog triage programme (validated work order)

| Field | Value |
| -- | -- |
| Date | 2026-09-16 |
| Type | Programme handover (multi-ticket, deliberately sequenced) |
| Repo state | `claude/open-tickets-review-f8cdbc` @ `63118ed3` (identical to `main`) |
| Scope | Validated open tickets in the **DevOps Incident Analyzer** Linear project |
| Suggested branches | one per ticket, off `main`, named from each ticket's Linear `gitBranchName` |

> **Why one file and not one-per-ticket.** `CLAUDE.md` says one ticket per handover and don't
> bundle unrelated work. This is the exception the rule is not aimed at: the value here is the
> *ordering and the dependencies between tickets* (SIO-1240 must precede SIO-1239; SIO-1119
> should ride with SIO-1109). Split into seven files, the sequencing -- the actual finding -- is
> the thing that gets lost. Per-ticket detail below is complete enough to execute from directly.

---

## TL;DR

A full sweep validated every open ticket in this project against the code. **Six are already
fixed** and should be closed; the fixes landed under *different* ticket numbers, which is why
they looked open. **One more (SIO-1744) is 90% done** -- only its CI drift gate remains, and that
remainder is the single highest-value item in the backlog because it prevents the class of bug
rather than the instance. Two tickets are **worse than filed** (SIO-1109, SIO-1681): in both, the
system misreports its own state. Work order is in §3. Nothing has been implemented yet; two
out-of-scope tickets (SIO-1672, SIO-1642) were cancelled with reasoning comments.

---

## 1. How this was validated (and how far to trust it)

Three `Explore` agents swept the tickets, each required to quote `file:line` and forbidden from
guessing. **Every verdict was then re-read first-hand in the main session** -- because this repo
already contains a cautionary example (see §5).

**Result: 11/11 agent verdicts correct; 3 citation errors; 0 wrong conclusions.**

Calibration for the next session: trust the verdicts, re-check the paths. Specifically observed:

- Agent cited `packages/agent/src/correlation/extract-findings.ts`; real path is
 `packages/agent/src/extract-findings.ts`. Line numbers were right. Note the `correlation/`
 directory **does** exist and holds the extractors -- `correlation/extractors/elastic.ts` is a
 real path -- so only `extract-findings.ts` itself sits one level up, at `src/`. (I initially
 recorded "no `correlation/` directory exists", which was itself wrong; corrected after
 checking. The lesson compounds: verify the correction too.)
- Agent said SIO-1119 was "28 call sites across 7 files"; actual is **22 across 11 files**.
- Agent credited SIO-1744's backfill to PRs #773/#779; the commits in this tree are `3b3ba68e`
 (#776) and `1fb86ee0` (#777), both SIO-1743.

**A probe that disagrees with a finding is suspect before the finding is.** While checking
SIO-1540 I got `password = undefined` and nearly reported it as contradicting the agent. Cause
was my own probe: `loader.ts:145` exports a `config` *object*, not a function, so the
`typeof fn === "function"` branch never fired. Re-run against `const { config }` reproduced the
agent's result exactly. Verify the instrument first.

---

## 2. Close these six (verified fixed, no work required)

Each was fixed under a different ticket number -- which is precisely why a
"does a commit mention this ticket?" search finds nothing and the ticket looks open. That query
returns zero for all 138 open tickets and is not a useful signal.

| Ticket | Fixed by | Evidence |
| -- | -- | -- |
| SIO-1166 | **SIO-1236** (`f1953411`, #483) | `packages/knowledge-graph/src/store.ts:232-248` forces `await db.init()` inside the try, pinning lazy WAL replay inside the recovery scope -- exactly what the ticket asked to verify. Caveat: the requested real-engine integration test never shipped; `store.test.ts:148-295` still uses the mocked `_setLbugLoaderForTesting` seam. |
| SIO-1129 | **SIO-1163** (`63967d87`) → **SIO-1167** (`0b18f25e`) → **SIO-1361** (`a035fa4e`) | graphPath now absolute via `findWebAppRoot()` (`store.ts:88-106`). The proposed unclean-exit WAL guard was superseded by reactive quarantine (`store.ts:255-295`) plus `CHECKPOINT_THRESHOLD_BYTES` (`store.ts:150`) -- strictly better, since the proposed heuristic would quarantine healthy WALs after any hard kill. |
| SIO-1275 | -- | String "tools not bound" no longer exists. `sub-agent.ts:1200-1206` branches on the unconfigured case: "No tools are bound to you this turn -- this data source is unavailable." Fault framing is reserved for the populated-list branch at `:1213`. |
| SIO-1680 | -- | `packages/pi-coms/scripts/monitor/checks/cost.ts:7-9` -- `COST_DEFAULTS = { pct: 0, abs: 100 }`, with SIO-1680 named in the comment; `:45-47` short-circuits the pct gate so `abs` alone decides. |
| SIO-1540 | -- | Verified empirically. From `packages/mcp-server-couchbase`, `env -i ... bun -e 'const {config} = await import("./src/config/loader.ts")'` → `LOADED OK, no throw / password = "password"`. Defaults at `src/config/defaults.ts:22-29`, fallback at `loader.ts:59-60`. |
| SIO-1403 | **SIO-647** (`fa521731`, 2026-04-14) | See §5 -- this one has a trap. |

---

## 3. Work order

Ranked by whether the code is wrong *today*, not by effort. The first three outrank everything
else: each is a case where the system **misreports its own state**, which is worse than being
broken, because it is broken confidently.

### 3.1 -- CI fleet render-drift gate *(new ticket; the remainder of SIO-1744)*

**Status:** SIO-1744's main ask is DONE -- all **8/8** committed roots carry `monitor_tz` and
`monitor_daily_cron`, backfilled by SIO-1743. (The ticket says 9 hosts; `eu-b2bonboarding-prd`
was deleted in `1fb86ee0`, not missed.) Close SIO-1744 and open this as its own ticket.

**The gap:** nothing fails CI when a committed Terraform root drifts from `fleet.yaml`.
`.github/workflows/ci.yml:102` has only `bash -n deploy/publish-fleet.sh`. That is exactly how
SIO-1737's monitor schedule sat unrendered on six hosts for a month.

**The fix:** a CI step that runs the renderer against a committed fixture and fails on any diff.

```yaml
      - name: Fleet roots match the manifest
        run: |
          bun run scripts/fleet/render.ts --manifest deploy/fleet.example.yaml
          git diff --exit-code -- packages/pi-coms/deploy/accounts/
```

**Care required -- `deploy/fleet.yaml` is gitignored** (`packages/pi-coms/.gitignore:19`) and is
absent from worktrees; it exists only in the main checkout. So the gate must render from
`fleet.example.yaml`, and that fixture must be kept representative or the check is theatre.
Confirm the example manifest produces the same root shape before wiring it up.

Related prior art: `fleet-render.test.ts:16-25` asserts emitted HCL; `fleet-config-drift.test.ts`
covers *host env* drift (SIO-1747). Neither catches committed-root drift.

### 3.2 -- SIO-1109: KV writes bypass read-only mode

**Worse than filed.** The ticket names two v1 files. The gap is in **four** places, and the
tools also *lie about it*.

| Location | State |
| -- | -- |
| `src/tools/upsertDocumentById.ts:17-40` | no gate; grep `readOnly` → zero hits in file |
| `src/tools/deleteDocumentById.ts` | no gate; zero hits |
| `src/v2/tools/core.ts:329-341` (upsert) | no gate |
| `src/v2/tools/core.ts:374-379` (delete) | no gate |
| `src/lib/runSqlPlusPlusQuery.ts:46,58` | gate present and correct |
| `src/v2/tools/core.ts:560` | gate present and correct (SQL++) |

The aggravating detail: `v2/tools/core.ts:48` reads `config.server.readOnlyQueryMode` **to
compute tool annotations**. So in read-only mode the KV write tools advertise themselves as
read-only and still mutate. That is not a missing gate, it is a tool contract that misleads
the caller.

**Fix:** one shared guard all four call sites route through, returning the existing structured
envelope (the SIO-1087 `{ _error: { kind, category } }` shape) so the agent reads it as policy,
not malfunction. Four separate checks is the wrong shape -- the lazy fix is the root-cause fix.

```ts
if (config.server.readOnlyQueryMode) {
	const envelope = buildToolErrorEnvelope({
		kind: "auth-denied",
		message: "Document mutations are not allowed in read-only mode (set READ_ONLY_QUERY_MODE=false to enable)",
	});
	return { content: [{ type: "text", text: JSON.stringify(envelope) }], isError: true };
}
```

**Rollout note:** with the default config this DISABLES KV writes. Check
`capella_sync_documentation_with_database` and the documentation tools for indirect dependence
on the upsert path before landing. The incident-analyzer itself is unaffected -- 
`couchbase-health.yaml` `document_ops` maps only read tools.

**Do SIO-1119 in the same PR** (§3.6): the new tests need envelope assertions anyway, so the
shared helper pays for itself immediately instead of adding a 23rd inline parse.

### 3.3 -- SIO-1681: a 403'ing spoke reports "online"

**Worse than filed.** `AgentStatus` (`packages/pi-coms/contracts/wire.ts:7`) is
`"online" | "stale" | "offline"`, derived purely from heartbeat recency
(`coms-net-server.ts:182,185`). `HeartbeatRequest` (`wire.ts:78-84`) carries
`project`, `context_used_pct`, `queue_depth`, `model?`, `status?` -- no failure counter.

The part the ticket misses: `coms-net-server.ts:1153-1156` accepts a spoke-reported `status`
but **overwrites it with `"online"` on any heartbeat**. A spoke cannot declare itself degraded
even if it detects its own failures. So the fix needs a field the hub will not clobber, not a
new `AgentStatus` value.

**Shape:** add a consecutive-model-failure count to `HeartbeatRequest`, have the hub preserve it,
and add one check under `scripts/monitor/checks/` (21 files there today; none covers this).
Follow the existing consecutive-cycle idiom -- `checks/targets.ts:21` and `checks/ingestion.ts:14`
both require N consecutive bad cycles before alerting.

### 3.4 -- SIO-1644: focus services never validated against any datasource

The only item here that puts a **visibly wrong answer in front of a user**: a wrong
LLM-chosen focus silently drops every row and renders empty cards.

`packages/agent/src/extract-findings.ts:64-73` -- `collectFocusServices` unions LLM services with
`normalizedIncident.affectedServices` and returns. No existence check. The only mode gate is
emptiness, at `:38`: `focusServices.length === 0 ? "show-all" : "scoped"`.

The code already concedes the defect -- `packages/agent/src/normalizer.ts:256-257`:

> a WRONG focus yields droppedAll empty cards, strictly worse than show-all.

Two per-extractor fallbacks exist, both post-hoc and partial:
`packages/agent/src/correlation/extractors/elastic.ts` (SIO-1643, re-runs show-all after focus
drops everything, elastic only -- the fallback's effect is visible at `extract-findings.ts:210`)
and `packages/agent/src/application-topology.ts` (SIO-1460, `if (anchors.size === 0) return;`,
topology map only).

**Fix:** hoist that behaviour into `collectFocusServices` so every extractor inherits it -- when
no datasource knows any focus service, fall back to show-all. A third special case is the wrong
answer; the shared function is where all callers already route through.

### 3.5 -- SIO-1240 then SIO-1239 *(strict order -- do not invert)*

**SIO-1240 first.** `packages/agent/src/sub-agent.ts:974` is a bare, uncommented
`const MAX_TOOLS_PER_AGENT = 25;`. The contrast is stark: `MIN_FILTERED_TOOLS` immediately below
(`:975-980`) carries a six-line rationale with ticket ref and failure mode. No measurement of 25
exists anywhere; three handoffs list raising it as open follow-up.

**Why the order matters.** SIO-1239 is prompt-architecture surgery whose purpose is relieving
pressure created by the 25-tool cap. If 25 turns out to be arbitrary, raising it may dissolve
that pressure entirely -- and the surgery would have been built to work around a number nobody
validated. Document and measure first, then decide whether 1239 is still worth it.

**SIO-1239 itself:** `packages/gitagent-bridge/src/skill-loader.ts:89-91` pushes `agent.rules`
unconditionally, while skills at `:103` and `:112` *are* gated on `activeSkills`. The mechanism
exists; RULES bypasses it. And no agent-side caller passes a filter -- 
`packages/agent/src/prompt-context.ts:188-189` calls `buildSubAgentSystemPrompt(subAgent)` with
none. `grep activeSkills` shows it threaded only *within* `skill-loader.ts` (plus
`iac/skill-selector.ts`, a different path).

Documented harm, `sub-agent.ts:1030-1034`:

> With 70 tools loaded and a 25 cap, the model followed its 32.7KB RULES.md and repeatedly
> called tools that were never bound (aws_ecs_list_clusters, aws_logs_start_query, ...), each
> returning `Tool "X" not found`.

Note `buildBoundToolsBlock` is a *mitigation* (telling the model to skip unbound steps), not the
conditional injection this ticket asks for.

### 3.6 -- SIO-1119: shared envelope parse helper *(ride with §3.2)*

22 inline `JSON.parse(x.content[0].text)` across 11 test files in
`packages/mcp-server-couchbase/tests/` -- `tools.test.ts` 12, `edgeCases.test.ts` 6,
`integration.test.ts` 5, and seven others. `tests/test.utils.ts` has `MockBucket`/`MockCluster`/
`ScopeQueryStub` but no envelope helper.

The concrete cost is drift in the casts, not the duplication itself -- three different inline
shapes for one envelope:

```ts
explainSqlPlusPlusQuery.test.ts:41   as { _error: { kind: string; advice?: string } }
explainSqlPlusPlusQuery.test.ts:105  as { _error: { kind: string; message: string; advice?: string } }
runSqlPlusPlusQuery.test.ts:120      as { _error: { kind: string; category: string; advice?: string } }
```

These are unvalidated casts, so a malformed envelope reads as `undefined` and the assertion fails
with a useless message instead of a parse error. Add a Zod-validated helper to `test.utils.ts`.

### 3.7 -- Decide, don't build

**SIO-1455 -- re-scope or close.** No size-management node in `graph.ts`, but size management
*does* exist out-of-band: `packages/agent/src/kg-retention.ts:14`
(`DEFAULT_RETENTION_DAYS = 30`, overridable via `KG_UNCURATED_RETENTION_DAYS`) →
`purgeUncuratedIncidents`, scheduled by `schedules/kg-purge-sweep.yaml`. Re-scope against that
before anyone builds a redundant node. Five minutes in Linear.

**SIO-1099 -- needs a decision, not work.** The benign not-found half shipped
(`aggregator.ts:586-587` STRONG/WEAK split, `:612-616`, `:668+`). The regex the ticket names is
untouched -- `aggregator.ts:908-910`, still carrying a bare unscoped
`never (?:populated|written|loaded)`. It is *vetoed* at runtime by an LLM judge
(`aggregator.ts:1903-1908`, `absence-judge.ts:47`) that `ABSENCE_JUDGE_ENABLED=false` switches
off, restoring raw behaviour. **Ask: was the ticket about outcomes or the regex?** Outcomes →
close. Regex → narrow the scope to the regex alone.

**SIO-1143 -- confirm intent.** `apps/web/vite.config.ts:9,14` resolve to `../..`, which is fixed
exactly as the ticket words it. But `resolve(__dirname, "../..")` is relative to the config file,
so **in a worktree it resolves to the worktree root** -- and `.env` does not exist there. Verified:
absent in this worktree, present (14657 bytes) in the main checkout. Fixed-as-written,
broken-in-practice. If the intent was "worktrees inherit the main checkout's .env", it needs
`git rev-parse --path-format=absolute --git-common-dir` and is still open. The fix also predates
the ticket (`2e6c8349`), so the ticket may have been filed against stale behaviour.

### 3.8 -- Leave in backlog

**SIO-1469** (mirror background terminal output into Herdr panes) -- zero code hits for `herdr`
in `*.ts`/`*.svelte`; docs only. **SIO-1218** (Couchbase Lite JS feasibility) -- zero hits for
`couchbase-lite|cblite` anywhere. Both speculative, nothing broken, no forcing function.

---

## 4. Already actioned this session

**SIO-1672** and **SIO-1642** were set to **Canceled** (not Done -- the work was not completed,
it was ruled out of scope) with reasoning comments recorded on each.

Two loose ends deliberately left, recorded here so they are not lost:

1. `CLAUDE.md` still carries the large **"Greptile Review Lifecycle (SUSPENDED)"** section,
 written around SIO-1642, documenting the merge gate as unsatisfiable. There is an
 **unverified** report that Greptile resumed on 2026-09-14. It could not be checked from this
 environment -- the local `gh` token is invalid and TLS verification to api.github.com fails.
 If Greptile is active again, that section is stale and should be un-suspended.
2. SIO-1672's description records that `infra-deploy-prd` has **never been played**, so the
 BindPlane licence-expiry Lambda + SNS + CloudWatch alarm have never run -- which is why
 nothing warned before the lapse. That belongs to whichever project owns BindPlane; it is now
 untracked in Linear.

---

## 5. Trap: a doc on `main` asserts something false

`experiments/HANDOFF-2026-09-11-backlog-audit-and-sio1369-1283.md:34` records a six-agent sweep
of 46 tickets. Its table states SIO-1403 was:

> fixed for 6 code-analysis tools only; the proxy surface still splits `id` vs `project_id`

**That is wrong, and the ticket was retitled and kept open on the strength of it.** The proxy
widening predates that audit by five months -- `packages/mcp-server-gitlab/src/tools/proxy/index.ts:87`:

```ts
return z.union([z.string(), z.number().transform(String)]).describe(description);
```

`git log -S 'z.number().transform(String)'` → `fa521731`, SIO-647, **2026-04-14**. Verified
first-hand, not relayed. Code-analysis tools share one union at
`code-analysis/project-id-param.ts:29-33`, and a consistency test already exists at
`project-id-param.test.ts:38-58`.

**One residual before closing SIO-1403:** `proxy/index.ts:92` -- `case "integer"` still returns a
bare `z.number()`, so an upstream *integer*-typed param would reject a string. The proxy surface
is discovered at boot with no committed fixture, so this cannot be ruled out offline. One live
`tools/list` dump settles it.

That audit used the same method as this one and got roughly 1 in 46 wrong. **Assume a comparable
rate here.** Anything in this document that would be expensive to get wrong should be re-read at
the cited line before acting -- the citations are there to make that cheap.

---

## 6. Files by ticket

| Ticket | Files |
| -- | -- |
| CI drift gate | `.github/workflows/ci.yml`, `packages/pi-coms/scripts/fleet/render.ts`, `packages/pi-coms/deploy/fleet.example.yaml` |
| SIO-1109 | `packages/mcp-server-couchbase/src/tools/{upsertDocumentById,deleteDocumentById}.ts`, `src/v2/tools/core.ts`, `tests/tools.test.ts`, `tests/docsWrite.test.ts` |
| SIO-1681 | `packages/pi-coms/contracts/wire.ts`, `scripts/coms-net-server.ts`, new `scripts/monitor/checks/<name>.ts` |
| SIO-1644 | `packages/agent/src/extract-findings.ts` (+ retire the special cases in `packages/agent/src/correlation/extractors/elastic.ts`, `packages/agent/src/application-topology.ts`) |
| SIO-1240 | `packages/agent/src/sub-agent.ts` |
| SIO-1239 | `packages/gitagent-bridge/src/skill-loader.ts`, `packages/agent/src/prompt-context.ts` |
| SIO-1119 | `packages/mcp-server-couchbase/tests/test.utils.ts` + 11 test files |

## 7. Verification

Per repo rules, minimum bar for every ticket above:

```bash
bun run typecheck && bun run lint
```

Tests per package -- `bun test` at the repo root can crash the Bun runner mid-suite:

```bash
cd packages/<name> && bun test
```

Ticket-specific probes:

- **CI drift gate** -- render from the example manifest, confirm `git diff --exit-code` is clean
 on an unmodified tree, then confirm it *fails* after touching one rendered root.
- **SIO-1109** -- `tools/call` upsert against a scratch server in both modes: default
 (`READ_ONLY_QUERY_MODE` unset) must return `isError: true` with the envelope and perform no
 mutation; `READ_ONLY_QUERY_MODE=false` must behave exactly as today.
- **SIO-1644** -- a query naming a service that exists in no datasource must render populated
 show-all cards, not empty scoped ones.
- **SIO-1403** (before closing) -- live `tools/list` dump; confirm no upstream param is declared
 `type: "integer"`.

**A green check-set is not sufficient evidence to merge** (SIO-1291). State what was verified
and how -- the command run, the output read, the live probe performed.

## 8. Workflow

Branch off `main` per ticket. Claim the Linear issue (move to In Progress and assign) **before
the first edit** -- and never invent a ticket ID; the CI drift gate needs a *new* issue created
before work starts, not a guessed number. PRs go up ready for review, never draft. Issues reach
Done only with explicit user approval.

```
SIO-XXXX: <imperative summary>

<what changed and why>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

## 9. Memory references

- `feedback_validate_every_claim_against_source` -- the governing rule for this whole document
- `feedback_never_blame_working_code_for_probe_failures` -- see the SIO-1540 probe in §1
- `feedback_prove_already_solved_by_code_comparison` -- how §2's six closures were established
- `hub_pi_fleet`, `hub_pi_coms_ops` -- fleet/monitor context for §3.1 and §3.3
- `hub_knowledge_graph` -- KG/WAL context for §2 (SIO-1166, SIO-1129) and §3.7 (SIO-1455)
- `feedback_handoff_docs_main_branch` -- this file belongs on `main`
