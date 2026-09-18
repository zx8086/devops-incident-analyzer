# HANDOFF: session close, 2026-09-17 evening -- spoke ctx tools, AgentCore AWS deploy, and what is still open

| | |
|---|---|
| Date | 2026-09-17 (session ran about 15:45 to 17:45 UTC) |
| Tickets | [SIO-1786](https://linear.app/siobytes/issue/SIO-1786) Done (its user-side replay has since been run, see the update), [SIO-1787](https://linear.app/siobytes/issue/SIO-1787) Done (closed by the user 2026-09-17, was In Review when this was written), [SIO-1788](https://linear.app/siobytes/issue/SIO-1788) Done |
| Related | [SIO-1726](https://linear.app/siobytes/issue/SIO-1726), [SIO-1734](https://linear.app/siobytes/issue/SIO-1734) (spoke context-mode, shipped earlier), [SIO-1774](https://linear.app/siobytes/issue/SIO-1774) (the change the AgentCore deploy shipped), [SIO-1784](https://linear.app/siobytes/issue/SIO-1784) (separate, own handover: `experiments/HANDOFF-2026-09-17-SIO-1784.md`) |
| PRs | #819 merged as `798e9b29`, #820 merged as `61b43f87`; follow-up session #821 to #824; second update #826 merged as `cf5ba637`, #825 closed unmerged; third update #827 merged as `09781ab9`, #828 merged as `95433027` |
| Repo state | `origin/main` at `61b43f87` when written; `7a77c575` after the follow-up session (PRs #821, #822, #823, #824); `cf5ba637` after the second update (PR #826); `95433027` after the third update (PRs #827, #828). No branch is open. |
| Deployed state | Fleet bundle `61b43f87` on all 8 spokes and both hubs. AWS AgentCore runtime on v16. The SIO-1792 change is to the operator-side fleet CLI and needs no deploy; the SIO-1793 change is tests only. |
| Nature | Nothing here is in progress. Every item under "What is still open" is now closed or ticketed; see the third update for the final state. |

## TL;DR

Three things shipped and were verified live: the AWS MCP AgentCore runtime went v15 to v16 carrying
SIO-1774's `describe_alarms` slimming (78618 to 36186 bytes, toolCount still 70); the fleet was found
already current, then re-rolled for SIO-1788; and SIO-1788 itself, which hides four context-mode
maintenance tools from the spokes and fixes the spoke persona's self-description. What is left is
five loose ends, listed under "What is still open". Both of the two that mattered most have since
closed: the SIO-1786 replay was run and passed (first update), and the 24 `packages/agent` failures
were the command, bare `bun test` without `--isolate`, not the code (first update; a second session
then re-derived it the hard way and fixed the CLAUDE.md instruction that caused it, second update).
SIO-1792 and SIO-1793 are also Done (third update). What remains is the untriaged observations
listed in the first update, none of which has a ticket.

## Session summary

The session opened as a review request: read the SIO-1786 handover, and review putting an MCP server
on the fleet spokes so they can use context-mode. The review's headline was that this was ALREADY
built, merged and live (SIO-1726, SIO-1734, SIO-1735): each spoke runs `context-mode` as a local MCP
server and `pi-mcp-adapter` connects it to Pi through one `~/.pi/agent/mcp.json` entry. The user then
redirected the session to closing out the day's deployments, and later asked for the review's one
real finding to be implemented.

| Order | What | Outcome |
|---|---|---|
| 1 | Fleet close-out (SIO-1787) | Both hub buckets already held `12a7be86`; the only differences from main were a test file and an incident-analyzer tool YAML, neither of which runs on a host. Publish deliberately SKIPPED. All 8 spokes and both hubs verified over SSM. |
| 2 | AgentCore AWS deploy (SIO-1786 step 3) | Image built from main, pushed with tag `sio-1774`, runtime updated changing only `containerUri`. Verified by behaviour through the SigV4 proxy. |
| 3 | Runbook entry (SIO-1786 step 4, PR #819) | Three Greptile rounds, every finding verified against code or the live runtime before applying, 5/5 on the third. |
| 4 | SIO-1788 (PR #820) | Implemented, canaried on a dev spoke BEFORE merge, merged at Greptile 5/5 with no findings, rolled out host by host over SSM to dev then prd. |

**Decisions the user made, which bind future work:**

- The prd fleet rollout was pre-approved on condition that dev verifies clean. The AgentCore runtime
  update was NOT pre-approved and got its own explicit go-ahead. Approval for one production step is
  not approval for the next.
- Rollouts go HOST BY HOST OVER SSM when an operator tunnel may be open, not through
  `just fleet rollout/status`. The recipe is in memory `reference_fleet_rollout_host_by_host_over_ssm`.
- Do not publish a functionally empty bundle: it relaunches Pi on every host for nothing.

**What live verification found that review and tests had not:**

- A verification that still shows OLD behaviour after an AgentCore update is most likely testing the
  old image. The SigV4 proxy keeps one process-wide MCP session and AgentCore pins a session to the
  microVM it started on. `DELETE /mcp` on the proxy resets it. Three verification calls looked like a
  failed deploy for this reason.
- Runtime READY is not "new version live": the DEFAULT endpoint switched 46 s after the runtime
  reported READY. Found only because a Greptile finding was checked against the live runtime.
- Log streams can disprove the new image, never prove it: the runtime boots a microVM about once a
  minute on whatever version is live.
- A spoke really did expose all eleven `ctx_*` tools. That had only been inferred from the config
  until the canary's control run listed them.

All three AgentCore lessons are in `docs/runbooks/mcp-agentcore-image-deployment.md` (step 5, step 6
and the 2026-09-17 entry) and in memory `reference_agentcore_proxy_sticky_session_tests_old_image`.

## Update, 2026-09-17 late evening (follow-up session): what changed since this was written

Read this first. It supersedes the matching parts of "What is still open" below, which are kept as
written so the reasoning stays visible.

| Item below | Status now |
|---|---|
| 1. SIO-1786 replay | DONE. Every checklist item passed; scorecard posted on [SIO-1786](https://linear.app/siobytes/issue/SIO-1786). Two things remain unproven, see below. |
| 2. Twenty-four local-only failures | EXPLAINED, not a defect. Wrong command. See below. |
| 3. `ajv` CI flake | Unchanged. Did not recur on the two CI runs of PR #821. |
| 4. `just fleet status` hang | Ticketed as [SIO-1792](https://linear.app/siobytes/issue/SIO-1792) (Backlog). Cause of the original hang still not reproduced. |
| 5. SIO-1788 acceptance gaps | The offline half is ticketed as [SIO-1793](https://linear.app/siobytes/issue/SIO-1793) (Backlog). The live hub message per environment is still the user's. |

**The replay (item 1).** Web app restarted, full replay on all six datasources with estates
`eu-oit-prd` + `eu-shared-services-prd`. Truncation logged `indexedRows: 400`, no
`evidence_index.unavailable`, `cacheReadTokens` grew turn over turn on every sub-agent, and the
SIO-1774 slimming showed in a real run (`capella_get_completed_requests` 37 KB against 745 KB,
`aws_cloudwatch_describe_alarms` 18 KB and 26 KB against 78 KB and 118 KB). `pi verification cards
proposed` was 2: one estate logged `blockedBy: matched` (the service runs there, that card is
correct, it was approved and came back `confirmed`), the other logged
`services-incomplete:<one cluster>`, which is exactly the [SIO-1784](https://linear.app/siobytes/issue/SIO-1784)
case and is recorded there as its second live data point. Approve opened a `verify` entry in the
fleet pane and the verdict arrived.

Still unproven after the replay, noted and not chased: `subagent.final_turn_forced` (SIO-1779) did
not fire, which is expected, because `shouldForceFinalTurn` in `packages/agent/src/sub-agent.ts`
needs three consecutive rounds in which EVERY tool result is a refusal.

The other item that was open here, the key-decision write after a pi verdict
(`recordVerdictDecision` in `packages/agent/src/pi-verdict-memory.ts`), is now PROVEN. On a second
live run the same evening a verify card was approved, and in the same second the hub reported the
message `complete`, the log carried `Recorded key decision` with `requestId` equal to the pi message
id rather than an incident request id, `backend: agent-memory`. That `requestId` is the signature
of this write. Recorded on SIO-1786.

**The 24 failures (item 2) were the command, not the worktree and not the code.** Reproduced in a
fresh worktree with `bun install --frozen-lockfile`, on code identical to main:

```
cd packages/agent && bun test             4616 pass, 69 skip, 24 fail   (the numbers in item 2, exactly)
cd packages/agent && bun test --isolate   4709 pass, 0 fail
```

The package script is `bun test --isolate` (`packages/agent/package.json`), and CI runs that script.
The eight failing suites all live in `packages/agent/src/iac/*.test.ts` and share a process-global
`mock.module("../memory-backend.ts")`, last registration wins; without `--isolate` it leaks across
files. The "about 50 fewer tests" were the 69 skips, not uncollected files: 4616 + 69 + 24 = 4709.
This is already in memory as `reference_bun_test_isolate_kills_mock_module_pollution`. Rule: run a
package's tests with `bun run test` (or its exact script), never bare `bun test`. A fresh worktree
also needs `bunx svelte-kit sync` before `apps/web` tests, or `$lib` does not resolve; the web
package script does that too.

**New from the replay:**

- [SIO-1789](https://linear.app/siobytes/issue/SIO-1789), merged as PR #821 (`37bf49d2`): the fleet
  pane now renders a pi verdict or investigation (chip, summary, claims with evidence), and the
  verify / investigate cards only send and show a one-line status. With no pane configured the card
  still renders the result itself. EXERCISED LIVE against the prd hub the same evening: a
  `partially confirmed` verdict rendered in the pane and the card collapsed to its status line.
- [SIO-1794](https://linear.app/siobytes/issue/SIO-1794), merged as PR #823 (`4426ae7d`), two
  follow-ups from that live use. Pane entries now run oldest first (`startEntry` in
  `apps/web/src/lib/stores/pi-fleet-reducer.ts` appends; it used to prepend, so the investigate card
  a verify raised landed ABOVE the finished verify), and `PiFleetPane.svelte` scrolls the newest
  entry into view when the entry count grows, and only then. The collapsed "Raw reply" block under a
  rendered result is removed; an object reply that is neither a verdict nor an investigation still
  renders as raw JSON. The scroll is browser-only and has no unit test: not yet looked at live.
- [SIO-1790](https://linear.app/siobytes/issue/SIO-1790), merged as PR #822 (`a8ec01cc`):
  `AWSFindingsCard` logged `rawCount: 0` on every run although `aws_cloudwatch_describe_alarms`
  returned alarms in both estates. Root cause, reproduced live: the tool declares an `outputSchema`,
  so `@langchain/mcp-adapters` returns content `{ type, text, structuredContent }` and files the
  structured copy as an artifact; `wrapAwsToolsWithEstate`
  (`packages/agent/src/aws-tool-estate-wrapper.ts`) re-creates each AWS tool with `createTool` and
  calls the inner tool with plain args, which DROPS the artifact; the wrapper object was then
  persisted as `rawJson`, and `DescribeAlarmsResponseSchema` (all keys optional) accepted it and
  read no `MetricAlarms`. SIO-1774 had unwrapped that shape for the model-facing copy only, and its
  test supplied an artifact an AWS tool never has. Fix: the capture in
  `packages/agent/src/sub-agent-instrumentation.ts` reuses `dropDuplicateStructuredContent`. Live
  before and after: persisted keys `type,text,structuredContent` and 0 alarms, then
  `CompositeAlarms,MetricAlarms,$metadata` and 26 alarms. Not yet seen in a full run: the next one
  that calls the tool should log `rawCount` above 0. Only this tool was affected (the two kafka and
  one atlassian tools with an `outputSchema` are raw adapter tools and keep their artifact), but any
  AWS or elastic tool that gains an `outputSchema` is covered too. Seen in passing and NOT
  investigated: with focus `pvh-services-styles-v3`, 25 of 26 alarms counted as in focus although no
  alarm exists for that service, so `matchesFocus` may be matching on shared name fragments.
- [SIO-1791](https://linear.app/siobytes/issue/SIO-1791), merged as PR #824 (`7a77c575`):
  `subagent.loop_guard_stop` logged `unproductiveSearches: 0` next to `reason: unproductive-streak`
  for `gitlab_search` on both live runs. The REASON was right both times (three empty results in a
  row, per-tool cap 3); the line was not. `unproductiveSearches` is a counter only the
  `elasticsearch_search` path increments, so it reads 0 for every other tool. The line now also logs
  `unproductiveForTool` and `totalUnproductive`, and the run-wide cap (`MAX_UNPRODUCTIVE_PER_RUN`),
  which used to be reported as a streak although it can stop a tool that never came back empty
  itself, is `reason: run-backstop`. `stopReasonFor` in `packages/agent/src/sub-agent-loop-guard.ts`
  takes an optional tool name and follows `shouldShortCircuit`'s order, per-tool cap first.
  Deliberately unchanged: the text the model reads. The reason also selects the stop message and
  `gitlab-agent`'s project-resolution skill keys on that wording; `stopMessageFor` only
  special-cases `duplicate-call`, so the new value selects no new message (pinned by a test). The
  split is generic-path only, so `elasticsearch_search` and `aws_logs_start_query`, which have their
  own caps, are never labelled from the generic counters. Left alone on purpose: on a run-wide stop
  the model still reads that the tool "has returned nothing useful several times in a row", which
  may not be true of that tool; changing it is a model-behaviour change and a separate decision.
  Not yet seen in a run: whether the running web app picked the agent package change up by hot
  reload, or needs a restart, was not checked.
- Checked and NOT bugs: the Couchbase and Elastic findings cards at `rawCount: 0` (their source
  tools were not called, or did not match), one AWS sub-agent turn at 165k input tokens (two results
  just under the 131072-byte cap set by `SUBAGENT_TOOL_RESULT_CAP_BYTES`; the cap bounds a result,
  not a conversation), and the `AWS estate config drift` warning (the local `AWS_ESTATES` lists an
  estate the AgentCore runtime does not carry; routing already filters it out).

**For item 4, what the code verifiably allows** (detail in SIO-1792): both defects named below are
confirmed, and there is a real forever-blocker next to them. The `/health` fetch in `withHubTunnel`
and the `listAgents` fetch in `packages/pi-coms/scripts/fleet/hub.ts` have no `AbortSignal`, so one
connect that neither resolves nor rejects hangs the command. `runShellOutput` is correctly bounded.
`withHubTunnel`, `runStatus` and `runRollout` have no test coverage.

**For item 5** (detail in SIO-1793): the `else` branch that removes `mcp.json` has no test, and the
one existing test injects its own `CTX_SERVER` and asserts that same string, so a wrong path on the
script's `CTX_SERVER=` line would still pass. An operator sends a hub message with
`just hub-tunnel <env>`, then `just coms <hub> <cname>`, then `coms_net_send` from that console;
there is no `fleet` subcommand for it.

**Seen on the second live run, not ticketed and not investigated:** while a verify waits, every
25-second poll slice logs `pi.hub.call.failed` for `POST /v1/agents/<id>/heartbeat` with
`404 agent_not_found`, a different agent id each time (10 warnings for one verify), next to a
`pi.hub.await.exhausted` warning per slice. The analyzer registers, sends, and deregisters at once,
so the heartbeats have nothing to hit. The verdict still arrived, so it looks like warn-level noise
in the same class as SIO-1791. Confirm in `packages/agent/src/action-tools/pi-coms-client.ts` before
ticketing.

SIO-1787 is Done: the user closed it on 2026-09-17. Its one follow-up, `fleet status` / `rollout`
failing fast instead of hanging, is SIO-1792 and the two tickets are linked.

## Second update, 2026-09-17 21:00 to 21:20 UTC (the original session, resumed): SIO-1795, a wrong investigation and its correction

The session that wrote this document was resumed after the follow-up session above had already
landed on main, and was asked to investigate the 24 failures (item 2). It did not read the update
above or the memory it cites, ran bare `bun test` throughout, and reached the wrong conclusion
before finding the right one. Recorded here because the artefacts of the wrong path exist and a
reader may meet them.

**What it got right:** without `--isolate`, `mock.module()` is process-global, nothing undoes it
between test files, and Bun chooses the file order from the filesystem (on bun 1.4.2 a JUnit report
showed it ignoring the order of paths given on the command line). Real leaked stubs were found by
pairwise bisection: `iac/renovate-integration.test.ts` (one describe with no restore, a
`memory-backend` stub whose search returns nothing), `iac/local-tools.test.ts` (a
`@devops-agent/knowledge-graph` stub, only `memory-backend` restored), and three files that replace
the whole `@devops-agent/shared` package with `redactPiiContent` as the identity function
(`aggregator.test.ts`, `aggregator-grounding-integration.test.ts`,
`tests/integration/styles-v3-replay.test.ts`). Fourteen files stub `prompt-context.ts` partially
with no restore. None of this matters under `--isolate`, which is what the package script and CI run.

**What it got wrong:** "CI is green only because its file order happens to avoid the damage" and
"CI is one directory-order change away from red". Both rested on bare `bun test`, including a
Linux-container cross-check that was also bare. On a pristine copy of main, `bun test --isolate`
was `4714 pass, 0 fail`.

**Artefacts and their state:**

- [SIO-1795](https://linear.app/siobytes/issue/SIO-1795): created with the wrong analysis, then
  retitled and given a correction banner at the top; the wrong text is kept underneath, marked as
  wrong. Done, via PR #826.
- PR #826 (`cf5ba637`, merged): one paragraph of `CLAUDE.md`. It used to say `cd packages/<name>
  && bun test` and that this is how `apps/web` "must be run". It now says `bun run test`, and why:
  `packages/agent` and `apps/web` isolate, `apps/web` also runs `svelte-kit sync`, `pi-coms`
  installs its nested deps. Measured on one commit: `packages/agent` bare 24 fail vs script 0;
  `apps/web` bare 17 fail plus 12 errors vs script 0. A path filter keeps the flag (`bun run test
  src/iac`). There is no `bunfig.toml` key for isolation (checked against the Bun docs, and
  `[test] isolate = true` was tried and is ignored) and a preload cannot see the flag, so bare
  `bun test` cannot be made safe; the instruction had to change.
- [SIO-1796](https://linear.app/siobytes/issue/SIO-1796) and PR #825 (five test files restoring
  the leaked stubs): the user closed the PR unmerged and cancelled the ticket on the advice above.
  The patch was correct and harmless, but it fixed a problem the script already avoids, and would
  not have made bare `bun test` reliable anyway (the fourteen `prompt-context.ts` stubbers).
- Memory: the duplicate memory the session wrote was deleted; the lesson was folded into the
  existing `reference_bun_test_isolate_kills_mock_module_pollution`, whose stale line ("packages/agent
  does NOT isolate") is corrected, and that memory is now linked from `MEMORY.md` directly.

**The lesson, for the next person who sees "passes alone, fails in the suite, green on CI":** compare
your command with the package's `"test"` script and with what CI runs before anything else. The
answer was on main (the update above) and in memory two hours before the investigation started.

## Third update, 2026-09-18 05:00 to 05:50 UTC (the original session, resumed again): SIO-1793 and SIO-1792 done

Both tickets the first update opened for items 4 and 5 are implemented, merged and Done.

**SIO-1793, PR #827 (`09781ab9`), tests only.** `tests/agent-bootstrap-project-scope.test.ts`
now slices the launcher's whole `mcp.json` block (`CTX_SERVER=` through `fi`; the launcher heredoc
is quoted, so `$HOME` expands at run time) and runs it under `bash -euo pipefail` in a `mkdtemp`
HOME with a stand-in bundle file, then inspects the file left behind. Covered: enabled with the
bundle present (valid JSON, `args` equal to the script's OWN `CTX_SERVER` path, the four
maintenance tools excluded, the documented ones not); `CTX_MODE_ENABLED=false` and `=0` remove a
pre-existing file; enabled but bundle missing removes it; an unrelated value counts as enabled.
Mutation-checked against the real script: a wrong `CTX_SERVER` path fails 2 tests (the old test
passed it), swapping one excluded tool for a documented one fails 1. Greptile 5/5, no findings.

**SIO-1792, PR #828 (`95433027`).** The other session had left substantive uncommitted work in
worktree `sio-1792-fleet-tunnel`; with the user's go-ahead it was reviewed, tested and committed
as found on that session's branch, then finished from this worktree (the harness refuses writes to
another worktree, so the clean, pushed worktree was removed and its branch checked out here). The
tunnel now lives in `packages/pi-coms/scripts/fleet/tunnel.ts` with injectable deps: every
`/health` attempt carries `AbortSignal.timeout`; after the attempts it throws
`tunnel to <hub> did not answer /health`; a tunnel process that exits early fails fast and names
the likely cause; the process is spawned `detached` in its own group and teardown signals the
GROUP (SIGTERM, then SIGKILL, bounded waits), with SIGINT/SIGTERM handlers because `finally` does
not run when the CLI is signalled; a hub already answering on the hub's `local_port` (the
operator's own `just hub-tunnel`) is reused and left alone. `listAgents` in `scripts/fleet/hub.ts`
has a 15 s timeout, and `HubHttpError` marks an answer retrying will not change (HTTP refusal, or a
2xx whose body is not JSON), which the rollout poll fails fast on while retrying transport stalls.

Greptile round 1 was 4/5 with two findings, both verified and fixed: the reuse probe accepted any
2xx on `/health` (an unrelated local service would have been taken for a hub; it now requires the
hub's real payload, `ok === true` plus `server_id`, per `handleHealth` in
`scripts/coms-net-server.ts`), and an unparseable listing was retried to the ten-minute deadline.
Round 2: 5/5. 14 tunnel tests, one with real processes proving the spawned command's child dies
on teardown (which also proves Bun 1.4.2 honours `detached: true`); pi-coms 578 pass.

**Live acceptance, credentials refreshed by the user:** `just fleet status` on the two dev spokes,
rc 0 in 12 s, nothing left on 8787; on the two prd spokes WITH the operator's prd tunnel already
open on 8788, which is the exact scenario that hung during SIO-1787: rc 0 in 10 s, logged
`using the tunnel already open`, the operator's tunnel survived. Before that, with expired
credentials, the real `aws` CLI failed in 2 s with the clear message and nothing was left
listening. The original 5-minute hang was never reproduced; the code path it took is gone.

**Now the only open things from this document**, none ticketed: the heartbeat `404
agent_not_found` warnings during a pi verify (first update, "Seen on the second live run"), the
possible `matchesFocus` false positives on shared name fragments (first update, SIO-1790 bullet),
the `ajv` CI flake seen once, the `PiFleetPane` scroll not yet looked at live, and the live hub
message to one spoke per environment (still user-driven, per SIO-1793's scope).

## What is still open

### 1. SIO-1786: the user-side verification (no code) [DONE, see the update above]

Linear moved SIO-1786 to Done automatically when PR #819 merged. One item from its handover
(`experiments/HANDOFF-2026-09-17-SIO-1786.md`, last paragraph of Verification) was never done,
because it needs the user's own process:

1. Restart the web app on 5173 so it runs the day's agent changes. It is the user's process: ask,
   never kill it.
2. One full incident replay, watching: `tool_result_truncated` lines with `indexedRows` above zero,
   no `evidence_index.unavailable`, `cacheReadTokens` growing turn over turn, `pi verification cards
   proposed` (count 1 when the model completes the ECS enumeration; SIO-1784 explains why it can be
   2), and Approve opening a `verify` entry in the fleet pane.

Two things from the earlier 2026-09-17 session are still unconfirmed live and have no ticket:
`subagent.final_turn_forced` (SIO-1779) never fired in a replay, and the key-decision memory write
after a pi verdict was never checked because the replay ran with memory off. Note them if the replay
shows either; do not chase them.

### 2. Twenty-four local-only failures in `packages/agent` [EXPLAINED: bare `bun test` without `--isolate`, see the update above]

In this session's worktree, `cd packages/agent && bun test` gives `4616 pass, 24 fail`, identically
sandboxed and unsandboxed, on a branch that differed from main by one markdown file. CI on the same
commits runs 4689 tests with 0 failures, so the worktree runs about 50 FEWER tests and fails 24 of
the rest. Every failing suite is in the memory and knowledge-graph recall area:

```
recallPriorRenovateTriggers (SIO-1472)   memoryEnrichIac        runMemorySearch
reviewPlan recall status (SIO-1083)      recordIacOutcome       recordIacEntities
recallPriorFleetUpgrades (SIO-971)       graphEnrichIac
```

First failure text: `expect(received).toBeDefined()`. No `AGENT_MEMORY*`, `LIVE_MEMORY*` or
`KNOWLEDGE_GRAPH*` variable was set in the shell. NOT investigated further. Start by running the same
command in the MAIN checkout: if it passes there, the gap is this worktree's environment (a missing
workspace symlink or native library is the known class, see memory
`reference_pi_coms_workspace_symlink_missing` and `hub_knowledge_graph`), not the code. Do not
"fix" a test on this evidence.

### 3. One CI flake, seen once

On the first CI run of PR #819 the `Test` job failed with `4689 pass, 0 fail, 1 error`: an unhandled
`error: ajv implementation error` thrown from `ajv@8.18.0 dist/compile/errors.js:45` while
`packages/agent/src/correlation/extractors/atlassian.test.ts` was loading. Main passed at the same
base commit, it was the only failed CI run in the last 40, three local runs did not reproduce it,
and the re-run passed with no change. Treated as a flake and NOT ticketed. If it recurs, that is the
signal to look at how that test file builds its ajv validators.

### 4. `just fleet status` hung, cause NOT established [SIO-1792 DONE via PR #828, see the third update]

During SIO-1787, `just fleet status --operator simon` did not return within 5 minutes and left one
orphaned dev tunnel on 8787 (proven mine by parent chain, killed by PID). At the time the prd hub's
local port 8788 was held by the operator's own `just hub-tunnel`. The session first blamed that. The
code does not support it as stated: `withHubTunnel` would see `/health` succeed THROUGH the existing
tunnel and carry on.

`packages/pi-coms/scripts/fleet.ts:239-254`:

```ts
	try {
		const baseUrl = `http://127.0.0.1:${localPort}`;
		for (let i = 0; i < 30; i++) {
			try {
				const r = await fetch(`${baseUrl}/health`);
				if (r.ok) break;
			} catch {
				// tunnel not up yet
			}
			await Bun.sleep(1000);
		}
		return await fn(baseUrl);
	} finally {
		tunnel.kill();
		await tunnel.exited;
	}
```

Two things that ARE visible in that code and worth a ticket if anyone picks this up: the health loop
falls through after 30 tries without throwing, so `fn` runs against a tunnel that never came up; and
`tunnel.kill()` signals the `aws` CLI but not its `session-manager-plugin` child, which is the orphan
memory `reference_fleet_cli_orphans_ssm_tunnels` describes. The output was also piped through `tail`,
which buffers until exit, so the run may simply have been slow rather than hung. Reproduce before
concluding anything. No ticket exists.

### 5. SIO-1788: two acceptance items met by a different route than the ticket named [offline half: SIO-1793 DONE via PR #827; the live hub message stays user-driven]

- The ticket said "a hub message". The probes actually ran as a separate Pi print-mode process on
  each host (deployed `mcp.json`, real adapter, the host's own model, persona loaded). That proves
  the deployed configuration; it is not the live hub-driven session. The live sessions are covered
  by process checks only (new pid, ctx server as its child, the same `mcp.json`). A real hub message
  to one spoke per environment would close the gap, and needs an operator token and a tunnel.
- `CTX_MODE_ENABLED=false` removing `mcp.json` was not exercised live. That branch of the launcher
  is untouched by the diff (`packages/pi-coms/deploy/bootstrap/agent-bootstrap.sh`, the `else` of the
  block that writes `mcp.json`).

Also noted, no action needed: the fleet pins `pi-mcp-adapter@2.33.0` and npm latest is 2.34.0. The
pin already supports everything in use. Bump only through the canary procedure (memory
`reference_pi_version_upgrade_procedure`).

SIO-1787 is Done (closed by the user on 2026-09-17; it was In Review with nothing left to do when
this was written).

## Where things stand, precisely

**AgentCore AWS runtime.** Runtime id and the ECR repository are in the runbook's quick reference.
Live digest `sha256:390b78bce8bd5493c2e2d2dc86eaf16eeb31832124661f20bbc4515ddaf0bd6c`, rollback
`sha256:3e2693033fda93c2d9f5dd6a3ca4c47ddf26f586783a7bf76237eda68aeb0fd0`. Rollback is editing
`containerUri` back and re-running step 5 of the runbook. Kafka was not redeployed.

**Fleet.** Both hub buckets `fleet/version` = `61b43f87`; the previous value, and the rollback
target, is `12a7be86`. Rollback is republishing that SHA and running `pi-coms-update` per host.

**The SIO-1788 change itself**, `packages/pi-coms/deploy/bootstrap/agent-bootstrap.sh`, the launcher
block that writes `mcp.json`:

```bash
  printf '%s\n' "{\"mcpServers\":{\"ctx\":{\"command\":\"$HOME/.bun/bin/bun\",\"args\":[\"$CTX_SERVER\"],\"lifecycle\":\"keep-alive\",\"directTools\":true,\"toolPrefix\":\"none\",\"excludeTools\":[\"ctx_upgrade\",\"ctx_purge\",\"ctx_doctor\",\"ctx_insight\"]}}}" \
    > "$HOME/.pi/agent/mcp.json"
```

That line is a hand-escaped JSON string. `packages/pi-coms/tests/agent-bootstrap-project-scope.test.ts`
(the `agent-bootstrap.sh mcp.json entry` block) runs it through bash and parses the result, because a
quoting slip there leaves a spoke with no ctx tools at all, silently.

## Verification (state checks, all read-only)

```bash
bun run typecheck && bun run lint && bun run test     # only if any code changes; `bun test` at the repo root can crash the runner, run per package

# Fleet: every spoke on the bundle, excludeTools live, ctx server attached (per host, base64 the script)
cat /home/piagent/pi-coms/.bundle-version                                  # 61b43f87
grep -o '"excludeTools":\[[^]]*\]' /home/piagent/.pi/agent/mcp.json         # the four names
P=$(pgrep -u piagent -f pi-coding-agent/dist/cli.js | head -1); pgrep -P "$P" -f context-mode/server.bundle.mjs

# Spoke tool list without the hub (as piagent, cd ~/pi-coms, source ~/.coms-env first): expect 7 names
bun <pi cli.js> --model <the live Pi's --model> --provider amazon-bedrock --no-session \
  -p 'List every tool available to you whose name starts with ctx_. Names only, one per line.'

# AgentCore: endpoint live version and behaviour
aws bedrock-agentcore-control get-agent-runtime-endpoint --agent-runtime-id <id> --endpoint-name DEFAULT \
  --profile eu-shared-services-prd --region eu-central-1 --query '{live:liveVersion,status:status}'   # live 16
```

Expected for `aws_cloudwatch_describe_alarms` through the proxy: about 36 KB for the ALARM-state
alarms of the prd estate used in the probe, no `AlarmArn` / `AlarmActions` / `StateReasonData`. If it
shows the old 78 KB, reset the proxy session first (runbook step 6) before suspecting the deploy.

## Workflow for whoever picks one of these up

1. Each open item is independent. None has a ticket except SIO-1786's replay, which belongs on that
   ticket as a comment. Create a Linear issue in the DevOps Incident Analyzer project before any code
   change, claim it (assign, In Progress), never set Done.
2. Branch off `main`, `SIO-XXXX: message` commits with a HEREDOC, PR ready for review (never draft),
   Greptile gate: `status == COMPLETED` AND `conclusion == SUCCESS`, footer SHA equal to the PR head,
   zero unresolved threads. Verify every finding before applying it.
3. Note that a merged PR linked to a ticket makes Linear move it to Done on its own.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| The 24 local failures get "fixed" in code | Low now | Explained: bare `bun test` leaks `mock.module` across files. Use the package script (`bun test --isolate`) |
| A future AgentCore deploy is judged failed, or good, off the pinned proxy session | Medium | Runbook step 6: wait for the endpoint's `liveVersion`, check the proxy is idle, `DELETE /mcp`, then verify by behaviour |
| `DELETE /mcp` aborts someone's in-flight analysis | Low | `activeSseConnections: 0` on `/health` is necessary, not sufficient; stop your own probes and confirm nobody else uses the proxy |
| A spoke model wants `ctx_purge` or `ctx_upgrade` and cannot find it | Low | Intended. Operators run those by hand on the host |
| An unbounded wait loop on an SSM command id that was never issued | Seen once this session | Bound every loop and check the command id is 36 characters before polling |
| Sandboxed and unsandboxed `TMPDIR` differ, so a script written in one is empty in the other | Seen once this session | Write helper scripts to a fixed path |

## Out of scope

- SIO-1784 (deterministic ECS enumeration completion): code change with its own handover.
- Redeploying the Kafka AgentCore runtime. It shares `packages/shared`, so its next deploy will carry
  the day's shared changes; that is a separate decision.
- Adding the repo's other MCP servers to the spokes. A spoke is deliberately the AWS CLI plus the
  instance role.
- Upgrading `context-mode`: the pin already equals npm latest (1.0.169).

## Related code references

- `packages/pi-coms/deploy/bootstrap/agent-bootstrap.sh`: the context-mode and adapter installs (the
  `CTX_MODE_ENABLED` block near the top), the launcher's `mcp.json` block, and the `pi-coms-update`
  heredoc near the end (version compare, reload sentinel, user-data re-run).
- `packages/pi-coms/docs/deployment/deployment.md`: boot sequence step 5, the launcher paragraph with
  the `excludeTools` and "not a security boundary" notes, and the per-host probe.
- `packages/pi-coms/docs/deployment/deploying-from-a-worktree.md`: read before any fleet command
  from a worktree. `publish-fleet.sh` takes the bucket and profile as arguments and needs no manifest.
- `agents/pi-fleet/agents/aws-spoke/SOUL.md`, `RULES.md` (section "Sandboxed execution and search"),
  `agent.yaml` (0.5.1).
- `packages/shared/src/agentcore-proxy.ts`: the process-wide `mcpSessionId`, the session signal
  attached to the upstream `fetch` and to `sleepWithAbort`, and the `DELETE` route that resets both.
- `packages/mcp-server-aws/src/tools/cloudwatch/describe-alarms.ts`: `omitAlarmNoise`,
  `includeNotificationConfig`.
- `docs/runbooks/mcp-agentcore-image-deployment.md`: the whole procedure plus this session's lessons.

## Memory references

`reference_agentcore_proxy_sticky_session_tests_old_image`,
`reference_fleet_rollout_host_by_host_over_ssm`, `reference_fleet_cli_orphans_ssm_tunnels`,
`reference_pi_version_upgrade_procedure`, `hub_pi_coms_ops`, `hub_pi_fleet`, `hub_agentcore_and_aws`,
`hub_testing_and_bun`, `hub_knowledge_graph`, `reference_pi_coms_workspace_symlink_missing`,
`reference_worktree_gitignored_deploy_config`, `feedback_validate_before_acting_on_infra`,
`feedback_roll_back_before_diagnosing_a_deploy_break`,
`feedback_never_blame_working_code_for_probe_failures`, `feedback_new_features_default_on`,
`feedback_never_attach_ui_to_prod_spoke_panes`, `reference_linear_pr_link_auto_transitions_to_done`,
`reference_greptile_active_again_2026_09_14`, `feedback_repo_is_public_sanitize_before_commit`,
`feedback_never_use_em_dashes`, `feedback_handoff_docs_main_branch`.
