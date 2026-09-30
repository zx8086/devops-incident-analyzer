# pi-fleet pane (SIO-1650)

The incident analyzer's web app carries a second, thin inspector next to the
incident chat: a pane that lists the live pi-coms account spokes on every
configured production hub (SIO-1696: `listFleetAgents` keeps only hubs whose
`environment` is `prd`) and lets the operator send one prompt to one spoke, or
to every spoke in scope. The chat stays the historical analysis; the pane is
the live question. A spoke's reply is rendered as data and never enters an LLM
call.

One thing does cross, in one direction (SIO-1778): approving a verify or
investigate card sends through the pane's store, so the send, the wait and the
reply show up here as a labelled entry while the card keeps the structured
result. Nothing flows from the pane back into the analysis.

Decision (2026-09-06, `pi-fleet-gitagent-feasibility.md` Phase 2a): the thin
pane first; a third LangGraph graph stays a later option; the fleet inbox
enrichment node is SIO-1652.

## Where the code lives

| Piece | Path |
|---|---|
| Hub access (server) | `apps/web/src/lib/server/pi-fleet.ts` |
| Error envelope | `apps/web/src/lib/server/pi-fleet-http.ts` |
| Route contracts (browser-safe Zod) | `apps/web/src/lib/pi-fleet-types.ts` |
| Routes | `apps/web/src/routes/api/pi/agents`, `.../messages`, `.../mailbox`, `.../actions` |
| State (pure) | `apps/web/src/lib/stores/pi-fleet-reducer.ts` |
| Store (runes) | `apps/web/src/lib/stores/pi-fleet.svelte.ts` |
| Component | `apps/web/src/lib/components/PiFleetPane.svelte` |
| Verdict / investigation view | `apps/web/src/lib/components/PiReplyBody.svelte` (SIO-1789) |
| Follow-scroll rule | `apps/web/src/lib/components/pi-fleet-scroll.ts` (SIO-1794, SIO-1800) |
| Page wiring | `apps/web/src/routes/+page.svelte` (header toggle, split row) |
| Hub client | `packages/agent/src/action-tools/pi-coms-client.ts`, exported from the `@devops-agent/agent` barrel |

The web app does not depend on `@devops-agent/pi-coms`; the client and its
types reach it through the agent package.

## Routes

| Route | Hub traffic | Returns |
|---|---|---|
| `GET /api/pi/agents` | `GET /v1/agents?include_explicit=true` per hub, bearer only, no registration | `configured`, `senderPrefix`, `awaitMs`, `totalBudgetMs`, one row per hub with its peers (`online`, `stale`, `offline`), or the hub's error inline. SIO-1665: `monitor-*` registrations are dropped by name (`spokesOnly`); a monitor has no model and cannot answer a prompt, and its reports reach the pane only through the inbox |
| `POST /api/pi/messages` | register `<prefix>-<8 hex>` on the peer's hub, `POST /v1/messages` (no `response_schema`), one `GET /v1/messages/:id/await` slice, deregister | `msgId`, `sender`, `status`, `response`, `error`, `sentAt` |
| `GET /api/pi/messages?hubKey=&msgId=` | one more await slice from an unregistered client | `status`, `response`, `error` |
| `GET /api/pi/mailbox?hubKey=&name=&limit=&estates=` | `GET /v1/mailbox` | the durable inbox (the hub's fallback target by default), plus `missingDigest` and `windowTruncated`; each message carries `isDigest`. With `estates` present the read is digest-anchored, see "The ops inbox" |
| `POST /api/pi/actions` (SIO-1778) | as the ANALYZER principal (`incident-analyzer-<8 hex>`, not the pane's): register, list, `POST /v1/messages` WITH the card's `response_schema`, deregister | `started`, `hubKey`, `target`, `msgId`, `prompt`, `budgetMs`; or the `ActionResult` at once for a mailbox send or a refusal |
| `GET /api/pi/actions?msgId=` (SIO-1778) | one await slice from an unregistered client | `pending`, or the `ActionResult` built from a reply validated against the analyzer's schema |

The pane is hidden unless `GET /api/pi/agents` reports `configured: true`. A
configuration error (malformed `PI_COMS_HUBS`, `PI_COMS_PANE_TOKENS` or a
budget) is a 500 with the message, never a silently empty pane.

## Environments and hubs

Hubs are configured in `PI_COMS_HUBS` (SIO-1635 Phase 0). Since SIO-1666 a hub
is identified by its KEY, and the environment it serves rides along as an
attribute: two hubs may share an environment, and a peer name is only unique
within its hub. The pane lists each hub separately and sends only to the hub
the peer was listed from; every request names it by `hubKey`, and the server
refuses an unknown key with a 404 that lists the configured ones. There is no
cross-hub path.

The pane is production incident triage, so the listing keeps only hubs whose
`environment` is `prd` (SIO-1696). That filter is on the listing alone: the
send and mailbox paths still resolve every configured hub, so an operator
addressing a dev spoke through the hub CLI is unaffected.

A hub that cannot be reached keeps its row with the reason. Instead of the
browser's bare "fetch failed", the row names the hub and its URL, and for a
localhost URL adds that the SSM tunnel is probably down with the command that
fixes it, `just hub-tunnel <hubKey>` (SIO-1701).

## What the pane lists, and who a prompt reaches

- **Account spokes only.** `monitor-*` registrations are dropped by name
  (SIO-1665). An operator console registered on the hub is dropped too: a spoke
  is named for the estate it serves, so anything not in the hub's own `estates`
  list is not one (SIO-1703).
- **The estate selector is the scope.** The pane receives the AWS estates
  selected for the investigation and shows only the spokes named for them
  (SIO-1703). No estate selected means no account is in scope, so no spoke is
  addressable and the pane says why (SIO-1704). A hub whose list the scope
  emptied reads "No spoke here is in the selected scope", not "no spokes are
  registered".
- **The hub row is labelled `hub`.** The hub account runs a read-only spoke
  like every other account, so its name appears twice meaning two things. The
  header row carries a `hub` role badge beside the environment badge and shows
  the hub key; the hub-side `project` namespace is not shown (SIO-1707,
  SIO-1703).
- **No spoke selected sends to every spoke in scope.** With a spoke selected
  the prompt goes to it. With none, it goes to each spoke the pane is showing,
  one entry per spoke, so a fan-out reads as several attributed replies and one
  spoke failing leaves the others intact. The box names the count ("To all N
  spokes in scope") so a scoped fan-out is never mistaken for the whole fleet
  (SIO-1708).
- **One fleet control.** The header Pi icon toggles this pane and the box in it
  addresses the spokes; there is no separate "open the fleet console" button
  (SIO-1662, SIO-1706). The toggle is offered only while the agent is
  `incident-analyzer` or `pi-fleet-console` and a hub is configured.

## The ops inbox

Each hub row has an `Inbox <fallback target>` button that reads the hub's
durable inbox through `GET /api/pi/mailbox`.

- **Digest-anchored, scoped server-side (SIO-1705).** The pane passes the
  selected estates as `estates`. The server then reads a 200-row window and
  returns, per estate, that estate's newest daily digest and everything after
  it. The scope is applied on the server because it decides which rows to
  fetch: filtering after a fixed cap let another account's traffic push an
  estate's digest out of the window. An estate with no digest in the window
  keeps all its rows and is named in `missingDigest`; a full window sets
  `windowTruncated`. Without `estates` the old newest-20 read is kept.
- **The digest is marked server-side (SIO-1714).** `anchorOnDigest` sets
  `isDigest` on the anchor row as it slices, so the pane can tell the report of
  record from the messages after it without re-matching the text.
- **Age, not delivery status (SIO-1730).** A monitor report is one-way, so
  nothing ever claims it and its status read "queued" forever. The row shows
  the report's age; the status appears only when it is exceptional.
- **Reports render as sanitized markdown (SIO-1709).** "Data" means never
  model input, not never formatted. The HTML is sanitized in the browser and on
  the SSR path, because the pane server-renders agent-authored text.

## Layout and scrolling

- **One scroll container (SIO-1721).** The spoke picker sizes to its content
  and is sticky at the top of that container, so the spoke list and the Inbox
  button stay reachable however far a long report is scrolled. This replaced
  the capped picker region SIO-1715 tuned.
- **Entries run oldest first (SIO-1794).** A new entry is brought into view
  when the entry count grows; a status patch or an arriving result does not
  move a reader who scrolled up.
- **Follow-scroll for the waiting reader (SIO-1800).** An entry is added as a
  short "Waiting" stub, so the reply used to land below the fold. A reader who
  was at the bottom before the DOM grew follows the reply; one who scrolled up
  is never moved. The rule is `pi-fleet-scroll.ts`.

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

The printed token goes into `PI_COMS_PANE_TOKENS`, a JSON map keyed by hub key
(SIO-1666: two hubs sharing an environment need two different tokens). When
that variable is unset the pane uses each hub's own token from `PI_COMS_HUBS`,
which is right for token-mode hubs (a local `just coms-net-server`) or when
`PI_COMS_PANE_SENDER_PREFIX=incident-analyzer` reuses the analyzer's principal.
Registrations are `explicit: true`, so the pane never appears in peer listings
and nobody can address it.

## Replies are data

The reply is whatever the hub stored, with the attribution "Reply from <spoke>
via <sender> on hub <hubKey>, message <id>". The reply type decides how it is
shown (SIO-1709): a string is the agent's prose and renders as sanitized
markdown; an object is a schema-constrained payload and stays pretty-printed
JSON in a `<pre>`, because markdown would eat its braces. The one exception is
an object that is a pi verdict or investigation, which `PiReplyBody` renders as
one, with no raw JSON beside it (SIO-1789, SIO-1794). `PiReplyBody` uses text
interpolation only, never `{@html}`. A free-form reply is not parsed against a
schema, not executed, and never handed to the analyzer graph or any other LLM
call. The verify and investigate cards (SIO-1635) remain the only path
where a hub reply is validated, and there only against the analyzer's own
`response_schema`.

That still holds with SIO-1778. A card-originated entry is displayed in the pane,
but it is sent and validated by `/api/pi/actions` in `pi-verifier.ts`, not by the
free-form `/api/pi/messages` path, which carries no `response_schema` and parses
nothing, exactly as before. What the pane shows for such an entry is the payload
that already passed `PiVerdictSchema` / `PiInvestigationSchema`. The card prompt
embeds the report (up to 12k characters), so it is collapsed by default. These
entries do not need `PI_COMS_PANE_TOKENS`: without a configured pane the action
runs the same way and only the card shows it.

Since SIO-1789 the pane owns the rendered view of that verdict or
investigation. The card only sends: it keeps a one-line status with the same
verdict chip and raises any follow-up cards, and it renders the full result
itself only when there is no pane to show it.

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
