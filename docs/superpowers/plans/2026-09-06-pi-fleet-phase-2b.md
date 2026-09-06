# pi-fleet Phase 2b Implementation Plan (SIO-1652): fetchFleetInbox enrichment node

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the historical incident analyzer the live fleet's recent notes without spending a spoke turn: a deterministic graph node reads each assessed estate's pi-coms inbox and the hub's `ops` inbox for the incident window, attaches a typed `fleetInboxDigest` sidecar, feeds only structured facts into the aggregator prompt, and renders a Fleet inbox card next to the report.

**Architecture:** `fetchFleetInbox` is registered always and edged only when `PI_COMS_INBOX_ENABLED` is `true`/`1` (SIO-640 edge-gate idiom), reached from `align` through a wrapper around `routeAfterAlignment` so it runs once, immediately before `aggregate`, and never on the validate retry loop. It reuses `estatesFromState`, `selectHubForEstate` and `PiComsClient.mailbox` (bearer only, no registration), one client per environment hub, every read under a short timeout and `Promise.allSettled`, soft-failing per estate. Pure helpers in `fleet-inbox.ts` classify messages (monitor report, conversation, other), parse the monitor's own report format for severity, finding count and alarm names, filter by window and sender, and render the prompt summary without any message body. The sidecar rides the SSE stream as `fleet_inbox` to a `FleetInboxCard`.

**Tech Stack:** LangGraph (`@langchain/langgraph` Annotation state), Zod 4, Bun test (`--isolate`), SvelteKit (Svelte 5 runes, Tailwind).

**Spec:** Linear SIO-1652; `docs/architecture/pi-fleet-gitagent-feasibility.md` section "2b Fleet inbox enrichment node".

## Context (verified 2026-09-06)

- The ticket places the node after `aggregate` and also wants the digest in the aggregator's LLM context. Those conflict: `aggregate` (`packages/agent/src/aggregator.ts:1625`) builds and invokes the prompt. The node therefore goes BEFORE `aggregate`. `routeAfterAlignment` (`alignment.ts:225`) returns `Send[]` or the literal `"aggregate"`, and `routeAfterValidate` (`graph.ts:46`) re-enters at `aggregate` on a retry, so a wrapper router that maps `"aggregate"` to `"fetchFleetInbox"` when enabled runs the node exactly once per turn. Recorded on SIO-1652.
- The fleet's `PI_MONITOR_REPORT_TO` is `ops` (set by `deploy/bootstrap/agent-bootstrap.sh:231`, code default `laptop`); the feasibility doc's open question is closed by this plan.
- Monitor reports are deterministic text (`packages/pi-coms/scripts/monitor/report.ts:73-102`): header `[<sev>] aws-<accountId>: <n> finding(s)`, then `- (<sev>/<family>) <resource>: <summary>` lines with indented `cause:` continuations. Alarm findings use the bare alarm name as `resource`.
- `GET /v1/mailbox` returns only mailbox rows and terminal conversations, newest 100 without `since`, oldest-first with `since` (`coms-net-server.ts:576-593`). This plan omits `since` and filters by `created_at` client-side.
- `AWS_ESTATES` entries carry `assumedRoleArn` (`arn:aws:iam::<account>:role/...`), so the account id per estate is derivable without a new mapping. `estateAgentMap` (pi-coms config) maps estate to agent name; monitor senders are `monitor-<agent>`.
- Inbox bodies are untrusted (spoke model output, operator free text). Bodies never reach a prompt; a capped excerpt reaches the card only, rendered as text.
- No test pins the node count; four docs state `31` (`CLAUDE.md:21,32,53`, `docs/architecture/agent-pipeline.md:6`, `docs/architecture/system-overview.md:122,284,306`). `agent-pipeline.md:776` is the elastic-iac graph and stays.
- The SSE node allowlist is derived from the compiled graph (SIO-1641); only `apps/web/src/lib/node-labels.ts` needs a cosmetic entry. Never add a path map to `detectTopicShift`.
- `VolatileSections` fields are optional and appended last with `?? ""` (byte-identity test SIO-1040).
- `apps/web` store resets `mlAnomalyExplainer` in seven places (`agent.svelte.ts:70,110,203,248,339,362,405,637,878,912`); the new field mirrors every one.

## Global Constraints

- Bun, TypeScript strict, never `any`, Zod, no `.default()` in config schemas, Biome, named exports, Tailwind only, Svelte 5 runes. Env read at call time, never at module scope.
- No emojis, no em dashes.
- Public repo: no account ids, hostnames, tokens in commits. Test fixtures use `111122223333`-style synthetic ids.
- Inbox bodies never reach an LLM prompt (test-asserted). No cross-environment access: each estate is read from its own environment's hub.
- Commit format `SIO-1652: message` with the Co-Authored-By trailer; PR ready for review; merge on explicit go-ahead; ledger row after.
- Tests: `cd packages/agent && bun test --isolate`; `cd packages/shared && bun test`; `cd apps/web && bun run test`; `bun run typecheck && bun run lint`.

## File structure

```
packages/shared/src/pi-coms-types.ts          FleetInboxEntrySchema, FleetInboxEstateSchema, FleetInboxDigestSchema (+ index.ts exports)
packages/shared/src/agent-state.ts            SSE event { type: "fleet_inbox", digest }
packages/agent/src/fleet-inbox.ts             pure helpers: gate, budget, sender exclusions, account id per estate, window, report parser, classify, filter, digest builder, prompt summary
packages/agent/src/fleet-inbox.test.ts
packages/agent/src/fleet-inbox-node.ts        runFetchFleetInbox(state, deps) + fetchFleetInbox node
packages/agent/src/fleet-inbox-node.test.ts   scripted fetch, two hubs, isolation, timeout
packages/agent/src/state.ts                   fleetInboxDigest slot
packages/agent/src/graph.ts                   node + wrapper router + gate log
packages/agent/src/aggregator.ts              fleetInboxContext
packages/agent/src/prompt-context.ts          buildFleetInboxSection, option
packages/agent/src/orchestrator-prompt-assembly.ts (+ test)   fleetInbox?: string appended last
apps/web/src/lib/server/sse-pump.ts (+ test)  fleet_inbox emit on fetchFleetInbox on_chain_end
apps/web/src/lib/stores/agent-reducer.ts (+ test), agent.svelte.ts   field, case, resets
apps/web/src/lib/components/FleetInboxCard.svelte (+ test), ChatMessage.svelte, node-labels.ts
.env.example                                  PI_COMS_INBOX_ENABLED, PI_COMS_INBOX_TIMEOUT_MS, PI_COMS_INBOX_EXCLUDE_SENDERS
docs/architecture/fleet-inbox-enrichment.md   feature doc; agent-pipeline.md, system-overview.md, CLAUDE.md counts and diagram; docs/README.md rows; feasibility doc (question closed, tracking); handover status
```

### Task 1: Shared schemas

- [ ] In `pi-coms-types.ts` add:

```ts
// SIO-1652: fleet inbox digest. Structured facts for the prompt and the card;
// `excerpt` is display-only (capped, untrusted text) and never enters a prompt.
export const FleetInboxKindSchema = z.enum(["monitor-report", "conversation", "other"]);
export const FleetInboxSeveritySchema = z.enum(["info", "warn", "critical"]);
export const FleetInboxEntrySchema = z.object({
	msgId: z.string(),
	inbox: z.string(),
	sender: z.string(),
	target: z.string().nullable(),
	kind: FleetInboxKindSchema,
	severity: FleetInboxSeveritySchema.nullable(),
	findingCount: z.number().int().nonnegative().nullable(),
	alarmNames: z.array(z.string()),
	createdAt: z.string(),
	completedAt: z.string().nullable(),
	excerpt: z.string(),
});
export const FleetInboxEstateSchema = z.object({
	estate: z.string(),
	environment: z.enum(["dev", "stg", "prd"]),
	inboxes: z.array(z.string()),
	entries: z.array(FleetInboxEntrySchema),
	counts: z.object({ total, monitorReports, conversations, other, critical, warn: z.number().int().nonnegative() ... }),
	alarmNames: z.array(z.string()),
	latestAt: z.string().nullable(),
	error: z.string().nullable(),
});
export const FleetInboxDigestSchema = z.object({
	windowFrom: z.string(), windowTo: z.string(), generatedAt: z.string(),
	estates: z.array(FleetInboxEstateSchema),
});
```

- [ ] Export from `packages/shared/src/index.ts` (alphabetical within the pi-coms block). Add the SSE event in `agent-state.ts` next to `ml_anomaly_explainer`. `cd packages/shared && bun test` green; typecheck.

### Task 2: Pure helpers (TDD)

`fleet-inbox.ts` exports: `isFleetInboxEnabled(env)`, `fleetInboxTimeoutMs(env)` (default 5000, integer guard), `excludedSenderPrefixes(env)` (default `["incident-analyzer-", "pi-fleet-"]`, `PI_COMS_INBOX_EXCLUDE_SENDERS` comma list), `accountIdForEstate(estate, env)` (from `AWS_ESTATES[estate].assumedRoleArn`), `incidentWindow(state, now)` (focus, then normalizedIncident, then 24 h), `parseMonitorReport(text)`, `classifyMessage(message)`, `withinWindow(message, from, to)`, `attributableToEstate(message, { accountId, agentNames })`, `buildEstateDigest(...)`, `summarizeFleetInboxForPrompt(digest)`, `EXCERPT_MAX = 280`.

- [ ] Tests first: report parse fixture; classify (report, conversation with response, other); prefix exclusion; window filter; attribution by header account and by sender names; digest counts and alarm names deduped; prompt summary lists counts, severities, alarm names, latest timestamp, and contains neither `excerpt` nor `prompt` text (a `SECRET-BODY-MARKER` in the fixture body must be absent); disabled/enabled gate; timeout parse guard. Run red, implement, run green.

### Task 3: Node (TDD)

- [ ] `fleet-inbox-node.ts`: `runFetchFleetInbox(state, deps = {})` with `deps: { env?, fetchImpl?, now? }`. Gates: `!isFleetInboxEnabled(env) || !isPiComsConfigured(env)` -> `{}`; `estatesFromState(state)` empty -> `{ fleetInboxDigest: undefined }`. Resolve config (catch -> warn, `{ fleetInboxDigest: undefined }`). Group estates by `selectHubForEstate`; unresolvable estates get an error row. One `PiComsClient(hub, { fetchImpl, now })` per environment. Per hub: read `ops` (fallbackTarget) once, and per estate its own inbox, each `withTimeout(fleetInboxTimeoutMs)`. `Promise.allSettled`; rejected reads become the estate's `error` (ops failure noted, estate inbox still used). Filter: exclusions, window, and for `ops` rows attribution to the estate. Cap 20 entries per estate, newest first. Return `{ fleetInboxDigest }`. Export `fetchFleetInbox = (state, config) => runFetchFleetInbox(state)`.
- [ ] Tests: two estates on two hubs read from their own hubs (URL assertion); a 500 on one hub leaves the other's rows intact; a hanging read times out (fake fetch never resolves; budget 50 ms) and yields the error row, not a rejection; self-sender exclusion; `ops` attribution; disabled and unconfigured paths make no fetch.

### Task 4: State, graph, prompt

- [ ] `state.ts`: `fleetInboxDigest: Annotation<FleetInboxDigest | undefined>({ reducer: (_, next) => next, default: () => undefined })`.
- [ ] `graph.ts`: `const fleetInboxEnabled = isFleetInboxEnabled();` logged; `.addNode("fetchFleetInbox", traceNode("fetchFleetInbox", fetchFleetInbox))`; replace the align conditional edge with `routeAfterAlignmentThenInbox(fleetInboxEnabled)` and path list `["queryDataSource", fleetInboxEnabled ? "fetchFleetInbox" : "aggregate"]`; `.addEdge("fetchFleetInbox", "aggregate")`. `grep -c addNode` = 32.
- [ ] `aggregator.ts`: `const fleetInboxContext = state.fleetInboxDigest ? summarizeFleetInboxForPrompt(state.fleetInboxDigest) : "";` passed as `fleetInboxContext`. `prompt-context.ts`: option + `buildFleetInboxSection` ("## Fleet inbox (live, derived this turn)" + instruction to treat as corroboration, not evidence, and not to reproduce). `orchestrator-prompt-assembly.ts`: `fleetInbox?: string` appended last; assembly test: omitted keeps byte-identity, provided appends after downstreamImpact.
- [ ] `cd packages/agent && bun test --isolate` green; typecheck.

### Task 5: Web

- [ ] `sse-pump.ts`: on `event.name === "fetchFleetInbox"` on_chain_end, guarded `FleetInboxDigestSchema.safeParse(output.fleetInboxDigest)`; emit `fleet_inbox` when `estates.length > 0`. sse-pump test.
- [ ] `agent-reducer.ts`: `fleetInboxDigest: FleetInboxDigest | null` + case; test. `agent.svelte.ts`: mirror every `mlAnomalyExplainer` site.
- [ ] `FleetInboxCard.svelte`: per estate: environment badge, inbox names, counts row, alarm names chips, entries list (kind chip, severity chip, sender to target, created time, excerpt in a `<pre>`-like inert text block), error text; hub attribution line. SSR test. `ChatMessage.svelte` `{#if !isStreaming && message.fleetInboxDigest}`. `node-labels.ts`: `{ id: "fetchFleetInbox", activeLabel: "Reading fleet inbox", completeLabel: "Fleet inbox read" }`.
- [ ] `cd apps/web && bun run test` green; svelte-check.

### Task 6: Config, docs, gate, PR

- [ ] `.env.example` block after the pane block. `docs/architecture/fleet-inbox-enrichment.md`. Counts 31 -> 32 (22 base) in CLAUDE.md, agent-pipeline.md (prose, diagram between align and aggregate, node section), system-overview.md. docs/README.md rows. Feasibility doc: open question closed (`ops`), tracking row. Handover status.
- [ ] Gate, sanitization sweep, push, PR, Linear In Review with the placement deviation noted, Greptile check, STOP for go-ahead.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| A slow hub delays the report | Medium | 5 s per-read budget, all reads parallel, soft-fail |
| `ops` rows from other accounts leak into an estate's digest | Medium | attribution by header account id or sender agent names; unattributable rows dropped |
| Body text reaches the prompt | Low | summary builder never reads `excerpt`/`prompt`; test asserts a body marker is absent |
| Byte-identity prompt test breaks | Low | optional field appended last |

## Out of scope

Feeding alarm names into resolve-identifiers presets (ticket step 7); PII redaction of bodies; Phase 3 (SIO-1651); hub protocol changes.
