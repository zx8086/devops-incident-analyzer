# pi-fleet pane (SIO-1650)

The incident analyzer's web app carries a second, thin inspector next to the
incident chat: a pane that lists the live pi-coms spokes on every configured
hub and lets the operator send one prompt to one spoke. The chat stays the
historical analysis; the pane is the live question. Nothing crosses between
them: a spoke's reply is rendered as data and never enters an LLM call.

Decision (2026-09-06, `pi-fleet-gitagent-feasibility.md` Phase 2a): the thin
pane first; a third LangGraph graph stays a later option; the fleet inbox
enrichment node is SIO-1652.

## Where the code lives

| Piece | Path |
|---|---|
| Hub access (server) | `apps/web/src/lib/server/pi-fleet.ts` |
| Error envelope | `apps/web/src/lib/server/pi-fleet-http.ts` |
| Route contracts (browser-safe Zod) | `apps/web/src/lib/pi-fleet-types.ts` |
| Routes | `apps/web/src/routes/api/pi/agents`, `.../messages`, `.../mailbox` |
| State (pure) | `apps/web/src/lib/stores/pi-fleet-reducer.ts` |
| Store (runes) | `apps/web/src/lib/stores/pi-fleet.svelte.ts` |
| Component | `apps/web/src/lib/components/PiFleetPane.svelte` |
| Page wiring | `apps/web/src/routes/+page.svelte` (header toggle, split row) |
| Hub client | `packages/agent/src/action-tools/pi-coms-client.ts`, exported from the `@devops-agent/agent` barrel |

The web app does not depend on `@devops-agent/pi-coms`; the client and its
types reach it through the agent package.

## Routes

| Route | Hub traffic | Returns |
|---|---|---|
| `GET /api/pi/agents` | `GET /v1/agents?include_explicit=true` per hub, bearer only, no registration | `configured`, `senderPrefix`, `awaitMs`, `totalBudgetMs`, one row per hub with its peers (`online`, `stale`, `offline`), or the hub's error inline. SIO-1665: `monitor-*` registrations are dropped by name (`spokesOnly`); a monitor has no model and cannot answer a prompt, and its reports reach the pane only through the inbox |
| `POST /api/pi/messages` | register `<prefix>-<8 hex>` on the peer's hub, `POST /v1/messages` (no `response_schema`), one `GET /v1/messages/:id/await` slice, deregister | `msgId`, `sender`, `status`, `response`, `error`, `sentAt` |
| `GET /api/pi/messages?environment=&msgId=` | one more await slice from an unregistered client | `status`, `response`, `error` |
| `GET /api/pi/mailbox?environment=&name=&limit=` | `GET /v1/mailbox` | the durable inbox (the hub's fallback target by default) |

The pane is hidden unless `GET /api/pi/agents` reports `configured: true`. A
configuration error (malformed `PI_COMS_HUBS`, `PI_COMS_PANE_TOKENS` or a
budget) is a 500 with the message, never a silently empty pane.

## Environments and hubs

Hubs are per environment (`PI_COMS_HUBS`, SIO-1635 Phase 0). The pane lists
each hub separately and sends only to the hub the peer was listed from; the
`environment` field on every request names it and the server refuses an
environment without a hub (404). There is no cross-environment path.

## Waiting for a reply

The hub client waits in 25 s slices with a heartbeat between them (SIO-1635).
The pane keeps every HTTP request to one slice (`PI_COMS_PANE_AWAIT_MS`,
default 25000, capped at 60000): the send route returns after the first slice
with `budget_exhausted` when the spoke has not answered, and the browser
re-polls `GET /api/pi/messages` until the message is terminal (`complete`,
`error`, `timeout`) or the pane budget (`PI_COMS_PANE_TIMEOUT_MS`, default
300000) is spent, at which point the entry reads "no reply from <spoke> within
N s". A spoke that goes offline mid-wait therefore yields a readable timeout,
never a hung request, and no request outlives the SvelteKit adapter's limits.

## The pane principal

Directory-mode hubs bind names to principals. The pane registers senders as
`pi-fleet-<8 hex>` by default, so each hub needs the principal:

```bash
just token-create pi-fleet "pi-fleet-*" service <profile>
```

The printed token goes into `PI_COMS_PANE_TOKENS` keyed by environment. When
that variable is unset the pane uses each hub's own token from `PI_COMS_HUBS`,
which is right for token-mode hubs (a local `just coms-net-server`) or when
`PI_COMS_PANE_SENDER_PREFIX=incident-analyzer` reuses the analyzer's principal.
Registrations are `explicit: true`, so the pane never appears in peer listings
and nobody can address it.

## Replies are data

The reply is whatever the hub stored: a string is shown verbatim, anything else
as pretty-printed JSON in a `<pre>`, with the attribution "Reply from <spoke>
via <sender> on the <environment> hub, message <id>". It is not parsed against
a schema, not executed, and never handed to the analyzer graph or any other
LLM call. The verify and investigate cards (SIO-1635) remain the only path
where a hub reply is validated, and there only against the analyzer's own
`response_schema`.

A `complete` reply with an empty body is rendered as "(empty reply from <spoke>)" rather than nothing, and since SIO-1678 the hub stores such a submission as `error: empty_reply`, so in practice the pane shows the error line instead.

## Tests

- `apps/web/src/lib/server/pi-fleet.test.ts`: the real client against a
  scripted fetch (network boundary): per-hub tokens, hub isolation on failure,
  register/send/await/deregister order, one-slice `budget_exhausted`, the
  environment refusal, mailbox mapping.
- `apps/web/src/routes/api/pi/*/server.test.ts`: validation and envelopes with
  the server module mocked.
- `apps/web/src/lib/stores/pi-fleet-reducer.test.ts`: state transitions,
  polling cut-off, the timeout copy, reply formatting.
- `apps/web/src/lib/components/PiFleetPane.test.ts`: SSR shape checks.

Manual: start a local hub (`just coms-net-server`), point `PI_COMS_HUBS` at
it, register a peer (`just coms <name>`), open the pane, send a prompt; stop
the peer mid-wait and watch the entry expire.
