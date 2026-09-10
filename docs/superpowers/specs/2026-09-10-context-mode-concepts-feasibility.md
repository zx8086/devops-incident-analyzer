# Context-mode concepts feasibility (SIO-1686)

Date: 2026-09-10. Epic: https://linear.app/siobytes/issue/SIO-1686. Children: phase 1 SIO-1687, phase 2 SIO-1688, phase 3 SIO-1689.

Source studied: `/Users/Simon.Owusu@Tommy.com/WebstormProjects/context-mode` at v1.0.169 (`package.json:3`). Target: this monorepo at commit `fe584cdd`.

## 1. Summary and decision

Context-mode keeps large tool output out of the model conversation through six mechanisms: a tiered return ladder, a local FTS5 index over captured output, deterministic session-event capture, a compaction snapshot shaped as a table of contents, sandboxed execution that returns only derived answers, and lifecycle hooks. A side-by-side code comparison (section 3) shows this repo already does better on five of the underlying problems: interception at the tool boundary, truncation fidelity, cumulative loop budget, pre-tool deny, and untrusted fleet text. Context-mode does better on two: recoverability after truncation, and evidence provenance across compaction. Those two rows become the top analyzer opportunities (section 5, items 2 and 3).

Beyond the analyzer, the study found reply-size discipline missing across the spoke persona, the hub, and the console, and four Pi hook seams the spoke extension never subscribes to. Sandboxed execution in the analyzer and a local mirror of Agent Memory are rejected with reasons (section 7).

License: context-mode is Elastic License 2.0 (`LICENSE:1`). This repo is open source and neither sells nor competes with context-mode, so ELv2 permits use. Code may be copied where copying saves effort (the JSON chunker, the snapshot builder), keeping the ELv2 notice and attribution on any copied file. The runtime stays `bun:sqlite`, whose FTS5 with porter unicode61 and trigram tokenizers was verified live on Bun 1.4.2 and SQLite 3.51.0. `better-sqlite3` is not adopted.

Priority confirmed with the user: analyzer sub-agent loop first, memory and hooks second, spokes third.

## 2. What context-mode actually does

Mechanics, with citations into the context-mode repo.

**Return ladder.** `src/server.ts:1979-1980`: `INTENT_SEARCH_THRESHOLD = 5_000` bytes and `LARGE_OUTPUT_THRESHOLD = 102_400`. Under 5 KB the raw stdout returns. Over 5 KB with an `intent`, the output is indexed and the intent runs as a query, returning matching sections. Over 100 KB with no intent, the output is indexed and only a pointer returns: "Indexed N sections from X. Use ctx_search(...)".

**FTS5 store.** `src/store.ts:465-503`: two parallel FTS5 virtual tables over identical content, one `porter unicode61`, one `trigram`, plus a `vocabulary` table for Levenshtein typo correction. Chunks cap at 4096 bytes with 80-character titles (`src/store.ts:153-166`). Ranking is BM25 with title weight 5.0 and content 1.0, fused by reciprocal rank with K = 60 (`src/store.ts:1249-1253`), then a proximity and phrase rerank. Search returns 3 results per query with 1500-character snippets (`src/server.ts:2750`). Content retention is 14 days (`src/server.ts:727-733`); session retention is 7 days.

**Deterministic event capture.** `src/session/extract.ts` (2960 lines) is a regex extractor over every tool call, about 26 categories (errors, files, git, decisions, MCP calls, redirects). No LLM call anywhere in the capture path, which is what keeps the PostToolUse hook under 20 ms.

**Snapshot as table of contents.** `src/session/snapshot.ts:470`: "Assemble ALL non-empty sections, no priority dropping, no byte budget". Each section is a natural summary plus a runnable `ctx_search(queries, source)` call. Built at PreCompact, injected at the next SessionStart. Full data stays in the session database; the snapshot is a table of contents, not truncated inline data.

**Sandbox.** `src/executor.ts:229-233` `PolyglotExecutor`: write code to a temp dir, spawn the runtime, collect stdout with a hard byte cap that kills the process, discard the dir. No seccomp, no container, network on. It is isolation in the "separate process and temp dir" sense only.

**Hooks.** Claude Code: PreToolUse deny or redirect (curl, wget, WebFetch always denied; Read over 50 KB gets guidance only, the file is still read, `hooks/core/routing.mjs:845-861`), PostToolUse bookkeeping with no output replacement (`hooks/posttooluse.mjs:224`: "PostToolUse hooks don't need hookSpecificOutput"), PreCompact snapshot, SessionStart injection, UserPromptSubmit and Stop capture. The Pi adapter (`src/adapters/pi/extension.ts`) subscribes `session_start`, `tool_call`, `tool_result`, `before_agent_start`, `context`, `before_provider_response`, `turn_end`, `session_before_compact`, `session_compact`, `session_shutdown` (lines 467 to 858). Pi has no native MCP, so the adapter spawns the MCP server as a child and re-registers its tools; that bridge once fork-bombed Bun hosts because `process.execPath` was the `pi` binary (`src/adapters/pi/mcp-bridge.ts:34-49`).

**Savings accounting.** A flat 4 bytes per token and hardcoded `bytesAvoided` estimates for denied fetches (`hooks/core/routing.mjs:779,886`). `docs/adr/0004-stats-strict-compression-formula.md` records a 49-point drift between two display formulas. Treat its headline percentages as instrumentation, not measurement.

## 3. Head-to-head code comparison

Criteria are fixed per row. Verdict: ours, theirs, or equivalent.

| Mechanism | context-mode | This repo | Criteria | Verdict |
|---|---|---|---|---|
| Large-output interception | PreToolUse nudge plus a marker file; PostToolUse cannot replace output (`hooks/posttooluse.mjs:224`); Read over 50 KB emits guidance, the file is still read (`routing.mjs:845-861`) | `instrumentTools` owns the tool boundary and replaces ToolMessage content before the model sees it (`packages/agent/src/sub-agent-instrumentation.ts:433-455`) | Can it stop bytes entering the model? | Ours |
| Truncation strategy | Byte ladder, no JSON awareness (`src/server.ts:1979-1980`) | JSON-aware, 8 strategies, structural keep counts hits 3, nodes 5, arrays 20, rows 20 (`sub-agent-truncate-tool-output.ts:5-8,18-19`), LLM cap 131072 (`packages/shared/src/pagination.ts:17`) | Fidelity of what the model sees | Ours |
| Recoverability after truncation | Full text indexed; `ctx_search` returns any section later (`src/store.ts:838`, `src/server.ts:2750`) | None. `ctx.rawOutputs` is consumed once at `packages/agent/src/sub-agent.ts:1746` and discarded; a truncated ToolMessage carries no pointer | Can the model get more later? | Theirs. Closed by item 2 |
| Cumulative loop budget | None in-loop; relies on compaction | SIO-1250 elide-never-remove via `preModelHook`, default 400000, with a measured tuning record: a 60000 run scored 0.15 (`packages/agent/src/sub-agent-context-budget.ts:36-40`) | Bounded loop context without message removal | Ours |
| Full-fidelity persistence | FTS5 store per project, 14-day retention (`src/server.ts:727-733`) | `toolOutputs[].rawJson` capped at 65536 (`sub-agent-truncate-tool-output.ts:15`) except typed-finding tools, which skip the cap (`sub-agent.ts:1760`) | What survives for extractors and follow-up turns | Equivalent for extractors, theirs for follow-up turns. Closed by items 2 and 3 |
| Deterministic event extraction | 2960-line regex extractor, about 26 categories (`src/session/extract.ts`) | `extractToolErrors`, `toolErrors` on every result, loop-guard ledgers (`sub-agent-loop-guard.ts:299`), `tool-call-metrics` counters, `subagent.tool_result_truncated` log events with original and final bytes | Coverage, and whether a reader exists | Equivalent. One gap, closed by item 4 |
| Compaction snapshot | Table of contents with runnable search calls, no byte budget (`src/session/snapshot.ts:470`) | `pruneThreadState` keeps 20 messages and resets `dataSourceResults` to `[]`, leaving no pointer (`apps/web/src/lib/server/agent.ts:450-475`, `state-pruning.ts:17-18`) | Does evidence provenance survive pruning? | Theirs. Closed by item 3 |
| Pre-tool deny | curl, wget, WebFetch denied with hardcoded `bytesAvoided` 8192 and 16384 (`routing.mjs:779,886`) | Loop guard `stopReasonFor` with per-tool ledgers and a completeness bias that refuses to early-exit a partial enumeration (`sub-agent-loop-guard.ts:67,299-304`) | Precision of the deny; honesty of the accounting | Ours |
| Fleet inbox to model | Not applicable | Only counts, severities, alarm names and timestamps reach the prompt; bodies never do (`packages/agent/src/fleet-inbox.ts:231-249`) | Untrusted text never reaches the model | Ours |
| Log dedupe | Not applicable | Normalised signature hash, 24 h re-alert, caps 3 per group and 10 per cycle (`packages/pi-coms/scripts/monitor/checks/logs.ts:28-59`) | Derive in code, report the count | Ours |
| Sandbox | Subprocess in a temp dir, no isolation, network on, byte cap kills the process (`src/executor.ts:229-233`) | In-process typed extractors (`packages/agent/src/correlation/extractors/`); on spokes Pi's `bash` is the sandbox | Attack surface against benefit | Ours, by not building one |
| Savings accounting | Flat 4 bytes per token; ADR 0004 records a 49-point drift | Per-call `originalBytes` and `finalBytes` in the truncation log event (`sub-agent-instrumentation.ts:443-452`) | Measured against estimated | Ours |

Every "theirs" row links to the ranked item that closes it. A measured A/B through both truncation paths on the 233 KB Elasticsearch search fixture is an open question, not part of this study.

## 4. Concept by surface matrix

SOLVED: already covered. GAP: worth filling. POOR: poor fit. HARMFUL: would regress.

| Concept | Analyzer sub-agent loop | gitagent hooks and memory | Fleet spokes and monitor | Fleet console and inbox |
|---|---|---|---|---|
| Return ladder | GAP, additive only. Truncation exists; the missing rung is a pointer to the rest. Replacing truncation is HARMFUL (`sub-agent-context-budget.ts:36-40`) | POOR. `readLiveMemory` reads about 13 KB of files (`packages/agent/src/memory-writer.ts:98-107`), under the 5 KB per file rung in practice | GAP. No cap on spoke tool output entering Pi context; `coms-net.ts` subscribes only `session_start:1031`, `agent_end:1912`, `agent_settled:1967`, `session_shutdown:2118` | SOLVED. `EXCERPT_MAX` 280 and 20 entries per estate (`fleet-inbox.ts:18-25`); `SPOKE_TEXT_CAP` 4000 (`pi-fleet/tools.ts:34-40`). The mid-sentence cut is a bug, item 1 |
| FTS5 index | GAP as an evidence store. Porter-only suffices for JSON tool output | POOR. Agent Memory already does semantic search (`packages/shared/src/agent-memory.ts:311-333`); a local mirror is a second store of the same data | POOR alone. The monitor journal (`scripts/monitor/state.ts:17`) has no text-search consumer. Only meaningful with the ladder | POOR. Hub messages are read by id and status, never by text |
| Deterministic events | SOLVED. `toolErrors`, ledgers, counters, log events | GAP, small. Failure classes never reach `appendDailyLog` although `classifyFailureText` exists (`tool-call-metrics.ts:125`) | SOLVED. The journal and fingerprints tables are a deterministic event table | SOLVED. `parseMonitorReport` (`fleet-inbox.ts:107`) |
| Snapshot as TOC | GAP. Pruning throws evidence away. A consumer exists for free: the `recalledMemoryByThread` stash (`lifecycle.ts:61-64`) read by the aggregator every turn | Bootstrap side SOLVED by semantic recall (`lifecycle.ts:111-129`). The two dead teardown stubs (`lifecycle.ts:210,226`) stay stubs: a TOC's consumer is the next turn, not the next session | GAP. `ctx.compact()` at 150000 tokens (`coms-net.ts:28-33`) with no snapshot; `session_before_compact` unused. Motivation: eu-oit-prd reached 98 percent context on 72 findings in a day (`docs/architecture/monitoring.md:115`) | POOR. Console turns are single-shot |
| Sandbox execute | POOR to HARMFUL. Extractors derive in-process; LLM-authored code over injectable tool output inside AgentCore is new attack surface | POOR | SOLVED. Pi `bash` already is the sandbox | POOR |
| Lifecycle hooks | SOLVED. Loop guard is the deny, `instrumentTools` the post hook, `preModelHook` the budget | SOLVED. Closed enums in `packages/gitagent-bridge/src/hooks.ts:10,18` and five seams in `lifecycle.ts:26-79`. Add a step only with a consumer | GAP. Pi exposes `tool_result` (can rewrite content), `session_before_compact`, `context`, `turn_end`; coms-net uses 4 of them | SOLVED |

elastic-iac note: its always-on knowledge is about 506 KB of non-archive markdown, narrowed per intent. `packages/agent/src/iac/knowledge-selector.ts:36-40` records that narrowing the `info` catch-all was considered and rejected ("starving the downstream LLM is worse than paying for tokens"). That is SOLVED by decision. Its `kg_*` ReAct tool loop is a phase 2 extension candidate for the evidence index, listed as an open question.

## 5. Ranked opportunities

Value per line of code. Flags follow the default-ON kill-switch idiom, `v !== "false" && v !== "0"`, as a local helper (example `packages/agent/src/learn/config.ts:10`).

| # | Surface | Seam | Change | Size | Risk | Flag |
|---|---|---|---|---|---|---|
| 1 | Fleet | `agents/pi-fleet/agents/aws-spoke/RULES.md:151`; `packages/agent/src/pi-fleet/tools.ts:40`; `packages/pi-coms/scripts/coms-net-server.ts:44` | Reply-size rule in the persona; cut at the last newline before `SPOKE_TEXT_CAP`; hub `PI_COMS_NET_REPLY_CAP_BYTES` default 65536 where `response` is written. Independent of context-mode | S | None | Numeric env only |
| 2 | Analyzer | `packages/agent/src/sub-agent.ts:1746`, `:1601`; `sub-agent-instrumentation.ts:433-455`; `lifecycle.ts:237` | Per-thread `bun:sqlite` `:memory:` FTS5 porter table fed with every raw output; one pointer line appended to truncated ToolMessages; a `search_evidence` sub-agent tool returning 3 sections of 1500 characters; cleared at teardown. Additive only | M | Medium: must not replace truncation | `EVIDENCE_INDEX_ENABLED` |
| 3 | Analyzer | `apps/web/src/lib/server/agent.ts:450-475`; `lifecycle.ts:61-64`; `aggregator.ts` | Build a 1 to 2 KB plain-text evidence TOC from `dataSourceResults` before the reset and stash it per thread; the aggregator reads it next turn with no new plumbing | S | Low | `EVIDENCE_TOC_ENABLED` |
| 4 | Memory | The `DailyLogEntry` builder; `memory-writer.ts:110`; `tool-call-metrics.ts:125` | `toolFailures: {datasource, class}[]` derived by `classifyFailureText`, written by the existing `appendDailyLog` with the existing TTL. Nothing new stored | S | Low | `DAILYLOG_TOOL_FAILURES_ENABLED` |
| 5 | Spokes | `packages/pi-coms/extensions/coms-net.ts:1967-1977` | `pi.on("session_before_compact")` producing a short TOC from the spoke's `coms-net-log` entries, injected through Pi's compaction summary. Ships via the fleet bundle, since `buildPiPackage` drops `hooks/` | S to M | Medium: Pi 0.84.4 surface unverified | `PI_COMS_NET_SNAPSHOT_ENABLED` |
| 6 | Spokes | New `pi.on("tool_result")` in `coms-net.ts`; `pi.registerTool` precedents at `:1278-1734` | Two rungs: under 100 KB pass through; over 100 KB index into a spoke-local `bun:sqlite` file and return the head plus a pointer; register a search tool. No MCP server spawned | M | Medium-high: same elision hazard as SIO-1250 | `PI_COMS_NET_RESULT_LADDER_ENABLED` |
| 7 | Analyzer | `sub-agent.ts:1906-1958` | Truncation synthesis cites indexed section ids instead of re-serialising `rawOutputs` | S, after 2 | Low | Shares `EVIDENCE_INDEX_ENABLED` |
| 8 | Console | `coms-net-server.ts` messages table; `pi-fleet/tools.ts` | One FTS5 virtual table over `messages.response` and a `fleet_search_replies` tool through `wrapUntrusted`. Only on operator request | S | Low | `FLEET_REPLY_SEARCH_ENABLED` |

Why item 2 is a sub-agent tool and not a root-agent tool: the root has no tool loop. `aggregate` is a single completion over the results block. The root gets the TOC (item 3) instead.

Why the store is per process: a thread is sticky to the web app process for its lifetime, and `runTeardown` already owns per-thread cleanup. AgentCore production has no shared filesystem across containers (`docs/runbooks/mcp-agentcore-image-deployment.md`), which is why the SIO-1400 counters are stranded there; an in-memory per-thread index has no such dependency.

## 6. Roadmap

- Phase 1 (SIO-1687, no new storage): items 1, 3, 4.
- Phase 2 (SIO-1688, analyzer evidence store): items 2 and 7, measured with the eval harness in `packages/agent/src/eval/` against the 0.78 confidence baseline recorded at `sub-agent-context-budget.ts:32-33`. Default ON only after the A/B shows no regression.
- Phase 3 (SIO-1689, spokes, experimental): item 5, then item 6 once the Pi 0.84.4 checks pass. Item 8 on request.

## 7. Do not do

- Do not replace JSON-aware truncation or lower `SUBAGENT_CONTEXT_BUDGET_BYTES` or the per-result caps to force pointer use. `sub-agent-context-budget.ts:36-40` records the 0.15 regression.
- Do not add a `session_events` table in the analyzer. `toolErrors`, the loop-guard ledger, `tool-call-metrics` and the structured log events already cover it, and a new table would have no reader.
- Do not mirror Agent Memory facts or messages into local FTS5. Duplicate store; `relevant_k` semantics (`agent-memory.ts:318-333`) already give deterministic recall.
- Do not narrow the elastic-iac `info` catch-all. `knowledge-selector.ts:36-40` records the decision.
- Do not port RRF fusion, the trigram tokenizer, the proximity rerank or 4096-byte chunking as a ranking pipeline. Porter FTS5 over per-call rows is enough for JSON tool output. Copying the chunker when the store lands is fine; add ranking only when a measured miss appears.
- Do not build `ctx_execute`-style sandboxing in the analyzer. New attack surface, no consumer.
- Do not extend `BootstrapStepSchema` or `TeardownStepSchema` for a TOC or events. The seams and the stash already exist; a new enum value with no consumer is scaffolding.
- Do not spawn an MCP server from the Pi extension. Register Pi tools directly.
- Do not add FTS to the monitor journal or hub messages until someone needs text search.
- Do not add `better-sqlite3`.

## 8. Open questions

1. RESOLVED 2026-09-10. Pi 0.84.4 exposes both. Verified against the pinned tarball, not upstream `main`: `session_before_compact` at `dist/core/extensions/types.d.ts:913` and `tool_result` with a rewritable `ToolResultEventResult.content` at `:835,940`. See section 11.
2. RESOLVED 2026-09-10. Yes, and more than truncate. See section 11: this retires phase 3 item 6.
3. Is the web app process Bun or Node in AgentCore production? Decides whether the evidence store needs the dual-driver path from `tool-call-metrics.ts:184-267` or `bun:sqlite` only.
4. Do follow-up turns re-query datasources today, or should the aggregator answer from memory? Decides whether item 3's TOC also goes into sub-agent directives.
5. May a hub reply cap apply to monitor reports, or must reports stay uncapped while verify replies are capped?
6. Which eval dataset A/Bs `EVIDENCE_INDEX_ENABLED` against the 0.78 baseline?
7. Should the elastic-iac `kg_*` ReAct loop get the evidence index in phase 2?
8. A measured A/B spike: feed the 233 KB Elasticsearch search fixture from the SIO-1247 thread through both truncation paths and compare bytes to the model, recoverability, and answer quality.

## 9. Verification recipe

Every phase:

```bash
bun run typecheck && bun run lint
```

Per package, never at the root (the root runner can crash mid-suite):

```bash
cd packages/agent && bun test
```

```bash
cd apps/web && bun run test
```

```bash
cd packages/pi-coms && bun test
```

FTS5 smoke check, the same one-liner used in this study:

```bash
bun -e 'import {Database} from "bun:sqlite"; const db=new Database(":memory:"); db.run("create virtual table t using fts5(title, content, tokenize=\"porter unicode61\")"); db.run("insert into t values (\"a\",\"connection refused to broker\")"); console.log(JSON.stringify(db.query("select title, bm25(t,5.0,1.0) s from t where t match \"broker\"").all()))'
```

Phase 2 measurement: the eval harness under `packages/agent/src/eval/` with the flag ON and OFF, compared to the 0.78 baseline.

## 10. References

context-mode: `LICENSE:1`; `package.json:3,107,124`; `src/server.ts:727-733,1979-1980,2750`; `src/store.ts:153-166,465-503,838,1249-1253`; `src/session/extract.ts`; `src/session/snapshot.ts:470`; `src/executor.ts:229-233`; `hooks/posttooluse.mjs:224`; `hooks/core/routing.mjs:779,845-861,886`; `src/adapters/pi/extension.ts:467-858`; `src/adapters/pi/mcp-bridge.ts:34-49`; `docs/adr/0004-stats-strict-compression-formula.md`.

This repo: `packages/gitagent-bridge/src/hooks.ts:10,18`; `packages/agent/src/lifecycle.ts:26-79,111-129,210,226,237`; `packages/agent/src/memory-writer.ts:98-110`; `packages/shared/src/agent-memory.ts:311-333`; `packages/shared/src/tool-call-metrics.ts:125,184-267`; `packages/agent/src/sub-agent-instrumentation.ts:286,309,323,433-455`; `packages/agent/src/sub-agent.ts:1601,1746,1760,1906-1958`; `packages/agent/src/sub-agent-truncate-tool-output.ts:5-19`; `packages/agent/src/sub-agent-context-budget.ts:30-40`; `packages/shared/src/pagination.ts:17`; `packages/agent/src/aggregator.ts:82-88`; `packages/agent/src/state-pruning.ts:17-18`; `apps/web/src/lib/server/agent.ts:450-475`; `packages/agent/src/sub-agent-loop-guard.ts:67,299-304`; `packages/agent/src/fleet-inbox.ts:18-25,107,231-249`; `packages/agent/src/pi-fleet/tools.ts:34-40`; `packages/pi-coms/extensions/coms-net.ts:28-33,1031,1912,1967-1977,2118`; `packages/pi-coms/scripts/coms-net-server.ts:33-56`; `packages/pi-coms/scripts/monitor/state.ts:17`; `packages/pi-coms/scripts/monitor/checks/logs.ts:28-59`; `packages/pi-coms/deploy/bootstrap/agent-bootstrap.sh:86-102`; `packages/agent/src/iac/knowledge-selector.ts:36-40`; `packages/checkpointer/src/index.ts:12`; `agents/pi-fleet/agents/aws-spoke/RULES.md:151`.

Docs read: `docs/architecture/sub-agent-context-assembly.md`, `docs/architecture/pi-fleet-third-graph.md`, `docs/architecture/monitoring.md`, `docs/superpowers/specs/2026-06-17-couchbase-agent-memory-backend-design.md`, `docs/superpowers/specs/2026-06-17-state-pruning-design.md`.

## 11. Phase 3 preconditions, resolved (2026-09-10)

Phase 3 (SIO-1689) was gated on three preconditions. All three were checked
against the pinned Pi 0.84.4 package itself (`npm pack
@earendil-works/pi-coding-agent@0.84.4`), not the upstream `main` branch the
original survey read. The answers retire most of the phase.

**Pi's hooks exist.** `session_before_compact` and `tool_result` are both
declared in the pinned build, and `ToolResultEventResult.content` can indeed
rewrite a tool result before it enters the conversation
(`dist/core/extensions/types.d.ts:835,913,940`). The capability question is
settled: the seams are real.

**Item 6 (tool_result ladder) is retired.** Pi's `bash` tool already implements
the whole ladder, and better than the proposal. It truncates at 2000 lines or
50 KB, whichever comes first (`dist/core/tools/truncate.js:10-11`), writes the
complete output to a temp file, and tells the model the path and what it is
missing: "Showing lines 1-2000 of 84,213. Full output: /tmp/..."
(`dist/core/tools/bash.js:314-320`). The spoke's own `read` tool takes
`offset`/`limit` and its `grep` tool takes a pattern, so any part of the elided
output is already retrievable, by line range or by search. Building a
spoke-local FTS5 index would duplicate a working mechanism and add a second
truncation authority to reason about. The correct action is none.

**Item 5 (compaction snapshot) is retired.** Two findings. First, the current
call is not blunt: `ctx.compact()` (`packages/pi-coms/extensions/coms-net.ts:1977`)
invokes Pi's own compaction, which runs an LLM summarization over a transcript
that preserves user turns, assistant reasoning, tool calls WITH their arguments,
and tool results (`dist/core/compaction/utils.js:95-141`). That is strictly
richer than the table-of-contents this item proposed building from
`coms-net-log` entries. Second, `SessionBeforeCompactResult` accepts only
`{cancel, compaction}` (`types.d.ts:857-860`), so a handler cannot append to
Pi's summary: it must replace the whole `CompactionResult`, taking ownership of
`summary` and `firstKeptEntryId`. Replacing a working LLM summarizer with a
hand-rolled digest is a downgrade with a correctness risk attached.

The incident that motivated item 5 was also already solved, and not by
compaction. eu-oit-prd reaching 98 percent context
(`packages/pi-coms/docs/architecture/monitoring.md:115`) was fixed by SIO-1673's
investigation budget and operator controls, which bound how many prompts a noisy
source can buy. Compaction was never the mechanism holding that line.

**Item 8 (hub reply search) stays unbuilt**, as specified: it was conditioned on
an operator asking for it, and none has.

**Net.** Phase 3 ships no code. The spoke context path is in better shape than
the study assumed, because Pi supplies natively what phase 3 proposed to add.
What remains genuinely open on the fleet is reply SIZE, which phase 1 addressed
at the three places we do control: the persona rule, the console's line-boundary
cut, and the hub's reply cap.
