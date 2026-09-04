# pi-coms verification and investigation handoff design (SIO-1635)

## Context

The incident analyzer produces a markdown report with a root cause, a confidence score, and mitigation proposals. The `pi-coms` repo (`/Users/Simon.Owusu@Tommy.com/WebstormProjects/pi-coms`) already runs a hub-and-spoke network of read-only pi agents, one per AWS account, fronted by a hub that speaks plain authenticated HTTP plus SSE. The user wants the report handed to those agents so a live agent with account credentials can verify and validate the findings against real AWS state, and, where the verdict is weak, launch a deeper investigation whose results flow back into the chat.

Decisions already made with the user:

- Trigger: an approve card after the report, not automatic and not a blocking graph node.
- Scope: card 1 "Verify with pi agent" returns a structured verdict. If any claim is contradicted or unverifiable, card 2 "Launch pi investigation" is offered.
- Routing: the pi agent whose name matches the incident's AWS estate, with the shared `ops` inbox as the durable fallback.

Design constraints found during exploration:

- The hub requires a registered sender for `POST /v1/messages`. A reaped sender does not break `GET /v1/messages/:id/await` or the target's reply, so a short-lived session per action is safe (`scripts/coms-net-server.ts:1557-1622`, `:1444-1470`).
- `await` long-polls at most 30 s per call by default and is capped at the message TTL (30 min). Reply is the agent's final text, or the extracted JSON object when `response_schema` is set; only JSON parseability is checked upstream (`extensions/turnReply.ts:27-43`), so schema conformance is ours.
- Estate ids in this repo (`eu-<service>-prd` style) follow the same account-alias naming as the deployed pi agents (`eu-<service>-dev` style today). Routing is by name with an optional override map.
- AWS per-estate results are tagged `deploymentId: "estate:<name>"` (`packages/agent/src/sub-agent.ts:2145`), and `state.awsTargetEstates` holds the estates assessed.
- The report is prose. The verifier gets `finalAnswer` plus the sidecars (`confidenceScore`, `rootCauseDataSources`, `reportCaveats`).
- Bake-off rule still applies: both reviewers on the PR, ledger entry in `docs/code-review-bakeoff.md`.

## Approach

Reuse the existing action-tool lane end to end. No graph change, no new interrupt, no inbound webhook. Two new tools in the closed `PendingAction.tool` enum, one deterministic proposer that appends the verify card in `aggregateMitigation`, one thin HTTP client for the hub, and a richer result rendering in the existing card.

Alternative considered and rejected for v1: a persistent peer client (register once, hold SSE, heartbeat) installed through the `lifecycle.ts` seams. It only pays off when hub agents need to push to us unprompted. The per-action session is stateless and matches how `slack-notifier.ts` and `ticket-creator.ts` already work.

## Data contracts

New file `packages/shared/src/pi-coms-types.ts` (types are imported by the web client, so keep it type-and-Zod only, no runtime side effects):

```ts
export const PiClaimStatusSchema = z.enum(["confirmed", "contradicted", "unverifiable"]);
export const PiVerdictSchema = z.object({
  verdict: z.enum(["confirmed", "partially_confirmed", "contradicted", "unverifiable"]),
  summary: z.string(),
  claims: z.array(z.object({ claim: z.string(), status: PiClaimStatusSchema, evidence: z.string() })),
  additional_observations: z.array(z.string()),
  recommended_investigation: z.string().nullable(),
});
export const PiInvestigationSchema = z.object({
  summary: z.string(),
  root_cause_hypothesis: z.string(),
  evidence: z.array(z.object({ resource: z.string(), observation: z.string() })),
  suggested_actions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
```

Plus the matching JSON Schema constants (`PI_VERDICT_RESPONSE_SCHEMA`, `PI_INVESTIGATION_RESPONSE_SCHEMA`) handed to the hub as `response_schema`, mirroring `scripts/monitor/report.ts:38-56` in pi-coms.

`packages/shared/src/action-types.ts`:

- `PendingActionSchema.tool` enum gains `"verify-with-pi"` and `"investigate-with-pi"`.
- `ActionResultSchema` gains `followUpActions: z.array(PendingActionSchema).optional()` so an executed action can propose the next card.

Action params (set at proposal time, so the executor needs nothing beyond `reportContent`):

- `verify-with-pi`: `{ estate, target, severity, confidence, summary }`
- `investigate-with-pi`: `{ estate, target, severity, focus, conversation_id }` where `focus` lists the contradicted and unverifiable claims plus `recommended_investigation`, and `conversation_id` is the verify message id so the hub threads the two.

`packages/shared/src/config.ts`: `PiComsConfigSchema { serverUrl: url, authToken: string.min(1), project: string, fallbackTarget: string, estateAgentMap: record<string,string>, verifyTimeoutMs: int, investigateTimeoutMs: int }`. No `.default()` in the schema; defaults are applied in the env resolver, matching `resolveAgentMemoryConfig` in `packages/shared/src/agent-memory.ts:354`.

## Env

Reuse the pi-coms variable names so one `.env` fragment serves both repos:

| Var | Default | Purpose |
|---|---|---|
| `PI_COMS_NET_SERVER_URL` | unset (feature off) | hub URL, for example the SSM tunnel `http://127.0.0.1:8787` |
| `PI_COMS_NET_AUTH_TOKEN` | unset (feature off) | bearer token |
| `PI_COMS_NET_PROJECT` | `default` | hub project |
| `PI_COMS_FALLBACK_TARGET` | `ops` | durable inbox when no estate agent is online |
| `PI_COMS_ESTATE_AGENT_MAP` | `{}` | optional JSON `{ "<estate>": "<agent name>" }` override |
| `PI_COMS_VERIFY_TIMEOUT_MS` | 300000 | verify budget |
| `PI_COMS_INVESTIGATE_TIMEOUT_MS` | 900000 | investigation budget |

`isPiComsConfigured()` is true when URL and token are both set. Document in `.env.example` next to the Slack and Linear blocks (around line 408), placeholders only, no real estate names or account ids (repo is public).

## Backend

### `packages/agent/src/action-tools/pi-coms-client.ts` (new)

Minimal hub client modelled on `scripts/monitor/coms.ts` in pi-coms but without SSE:

- `register()`: `POST /v1/agents/register` with `{ project, session_id: crypto.randomUUID(), name: "incident-analyzer", purpose, model: "none", color, cwd, explicit: true }`.
- `listAgents()`: `GET /v1/agents?project=` returning names and `status`, used to decide whether the estate agent is online.
- `send(target, prompt, { response_schema, ttl_ms?, conversation_id? })`: `POST /v1/messages` with `hops: 0`.
- `awaitReply(msg_id, budgetMs)`: loops `GET /v1/messages/:id/await?timeout_ms=25000` until terminal or budget exhausted, posting a heartbeat between polls so the sender is not reaped mid-wait. Returns `{ status, response, error }`.
- `deregister()`: `DELETE /v1/agents/:sid?project=` in a `finally`.

Errors carry HTTP status and hub `error` code (`sender_not_registered`, `target_not_found`, `hop_limit_exceeded`) so the executor can produce readable failures.

### `packages/agent/src/action-tools/pi-verifier.ts` (new)

- `isPiComsConfigured()` and `resolvePiComsConfig(env)`.
- `resolvePiTarget(estate, onlineNames)`: map override, else the estate name if online, else `fallbackTarget` with a mailbox `ttl_ms` (above the 30 min default so the hub queues it) and an explanatory `reason` on the card.
- `proposePiVerification(state): PendingAction[]`: when configured, one `verify-with-pi` card per estate in `state.awsTargetEstates` (fallback: estates parsed from `dataSourceResults[].deploymentId` with the `estate:` prefix), capped at 3, skipped when `finalAnswer` is under 50 chars. Deterministic, no LLM.
- `buildVerifyPrompt(...)` and `buildInvestigatePrompt(...)`: instruct the agent to check each claim against live account state with read-only calls, include the report (truncated to a fixed budget), confidence, root-cause data sources, caveats, and to reply with JSON only matching the schema.
- `executePiVerify(params, reportContent)`: register, send with `PI_VERDICT_RESPONSE_SCHEMA`, await, parse with `PiVerdictSchema.safeParse`, deregister. On success returns `{ verdict, target, msg_id }`; when any claim is `contradicted` or `unverifiable`, or `verdict !== "confirmed"`, also returns one `investigate-with-pi` follow-up action.
- `executePiInvestigate(params, reportContent)`: same shape with `PI_INVESTIGATION_RESPONSE_SCHEMA`, longer budget, `conversation_id` threading.
- Queued-to-mailbox sends (offline target) return `status: "success"` with `result.queued: true` and the message id, no await.

### `packages/agent/src/action-tools/executor.ts`

- Dispatch the two new tools in `executeAction`. `getAvailableActionTools()` stays as the LLM-proposable list (Slack, Linear) so the severity gate and prompt in `mitigation.ts:25-51` are untouched.

### `packages/agent/src/mitigation.ts`

- After the LLM proposal block, `pendingActions.push(...proposePiVerification(state))`. Runs regardless of severity and even when no LLM proposal ran.

### `apps/web/src/routes/api/agent/actions/+server.ts`

- Unchanged in shape. The route already awaits `executeAction`; the client caps each upstream hub call at 25 s and the overall budget at the configured timeout.

## Frontend

### `apps/web/src/lib/stores/agent.svelte.ts` `executeAction` (line 478)

- After appending the result, `if (result.followUpActions?.length) pendingActions = [...pendingActions, ...result.followUpActions]`. Cards render because `ChatMessage.svelte:217` shows `pendingActions` on the last message.

### `apps/web/src/lib/components/ActionConfirmationCard.svelte`

- `toolLabels` and `toolIcons` entries for both tools ("Verify with pi agent", "Launch pi investigation").
- Pending view: show `target`, `estate`, and either the summary or the focus list.
- Result view: when `result.tool` is one of the pi tools and `result.result` parses as a verdict or investigation, render a compact block: overall verdict chip, per-claim rows with a status chip and evidence, additional observations, and for investigations the hypothesis, evidence rows, suggested actions, and confidence. Fallback to the existing Completed/Failed banner otherwise. Queued sends show "Queued to <target> mailbox".
- Tailwind only, no custom CSS; run the Svelte autofixer on the edited component.

## Docs

- `docs/architecture/pi-coms-verification.md` (new, short): flow diagram, contracts, env, routing rule, timeouts, and the security note that hub replies are rendered as data and never fed back into the LLM.
- One paragraph in `docs/architecture/agent-pipeline.md` under the mitigation lane pointing at it.
- `CLAUDE.md` Sub-Agents or Frontend section: one line naming the two action tools.

## Tests

Mock at the network boundary (global `fetch`), never sibling modules, per the note in `executor.test.ts:5-8`.

- `pi-coms-client.test.ts`: register, send, chunked await until terminal, heartbeat between polls, budget timeout, deregister in `finally`, hub error codes surfaced.
- `pi-verifier.test.ts`: `resolvePiTarget` (override, online estate, offline fallback with ttl), `proposePiVerification` (no config, no estates, `deploymentId` fallback, cap at 3, short report), verdict parsing rejects malformed JSON, follow-up action emitted only when needed, prompt truncation.
- `executor.test.ts`: dispatch for both tools, unknown-tool path unchanged.
- `mitigation.deadline.test.ts` or a new `mitigation.pi.test.ts`: verify card appended without severity gate.
- `apps/web`: card SSR probe for verdict rendering (run via `cd apps/web && bun run test`); store `followUpActions` append.

## Verification

1. `bun run typecheck && bun run lint && bun run test` (per package for `packages/agent`, `packages/shared`, `apps/web`).
2. Local hub smoke: in pi-coms run `just coms-net-server` (pinned port, note the PID), start one pi peer with `just coms eu-oit-dev` or set `PI_COMS_ESTATE_AGENT_MAP` to point the estate at whatever peer is online. Set `PI_COMS_NET_SERVER_URL` and `PI_COMS_NET_AUTH_TOKEN` in this repo's `.env`, run the web app, ask an AWS incident question, approve "Verify with pi agent", confirm the verdict block renders and, with a contradicted claim, the investigation card appears and completes. Kill every process started and prove ports free with `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
3. Offline path: stop the peer, approve verify, confirm the card shows "Queued to ops mailbox" and `GET /v1/mailbox?name=ops` on the hub lists the message.
4. Corp hub path (user-run): through `just hub-tunnel`, same flow against a deployed account agent.

## Workflow

- Linear issue: https://linear.app/siobytes/issue/SIO-1635 (created 2026-09-04 from this design); commit format `SIO-1635: message`.
- Branch from `main`, PR ready for review, both bots triaged, bake-off ledger entry, Greptile status check gate, no merge without the user's smoke test.

## Out of scope (follow-ups, not this ticket)

- Feeding the verdict back into the conversation so later turns can reference it.
- Persistent peer registration so hub agents can push findings unprompted.
- Async action execution with server-side result polling if the synchronous route proves too long for browsers in practice.
- Verification for non-AWS data sources.
