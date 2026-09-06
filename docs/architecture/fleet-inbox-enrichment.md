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
  `"1"` (SIO-640 edge-gate idiom). SIO-1655 flipped this to ON by default
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
| The estate's own inbox (`name=<estate>`) | the hub of the estate's environment (`selectHubForEstate`) | window, self-sender exclusion |
| The hub's `ops` inbox (its `fallbackTarget`), once per hub | same hub | window, self-sender exclusion, attribution to the estate |

Estates come from `estatesFromState` (the router's list, else the `estate:`
deploymentId tags on the AWS results). No cross-environment access: an estate
whose environment has no hub gets an error row and is never read elsewhere.

`GET /v1/mailbox` returns mailbox rows and terminal conversations only; the node
reads the newest 100 without `since` (with `since` the hub returns the oldest
rows first and caps at 100, which truncates a busy `ops` inbox at the wrong
end) and filters by `created_at` against the window. The window is the
investigation focus, else the normalized incident window, else the last 24 h.

Attribution of an `ops` row to an estate: the monitor report header
(`[<sev>] aws-<accountId>: <n> finding(s)`) names the estate's account, taken
from `assumedRoleArn` in `AWS_ESTATES`, or the sender is the estate's agent
name (`estateAgentMap`, else the estate id) or `monitor-<agent>`. Unattributable
`ops` rows are dropped. The fleet's monitors report to `ops`
(`PI_MONITOR_REPORT_TO`, set by `deploy/bootstrap/agent-bootstrap.sh`).

Self-traffic is excluded by sender prefix: `incident-analyzer-` (the verify and
investigate cards) and `pi-fleet-` (the pane) by default,
`PI_COMS_INBOX_EXCLUDE_SENDERS` overrides.

## Classification

The monitor's report format is deterministic
(`packages/pi-coms/scripts/monitor/report.ts`), so `parseMonitorReport` reads
the header and the `- (<sev>/<family>) <resource>: <summary>` lines: kind
`monitor-report`, severity, finding count, alarm names (the `resource` of
`alarm` findings). A terminal row (`complete`, `error`, `timeout`) is a
`conversation`; anything else is `other`.

## What reaches the prompt

Only `summarizeFleetInboxForPrompt` output: per estate, message counts by kind
and severity, alarm names, the latest timestamp, and any read error. It never
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
