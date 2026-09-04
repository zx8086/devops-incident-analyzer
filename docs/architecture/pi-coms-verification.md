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

See the `pi-coms hub` block in `.env.example`. The feature is off unless both
`PI_COMS_NET_SERVER_URL` and `PI_COMS_NET_AUTH_TOKEN` are set. In the hub's
directory auth mode the token's principal must allow the name pattern
`incident-analyzer-*`: every action registers a fresh session under
`incident-analyzer-<8 hex of the session id>`, because a directory-mode hub
answers `409 name_taken` for a name a live session already holds, and two
cards approved at the same time would otherwise collide. Mint it on the hub
side with `just token-create incident-analyzer "incident-analyzer-*" service`
(pi-coms repo).

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

## Out of scope for SIO-1635

Feeding the verdict into later turns, persistent peer registration so hub
agents can push to the analyzer, async action polling, and verification for
non-AWS data sources.
