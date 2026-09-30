# Fleet inbox enrichment node (SIO-1652)

`fetchFleetInbox` gives the historical incident analyzer the live fleet's recent
notes without spending a spoke turn. Right before the report prompt is built,
it reads each assessed AWS estate's pi-coms inbox and the hub's `ops` inbox for
the incident window, writes a typed `fleetInboxDigest` sidecar, and the report
is followed by a Fleet inbox card. The verify card (SIO-1635) stays the active
live check; this node is the passive one. The Phase 2a pane (SIO-1650) is the
operator's direct line to a spoke; this node never sends anything.

## Placement and gating

- Registered always, reached unless `PI_COMS_INBOX_ENABLED` is `"false"` or
  `"0"` (SIO-640 edge-gate idiom). SIO-1655 flipped this to ON by default
  (kill-switch semantics: `false` or `0` disables); the node self-skips when no
  hub is configured, so a deployment without pi-coms is unaffected. `packages/agent/src/graph.ts`
  wraps `routeAfterAlignment`: its plain `"aggregate"` answer is redirected
  through `fetchFleetInbox` when enabled; retry `Send`s pass through untouched,
  and the validate retry loop re-enters at `aggregate` directly, so the node
  runs once per turn.
- It runs BEFORE `aggregate` on purpose: `aggregate` builds and invokes the
  report prompt, so a node after it could not feed this turn's context. The
  ticket's original "after aggregate" placement was revised for that reason.
- With `PI_COMS_HUBS` unset the node is a pure no-op. Enabled with no assessed
  estate, it clears any prior-turn digest (replace reducer).

Node count: `grep -c addNode packages/agent/src/graph.ts` = 32 (22 base).

## What is read

| Read | From | Filter |
|---|---|---|
| The estate's own inbox (`name=<estate>`) | the hub that claims the estate (`selectHubForEstate`) | window, self-sender exclusion |
| The hub's `ops` inbox (its `fallbackTarget`), once per hub | same hub | window, self-sender exclusion, attribution to the estate |

Estates come from `estatesFromState` (the router's list, else the `estate:`
deploymentId tags on the AWS results), minus every estate where a complete ECS
enumeration proved the focus service is not deployed (SIO-1777): an inbox fetch
for an estate the report itself ruled out is noise. No cross-environment
access: an estate that `selectHubForEstate` cannot bind to exactly one hub gets
an error row and is never read elsewhere.

`GET /v1/mailbox` returns mailbox rows and terminal conversations only. The
node reads the incident WINDOW, not the newest page (SIO-1828, `readInbox` in
`fleet-inbox-node.ts`). `windowFloorCursor(window.from)` turns the window start
into a ULID floor cursor, and with that `since` the hub pages forward in
ascending id order, so the walk starts at the window:

- pages of `MAILBOX_READ_LIMIT` = 100 rows, at most `MAILBOX_MAX_PAGES` = 5;
- one deadline for the whole walk (`PI_COMS_INBOX_TIMEOUT_MS`), so paging cannot
  extend the per-estate budget: each page gets what is left of it;
- the walk stops on a short page (the end of the mailbox) or once a page's
  newest row is past the window end, so a complete window is never called
  capped;
- when the page cap or the deadline stops it with rows still unread, the read is
  flagged `truncated` and the estate's error row says "read capped before the
  end of the window". A later page that fails keeps the pages already read and
  carries the cause (an auth or 5xx failure is not reported as a benign limit);
  a failure before any page is a failed read.

Before this the node read the newest 100 rows without `since`, so an incident
older than those rows read as an empty inbox. That newest-first read remains
only as the fallback for a window start that cannot be turned into a cursor.
Rows are still filtered by `created_at` against the window. The window is the
investigation focus, else the normalized incident window, else the last 24 h.

Attribution of an `ops` row to an estate: the monitor header names the
estate's account (`aws-<accountId>`, matched against the account taken from
`assumedRoleArn` in `AWS_ESTATES`), or the sender is the estate's agent name
(`estateAgentMap`, else the estate id) or `monitor-<agent>`. Unattributable
`ops` rows are dropped. The fleet's monitors report to `ops`
(`PI_MONITOR_REPORT_TO`, set by `deploy/bootstrap/agent-bootstrap.sh`).

Self-traffic is excluded by sender prefix: `incident-analyzer-` (the verify and
investigate cards) and `pi-fleet-` (the pane) by default,
`PI_COMS_INBOX_EXCLUDE_SENDERS` overrides.

## Classification

The monitor's message format is deterministic
(`packages/pi-coms/scripts/monitor/report.ts`), and its header shapes live in
the shared contract, `packages/pi-coms/contracts/report.ts`. `parseMonitorHeader`
accepts three kinds of first line, which is what `parseMonitorReport` reads:

| Header | Monitor kind | Inbox kind | Finding count |
|---|---|---|---|
| `[<sev>] aws-<accountId>: <n> finding(s)` | `incident-report` | `monitor-report` | the header's `<n>` |
| `[<sev>] aws-<accountId> daily digest ...` | `daily-digest` | `daily-digest` | null (a 24 h rollup) |
| `[<sev>] aws-<accountId> suppression review ...` | `suppression-review` | `suppression-review` | null |

`<sev>` is `info`, `warn` or `critical`. The monitor writes four header shapes
in all (the digest has two, one carrying `(since <ts>)`), and both digest
shapes match the one digest pattern. Since SIO-1832 any of them may carry the
friendly account name after the id, `aws-<accountId> (<name>)`, when the host
knows it. The name group is optional on purpose: the fleet rolls out host by
host, so both forms sit in the mailbox at once, and a required group would drop
every report from a spoke on the older bundle. A reader falls back to the
account id when the name is absent.

Two rules bound what counts as a monitor message:

- **The sender must be a monitor.** `classifyMessage` parses a header only when
  the sender name has the `monitor-` prefix. A header is untrusted text, and any
  operator or spoke message quoting one would otherwise be counted and
  severity-rated as monitor traffic (SIO-1825).
- **Finding lines are read for incident reports only.** The
  `- (<sev>/<family>) <resource>: <summary>` lines, with their indented
  continuation lines, give severity, family, resource and alarm names (the
  `resource` of `alarm` findings). A digest's notable lines have the same shape
  behind an indent and are a rollup of findings already reported, so a digest's
  `findings[]` stays empty and nothing is double-counted.

A terminal row (`complete`, `error`, `timeout`) that is not a monitor message
is a `conversation`; anything else is `other`.

All three monitor kinds enter the digest (SIO-1825/1826/1827); `buildEstateDigest`
drops only `conversation` and `other`. The earlier incident-only header pattern
silently dropped every daily digest and suppression review, which left the card
reading "0 monitor report(s)" on a live account, and the daily digest is the
monitor's report of record and its dead-man signal. An estate inbox is mostly
the monitor's own requests to its spoke (one per report, the diagnose prompt
and none of the findings); those are still dropped, because they doubled the
card and used up the per-estate entry cap without adding a fact. Entries are
ordered focus first, then incident reports ahead of digests, then newest first,
so when the 20-entry cap bites it is the fresh incident reports that survive.

## Scoping to the focus services (SIO-1815)

The hub's mailbox read has no filter, so scoping happens over the rows already
read. Every monitor finding carries a `family` (the monitor's category: `alarm`,
`logs`, `health`, `drift`, `tasks`, ... 21 today, kept as a string so a newer
monitor's families are not dropped, SIO-1814) and a `resource` (an AWS
identifier). Both are carried into the digest per report; the finding's summary
and the spoke's diagnosis are free text and are not.

A finding is a **focus finding** when `matchesFocus` (the predicate every
findings card scopes with) matches the incident's focus services against
everything the monitor wrote about it: resource, summary and continuation lines.
The resource alone is not enough. `feed-service` logs to the shared
`/ecs/fargate/shop-prd-log-group`, and only the summary and the spoke's
`cause:` line name it. That text is matched and then discarded.

When focus services exist:

- reports naming one lead the entry list, ahead of newer reports about other
  services, so the 20-entry cap never cuts them;
- `counts.focus`, per-family `focus` counts and `digest.focusServices` record the
  scope;
- the card shows the focus reports and folds the rest of the account's inbox
  under one `<details>`;
- the prompt lists the focus findings as `(severity/family) resource xN`.

With no focus services the digest is unscoped: newest first, nothing marked.
A monitor-side `service` tag would make this exact rather than textual; it ships
in the fleet bundle and is not part of this change.

## What reaches the prompt

Only `summarizeFleetInboxForPrompt` output: per estate, monitor report counts by
severity, finding categories, the focus findings' category and resource, alarm names, the latest timestamp, and any read error. It never
reads `excerpt`, `sender` or a body. Inbox bodies are untrusted input (spoke
model output, operator free text); the capped excerpt reaches the browser only,
rendered as inert text by `FleetInboxCard`. The section tells the model the
digest is corroboration, not evidence, and not to reproduce it.

## Budgets and failure

Each read is bounded by `PI_COMS_INBOX_TIMEOUT_MS` (default 5000) and all reads
run in parallel. A failing or hanging hub becomes an error row on that estate
(the estate inbox and the `ops` inbox fail independently); the turn never
fails. Errors are logged at warn.

## Where the code lives

| Piece | Path |
|---|---|
| Pure helpers | `packages/agent/src/fleet-inbox.ts` |
| Node | `packages/agent/src/fleet-inbox-node.ts` |
| Graph wiring | `packages/agent/src/graph.ts` (`routeAfterAlignmentThenInbox`) |
| State slot | `packages/agent/src/state.ts` (`fleetInboxDigest`) |
| Prompt section | `packages/agent/src/aggregator.ts`, `prompt-context.ts`, `orchestrator-prompt-assembly.ts` |
| Schemas | `packages/shared/src/pi-coms-types.ts` (`FleetInboxDigestSchema`), SSE event `fleet_inbox` in `agent-state.ts` |
| Web | `apps/web/src/lib/server/sse-pump.ts`, `stores/agent-reducer.ts`, `stores/agent.svelte.ts`, `components/FleetInboxCard.svelte`, `node-labels.ts` |

## Tests

`packages/agent/src/fleet-inbox.test.ts` (parser, classification, filters,
prompt summary asserted free of body text), `fleet-inbox-node.test.ts` (two
hubs, isolation, timeout, environment refusal, self-sender exclusion),
`orchestrator-prompt-assembly.test.ts` (byte identity), and in `apps/web` the
pump, reducer and card tests.
