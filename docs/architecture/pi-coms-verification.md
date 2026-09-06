# pi-coms verification and investigation handoff (SIO-1635)

After the incident analyzer produces a report that assessed one or more AWS
estates, the user can hand the report to a live pi agent running in the
`pi-coms` hub-and-spoke network (one read-only agent per AWS account). The agent
checks the report's claims against live account state and replies with a
structured verdict. When the verdict is not fully confirmed, a second card
launches a deeper investigation threaded on the same conversation.

The integration reuses the existing action-tool lane end to end. There is no
graph change, no interrupt, and no inbound webhook: the web app is always the
caller.

## Flow

```text
aggregateMitigation
  -> proposePiVerification(state)          one verify-with-pi card per assessed estate (max 3)
  -> pendingActions                        rendered by ActionConfirmationCard

user approves "Verify with pi agent"
  -> POST /api/agent/actions               executeAction -> executePiVerify
     -> hub: register short-lived sender   POST /v1/agents/register (name incident-analyzer-<8 hex>, explicit)
     -> hub: list agents                   GET  /v1/agents?include_explicit=true
     -> route: estate agent status online? yes: send to it   no: send to fallback inbox with 24 h ttl (queued)
     -> hub: send                          POST /v1/messages  { prompt, response_schema, conversation_id }
     -> hub: await                         GET  /v1/messages/:id/await?timeout_ms=25000  (sliced, heartbeat between slices)
     -> Zod-validate the reply             PiVerdictSchema
     -> hub: deregister                    DELETE /v1/agents/:sid (always, in finally)
  <- ActionResult { result: { kind: "verdict", ... }, followUpActions?: [investigate-with-pi] }

user approves "Launch pi investigation"
  -> same path with PI_INVESTIGATION_RESPONSE_SCHEMA, the longer budget, and
     conversation_id = the verify message id
  <- ActionResult { result: { kind: "investigation", ... } }
```

## Where the code lives

| Piece | File |
|---|---|
| Contracts: verdict, investigation, JSON Schemas, result payloads | `packages/shared/src/pi-coms-types.ts` |
| Tool enum and `followUpActions` on `ActionResult` | `packages/shared/src/action-types.ts` |
| Config schema (no `.default()`; defaults in the resolver) | `packages/shared/src/config.ts` (`PiComsConfigSchema`) |
| Hub client: register, list, send, sliced await, deregister | `packages/agent/src/action-tools/pi-coms-client.ts` |
| Proposal, routing, prompts, execute flows | `packages/agent/src/action-tools/pi-verifier.ts` |
| Dispatch | `packages/agent/src/action-tools/executor.ts` |
| Card proposal hook | `packages/agent/src/mitigation.ts` (after the LLM proposal block) |
| Follow-up cards appended to the store | `apps/web/src/lib/stores/agent.svelte.ts` (`executeAction`) |
| Rendering | `apps/web/src/lib/components/ActionConfirmationCard.svelte` |

## Routing rule

0. The estate name suffix (`-dev`, `-stg`, `-prd`; `-prod` is read as prd)
   selects the hub before any online check (no cross-environment access, user
   decision 2026-09-06). An unknown suffix, or an environment without a hub in
   `PI_COMS_HUBS`, is a readable error on the card; the analyzer never falls
   back to another environment's hub, and `proposePiVerification` emits no card
   for such an estate (it logs the skip). Cards are ordered by environment, then
   estate.
1. `PI_COMS_ESTATE_AGENT_MAP[estate]` when set, otherwise the estate id itself
   is the agent name (estate ids and pi agent names share the account-alias
   naming convention).
2. If that agent appears in `GET /v1/agents` with status `online`, the send
   goes to it and the call waits for the reply. A `stale` card does not count:
   it is about to be reaped, and a send to it lands in a per-session queue,
   which is not the durable mailbox. If the hub still answers `queued` for an
   online card (its SSE stream just dropped), the client waits anyway: the hub
   flushes that queue on reconnect, and the wait ends in an honest timeout
   error otherwise.
3. Otherwise the send goes to `PI_COMS_FALLBACK_TARGET` (default `ops`) with a
   24 h `ttl_ms`, which is above the hub's 30 min default, so the hub parks it in
   the durable mailbox. The card shows "Queued to ops mailbox"; nobody waits.

## Contracts

The hub only checks that a reply is parseable JSON when `response_schema` is
set. Conformance is enforced here with `PiVerdictSchema` and
`PiInvestigationSchema`; a mismatch is surfaced as an action error, never a
crash. The verify verdict carries per-claim `confirmed | contradicted |
unverifiable` rows with evidence. `needsInvestigation()` is true when the
overall verdict is not `confirmed` or any claim is not confirmed; only then is
the investigate card proposed, with `focus` built from the open claims and the
agent's `recommended_investigation`.

## Timeouts

`await` is polled in 25 s slices (under the hub's 30 s default and its 30 s
stale threshold) with a heartbeat between slices so the sender is never reaped
mid-wait. A slice that expires answers `status: "timeout"` from the awaiter, not
the message, so the client confirms against `GET /v1/messages/:id` before
treating it as terminal. The overall budgets are `PI_COMS_VERIFY_TIMEOUT_MS`
(default 5 min) and `PI_COMS_INVESTIGATE_TIMEOUT_MS` (default 15 min); the
action route stays synchronous for the whole budget.

## Configuration

See the `pi-coms hub` block in `.env.example`. One hub per environment:
`PI_COMS_HUBS` is a JSON map keyed by `dev`, `stg` and `prd`, each entry
carrying `serverUrl` and `authToken` plus optional `project` (default
`default`) and `fallbackTarget` (default `ops`). The single-hub variables
(`PI_COMS_NET_SERVER_URL`, `PI_COMS_NET_AUTH_TOKEN`, `PI_COMS_NET_PROJECT`,
`PI_COMS_FALLBACK_TARGET`) remain as a one-entry map for the environment named
by `PI_COMS_NET_ENVIRONMENT` (default `dev`); a prd estate then gets a "no hub
configured for prd" card error rather than the dev hub. The feature is off
unless one of the two forms is set; a malformed `PI_COMS_HUBS` is a readable
error at execute time and suppresses card proposals with a warn log.

In the hub's directory auth mode the token's principal must allow the name
pattern `incident-analyzer-*`: every action registers a fresh session under
`incident-analyzer-<8 hex of the session id>`, because a directory-mode hub
answers `409 name_taken` for a name a live session already holds, and two
cards approved at the same time would otherwise collide. Mint one
`incident-analyzer` principal per hub with
`just token-create incident-analyzer "incident-analyzer-*" service <profile>`
(root justfile, delegating to `packages/pi-coms`). The client's constructor
takes a `senderPrefix` for other callers (the fleet inbox node registers under
its own prefix), exposes `heartbeat()` and reads the durable inbox with
`mailbox(name, { limit, since })`.

The Agent Memory identity map in `packages/agent/src/memory-backend.ts`
(`AGENT_MEMORY_IDENTITIES`) is explicit: an agent name outside the map throws
at first use instead of silently sharing the `incident-analyzer` user.

The web app's pi-fleet pane (SIO-1650) reads the same `PI_COMS_HUBS` and adds
`PI_COMS_PANE_TOKENS`, `PI_COMS_PANE_SENDER_PREFIX`, `PI_COMS_PANE_AWAIT_MS` and
`PI_COMS_PANE_TIMEOUT_MS`; see `docs/architecture/pi-fleet-pane.md`.

## Security notes

- The analyzer registers as an `explicit` peer, hidden from pool snapshots, and
  deregisters after every action. It never holds an SSE stream and never
  receives prompts.
- Hub replies are rendered by the card as data. They are not appended to the
  conversation and are never fed back into any LLM call.
- The report handed to the agent is the same markdown the user already sees,
  truncated to a fixed character budget, plus the confidence, root-cause
  attribution, and caveats sidecars.
- The pi agents are read-only by IAM policy on their side; the prompts also
  instruct read-only behaviour, but the IAM boundary is the real control.

## Verdict memory (SIO-1651)

A verdict is remembered as a durable key decision, so a later session knows the
estate was checked and how it came out. Both paths write through the same
builder in `packages/agent/src/pi-verdict-memory.ts`, so a verdict is recorded
identically however it was asked for:

- the SIO-1635 card path (`executePiVerify`), on a successful reply, and
- the SIO-1651 `pi-handoff` workflow's verify step.

**Structured fields only.** `recordKeyDecision` renders the decision text into
`key-decisions.md` and forwards it to the Agent Memory backend as a durable
fact, and that text is rendered into the next turn's prompt. A verdict carries
free text the spoke's model wrote (`summary`, `claims[].evidence`,
`additional_observations`, `recommended_investigation`) and NONE of it may
cross that boundary, because a hub reply is data and must never become an LLM
input. Only enums, counts and ids are written:

```text
pi verify <estate>: <verdict> (claims: N confirmed, N contradicted, N unverifiable) target <target> msg <msg_id>
```

with annotations `{ kind: "pi-verify", estate, target, verdict, msg_id,
claims_confirmed, claims_contradicted, claims_unverifiable }` for filtered
recall. No `rationale` (it is rendered free text) and no TTL (a verdict is
durable). A queued send writes nothing: there is no verdict yet. The write is
wrapped so a memory failure can never change the outcome of a verify that
already succeeded, and `pi-verdict-memory.test.ts` asserts that no
spoke-authored text reaches either the decision line or the annotations.

## The pi-handoff workflow (SIO-1651)

`agents/incident-analyzer/workflows/pi-handoff.yaml` chains two steps, and is
the first production wiring of the skillflow executor's `graph` and `agent`
step handlers:

- `analyze` (`graph: true`) READS the closing turn's completed report. It does
  not re-invoke the pipeline: `classify` already snapshots the prior
  investigation into `closingReport` precisely so closing an incident never
  re-runs a multi-minute fan-out, so re-invoking would repeat a full 7-agent
  investigation to reproduce a report that already exists.
- `verify` (`agent: aws-spoke`) hands that report to the estate's spoke through
  the same `runHubTask` path the card uses, so the two cannot drift.

It runs detached POST-TURN from the stream route, next to the incident-close
chain and under the same contract: never awaited, never able to affect the
response, every failure folded into a soft result. Gated by
`PI_HANDOFF_ENABLED`, ON by default since SIO-1655 (set it to `false` or `0` to
disable); the run skips anyway when no hub is configured. The estate and the report are read from one
pre-prune state snapshot (`getPiHandoffRequest`), and the report is captured
there rather than re-read later, because `pruneThreadState` rewrites the
checkpoint in between. One hand-off per close: the first assessed estate.

Registration uses the analyzer's own principal (`incident-analyzer-*`), not a
separate `pi-fleet` one, so the workflow needs no additional hub token.

## Where hub replies may reach a model (SIO-1655)

The invariant on this page -- hub replies are rendered as data and never fed
into an LLM call -- holds for every path documented above, and for the 2b inbox
node and the SIO-1651 workflow.

The ONE exception is the Phase 2c fleet console graph
(`agents/pi-fleet-console/`, gated by `PI_FLEET_GRAPH_ENABLED` and a configured
hub), whose
purpose is to summarize replies from several spokes. There, replies reach the
model only through `wrapUntrusted` in `packages/agent/src/pi-fleet/tools.ts`:
fenced, origin-labelled, capped, and framed as evidence that must be reported
rather than obeyed. See `pi-fleet-third-graph.md`. No other code path may feed a
hub reply to a model.

## Out of scope for SIO-1635

Persistent peer registration so hub agents can push to the analyzer, async
action polling, and verification for non-AWS data sources. (Feeding the verdict
into later turns was out of scope for SIO-1635 and is now implemented by
SIO-1651; see "Verdict memory" above.)
