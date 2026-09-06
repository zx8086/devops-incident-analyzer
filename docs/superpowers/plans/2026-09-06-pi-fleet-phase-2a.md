# pi-fleet Phase 2a Implementation Plan (SIO-1650): thin hub pane

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pane next to the incident chat that lists the live pi-coms spokes per environment hub and lets the operator address one spoke directly, with the reply rendered as data next to the historical analysis.

**Architecture:** The web app reuses the Phase 0 hub client through the `@devops-agent/agent` barrel. A server module (`apps/web/src/lib/server/pi-fleet.ts`) owns the pane's hub access: agents are listed per configured hub without registering; a message registers a short-lived `pi-fleet-<hex>` sender, sends, waits one 25 s slice and deregisters; the browser re-polls the message by id until it is terminal or the pane budget is spent, so no HTTP request outlives one slice plus grace. Replies are rendered as data by a props-driven Svelte 5 component and never enter an LLM call. Pane state lives in a pure reducer (`pi-fleet-reducer.ts`) wrapped by a thin runes store, so the logic is unit-testable.

**Tech Stack:** SvelteKit (Svelte 5 runes, Tailwind v4 `tommy-*` tokens), Bun test (`--isolate`), Zod 4, the Phase 0 `PiComsClient`.

**Spec:** Linear SIO-1650 (steps 1 to 6, acceptance criteria), `docs/architecture/pi-fleet-gitagent-feasibility.md` (Phase 2a), `experiments/HANDOFF-2026-09-06-pi-fleet-program.md`.

## Context

Verified before planning:

- `packages/agent/src/index.ts` exports nothing from `action-tools/pi-coms-client.ts` or `pi-verifier.ts`; the package has no `exports` map, so the barrel is the only door for the web app.
- The web app imports `@devops-agent/agent` directly (dependency present); `@devops-agent/pi-coms` is not a web dependency and must not become one (types flow through the agent package).
- `bun -e 'await import("@devops-agent/agent")'` loads in about 1.5 s inside `apps/web` with no side effects, so the server module's tests can use the real client with a scripted `fetchImpl`.
- `apps/web` tests run with `bun test --isolate` (per-file module registry), so the new tests need not touch the sibling `mock.module("@devops-agent/agent", ...)` factories; they do not mock the barrel at all.
- The hub's `GET /v1/agents`, `GET /v1/messages/:id/await` and `GET /v1/mailbox` need only the bearer token; `POST /v1/messages` needs a registered sender. Hub status values: `online | stale | offline`; message statuses: `queued | delivered | complete | error | timeout`.
- Directory-mode hubs bind names to principals, so the `pi-fleet-*` prefix needs its own principal and token (issue step 5). Token-mode hubs (local `just coms-net-server`) accept any name with the shared token.
- Existing right pane precedent: SIO-1572 `GraphTriagePanel` (`+page.svelte:283` split row, header toggle at `:246`, `localStorage` persisted).

## Decisions

- **Token per hub for the pane:** `PI_COMS_PANE_TOKENS` (JSON `{ "dev": "<token>", "prd": "<token>" }`) overrides the hub's `authToken` for the pane; when absent the pane uses the hub's own token (token-mode hubs, or an operator who sets the prefix to `incident-analyzer`). `PI_COMS_PANE_SENDER_PREFIX` defaults to `pi-fleet`.
- **Budgets:** the server waits one slice per request (`PI_COMS_PANE_AWAIT_MS`, default 25000, capped at 60000); the browser re-polls until `PI_COMS_PANE_TIMEOUT_MS` (default 300000) is spent and then shows a readable timeout. Both are reported by `/api/pi/agents` so the client never guesses.
- **No new dependency, no schema change in `@devops-agent/shared`:** the pane config is read in the web server module from `process.env` (the routes' convention), not added to `PiComsConfigSchema`.
- **Icon:** a new `fleet` name is NOT added to `Icon.svelte`; the toggle reuses `message-square`.

## Global Constraints

- Bun runtime, TypeScript strict, never `any`, Zod for validation, no `.default()` in config schemas, Biome, named exports, Tailwind only, Svelte 5 runes.
- No emojis. No em dashes in prose.
- Public repo: no account ids, internal hostnames, tokens. Sweep `git diff origin/main..HEAD | grep -nE '[0-9]{12}|pvhcorp|tommy\.com|pvh\.cloud'` before pushing.
- Hub replies never reach an LLM prompt: the pane renders them as data only.
- No cross-environment access: a message goes to the hub the peer was listed from; the server refuses an environment without a hub.
- Commit format `SIO-1650: message`, HEREDOC body ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. PR ready for review, never draft. Merge only on the user's explicit go-ahead.
- Tests: `cd apps/web && bun run test`; `cd packages/agent && bun test --isolate`; `bun run typecheck && bun run lint`.

## File structure

```
packages/agent/src/index.ts                          + pi-coms client and verifier exports
apps/web/src/lib/pi-fleet-types.ts                   browser-safe Zod schemas for the three route responses
apps/web/src/lib/server/pi-fleet.ts                  pane config + listAgents / sendMessage / awaitMessage / readMailbox
apps/web/src/lib/server/pi-fleet.test.ts             scripted fetchImpl tests (network boundary)
apps/web/src/routes/api/pi/agents/+server.ts         GET
apps/web/src/routes/api/pi/messages/+server.ts       POST send+await one slice; GET re-await by msgId
apps/web/src/routes/api/pi/mailbox/+server.ts        GET durable inbox
apps/web/src/routes/api/pi/agents/server.test.ts     route test (server module mocked)
apps/web/src/routes/api/pi/messages/server.test.ts   route test (validation, envelopes)
apps/web/src/lib/stores/pi-fleet-reducer.ts          pure state + reducers
apps/web/src/lib/stores/pi-fleet-reducer.test.ts
apps/web/src/lib/stores/pi-fleet.svelte.ts           runes wrapper: load(), send(), poll loop, mailbox()
apps/web/src/lib/components/PiFleetPane.svelte       props-driven pane
apps/web/src/lib/components/PiFleetPane.test.ts      SSR probe
apps/web/src/routes/+page.svelte                     toggle button + pane in the split row
.env.example                                         PI_COMS_PANE_* block
docs/architecture/pi-fleet-pane.md                   feature doc
packages/pi-coms/docs/integrations/incident-analyzer.md   pi-fleet principal
CLAUDE.md, docs/README.md, feasibility tracking row, handover status line
```

### Task 1: Barrel exports

**Files:** Modify `packages/agent/src/index.ts`.

- [ ] Add after the executor export:

```ts
export {
	isPiComsConfigured,
	PI_COMS_AWAIT_SLICE_MS,
	type PiAgentCard,
	PiComsClient,
	type PiComsClientDeps,
	PiComsHttpError,
	type PiInboxMessage,
	type PiMessageStatus,
	type PiReply,
	type PiSendResult,
	resolvePiComsConfig,
	senderNameFor,
} from "./action-tools/pi-coms-client.ts";
export { environmentForEstate, type HubSelection, selectHubForEstate } from "./action-tools/pi-verifier.ts";
```

- [ ] Verify: `cd apps/web && bun -e 'const m = await import("@devops-agent/agent"); console.log(typeof m.PiComsClient, typeof m.resolvePiComsConfig)'` prints `function function`.

### Task 2: Response contracts and the server module (TDD)

**Files:** Create `apps/web/src/lib/pi-fleet-types.ts`, `apps/web/src/lib/server/pi-fleet.ts`, `apps/web/src/lib/server/pi-fleet.test.ts`.

**Interfaces produced:**

```ts
// pi-fleet-types.ts
PiFleetPeerSchema = { name, status: "online"|"stale"|"offline", purpose?, sessionId }
PiFleetHubSchema = { environment: "dev"|"stg"|"prd", project, fallbackTarget, peers: PiFleetPeer[], error: string | null }
PiFleetAgentsResponseSchema = { configured: boolean, senderPrefix, awaitMs, totalBudgetMs, hubs: PiFleetHub[] }
PiFleetMessageResponseSchema = { environment, target, msgId, sender, status: "queued"|"delivered"|"complete"|"error"|"timeout"|"budget_exhausted", response: unknown, error: string | null, sentAt }
PiFleetMailboxResponseSchema = { environment, name, messages: PiFleetInboxMessage[] }
// server/pi-fleet.ts
type PiFleetDeps = { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; now?: () => number }
resolvePaneConfig(env): PaneConfig | undefined   (undefined when isPiComsConfigured is false; throws on malformed PI_COMS_HUBS or PI_COMS_PANE_TOKENS)
listFleetAgents(deps): Promise<PiFleetAgentsResponse>
sendFleetMessage({ environment, target, prompt }, deps): Promise<PiFleetMessageResponse>
awaitFleetMessage({ environment, msgId, target, sentAt }, deps): Promise<PiFleetMessageResponse>
readFleetMailbox({ environment, name, limit }, deps): Promise<PiFleetMailboxResponse>
class PiFleetRequestError extends Error { status: 400 | 404 }   (unknown environment, unconfigured)
```

- [ ] Write the failing tests: config resolution (unconfigured -> undefined; `PI_COMS_PANE_TOKENS` override; malformed tokens throws), `listFleetAgents` lists every hub and isolates a failing hub as `error` on that hub only, `sendFleetMessage` registers with the `pi-fleet` prefix on the target's hub only, sends, awaits one slice and deregisters, `awaitFleetMessage` returns `budget_exhausted` after a timeout slice with the hub still non-terminal, `readFleetMailbox` passes name and limit, unknown environment -> `PiFleetRequestError` 404 with no fetch.
- [ ] Run `cd apps/web && bun test --isolate src/lib/server/pi-fleet.test.ts` -> FAIL (module missing).
- [ ] Implement both files; run again -> PASS.

### Task 3: Routes (TDD)

**Files:** Create the three `+server.ts` files and two route tests.

- [ ] Route tests mock `$lib/server/pi-fleet` (module boundary) and assert: agents GET returns the module result as JSON; messages POST validates `{ environment, target, prompt }` (400 with `Invalid request`), maps `PiFleetRequestError` to its status, other errors to 500; messages GET requires `environment` and `msgId` query params.
- [ ] Run -> FAIL; implement; run -> PASS.

### Task 4: Reducer and store (TDD)

**Files:** Create `pi-fleet-reducer.ts`, `pi-fleet-reducer.test.ts`, `pi-fleet.svelte.ts`.

- [ ] Reducer tests: `applyAgents` sets `configured`, flattens peers with their environment, keeps the selection when the peer is still listed and clears it otherwise; `startMessage` appends a pending entry; `applyMessageResult` marks terminal statuses done and `budget_exhausted` still pending; `shouldKeepPolling(entry, now, totalBudgetMs)` false once the budget is spent and `expireMessage` writes the readable timeout; `formatReply(unknown)` renders strings verbatim and objects as pretty JSON.
- [ ] Implement the reducer; PASS. Then the runes store: `load()` (GET agents), `send(prompt)` (POST then poll GET every slice until terminal or budget), `loadMailbox(environment)`, `select(peer)`, `open` toggle persisted under `pi-fleet-pane-open`.

### Task 5: Component and page wiring

**Files:** Create `PiFleetPane.svelte`, `PiFleetPane.test.ts`; modify `+page.svelte`.

- [ ] SSR probe: hubs with peers render the environment badge and status per peer; the reply body of a done message is rendered inside a `<pre>`; a pending entry shows the waiting copy; an empty pane shows the no-peers copy.
- [ ] Implement the component (props-driven, Tailwind only); wire the toggle button (hidden unless `piFleetStore.configured`), the `{#if}` sibling in the split row after the graph pane, and `piFleetStore.load()` in `onMount`.

### Task 6: Config, docs, gate, PR

- [ ] `.env.example` PI_COMS_PANE block; `docs/architecture/pi-fleet-pane.md`; pi-coms integration doc principal section; CLAUDE.md (frontend component list, pane mention next to SIO-1635); docs/README.md rows; feasibility tracking row 2a; handover status line.
- [ ] Gate: `cd apps/web && bun run test`; `cd packages/agent && bun test --isolate src/action-tools`; `bun run typecheck && bun run lint`; sanitization sweep.
- [ ] Push `claude/sio-1650-phase2a-hub-pane`, open the PR ready for review, SIO-1650 to In Review with the link, `list_code_reviews` once, report and STOP for the merge go-ahead.

## Verification

```bash
bun run typecheck && bun run lint
cd apps/web && bun run test
cd packages/agent && bun test --isolate src/action-tools
```

Manual (user, needs a hub): start a local hub with `just coms-net-server`, set `PI_COMS_HUBS` to it, open the web app, toggle the pane, send a prompt to a registered peer; expect the reply as JSON under the peer name with the environment badge; stop the peer mid-wait and expect the readable timeout after the pane budget.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Directory-mode hub rejects `pi-fleet-*` under the analyzer token | Certain without step 5 | `PI_COMS_PANE_TOKENS` per hub; the send error surfaces as data on the entry |
| Long-poll exceeds an adapter limit | Low in dev | one slice per request, browser re-polls |
| `bun test` without `--isolate` picks up a sibling barrel mock | Low | the package test script always passes `--isolate`; documented in the test header |

## Out of scope

Phase 2b inbox node (SIO-1652), Phase 2c third graph, skillflow handlers (SIO-1651), minting the `pi-fleet` principal (user), hub protocol changes.
