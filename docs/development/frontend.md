# Frontend Development

> **Targets:** SvelteKit 2.0 | Svelte 5 | Tailwind CSS v4 | Bun 1.3.9+
> **Last updated:** 2026-09-30

The SvelteKit frontend provides the user interface for the DevOps Incident Analyzer. It renders chat-based interactions, streams agent responses via SSE, and displays pipeline progress across the seven datasources (Elasticsearch, Kafka, Couchbase Capella, Kong Konnect, GitLab, Atlassian, AWS).

---

## App Overview

The frontend lives in `apps/web/` and uses:

- **SvelteKit 2.0** for routing and server-side hooks
- **Svelte 5 runes** (`$state`, `$derived`, `$effect`, `$props`) for reactivity
- **Tailwind CSS v4** with the Tommy Hilfiger brand palette
- **highlight.js** for syntax highlighting in agent markdown responses
- **marked** for markdown-to-HTML rendering

### Route Structure

```
apps/web/src/
  routes/
    +layout.svelte        # Root layout, imports app.css
    +page.svelte          # Main chat page (single-page app)
    api/                  # Server routes (+server.ts), see the table below
    health/+server.ts     # Liveness/info endpoint
  lib/
    agent-ids.ts          # The agent id union + selector labels (client-safe)
    components/           # All UI components
    stores/
      agent.svelte.ts     # Central reactive store
      pi-fleet.svelte.ts  # Fleet pane store
    server/               # Server-only: graph registry, SSE pump, pi-fleet, archify
    composables/
      file-attachments.svelte.ts  # File upload composable
    utils/
      file-utils.ts       # File formatting helpers
  app.css                 # Tailwind directives + custom animations
```

### API Routes

There is one page. Everything else under `apps/web/src/routes/` is a `+server.ts` handler (`find apps/web/src/routes -name '+server.ts'` lists 30):

| Route | Methods | Purpose |
|-------|---------|---------|
| `/api/agent/stream` | POST | Starts a turn on the selected agent's graph and pipes it back as SSE |
| `/api/agent/topic-shift` | POST | Resumes the `detectTopicShift` gate (SIO-751) |
| `/api/agent/iac/resume` | POST | Resumes an elastic-iac interrupt (clarify, plan review, and the sub-flow choices) |
| `/api/agent/landing-zone/resume` | POST | Resumes a Landing Zone interrupt (clarify, plan-review approve/reject/amend) |
| `/api/agent/learning/resume` | POST | Resumes the HIL learning lane's two gates (SIO-1126) |
| `/api/agent/topology` | GET | The compiled graph's own drawable, for the triage pane (SIO-1572) |
| `/api/agent/actions` | POST | Executes one pending action card |
| `/api/agent/actions/available` | GET | The action tools this deployment can run |
| `/api/agent/feedback` | POST | Thumbs up/down to LangSmith, plus the best-effort learning-candidate signal (SIO-1890) |
| `/api/agent/memory/candidates` | GET, POST | The learning review pane: list candidates, apply approve / reject / supersede (SIO-1891) |
| `/api/agent/memory/promote` | POST | Explicit "promote to memory" proposal, opens a review PR (SIO-849) |
| `/api/agent/session/teardown` | POST | Session-end seam, called on "end session" and `beforeunload` (SIO-846) |
| `/api/agents` | GET | The agents this deployment can run, with `surface` and `hasTriageGraph`, plus the `learningReview` flag (SIO-1655) |
| `/api/datasources` | GET | Datasources with connection state, from the debounced UI accessor (SIO-1811) |
| `/api/deployments` | GET | Configured Elastic deployment ids (SIO-649) |
| `/api/aws/estates` | GET | Configured AWS estates, production only (SIO-836, SIO-1696) |
| `/api/diagram` | GET, POST | Archify diagram probe and render (SIO-1876) |
| `/api/events` | GET | SSE of `mcp_replaced` events from the MCP bridge |
| `/api/pi/agents` | GET | Fleet pane peer listing, one row per configured hub (SIO-1650) |
| `/api/pi/messages` | POST, GET | Send one operator prompt to a spoke, then re-await it by message id |
| `/api/pi/mailbox` | GET | A hub's durable ops inbox, optionally digest-anchored by `estates` (SIO-1705) |
| `/api/pi/actions` | POST, GET | Start a verify/investigate card action, then poll it by message id (SIO-1778) |
| `/api/tickets/providers` | GET | Ticket providers available to the Create ticket card |
| `/api/tickets/[provider]` | POST | Create a ticket |
| `/api/tickets/[provider]/projects`, `/epics`, `/issue-types`, `/assignees` | GET | The Create ticket card's pickers |
| `/api/tickets/[provider]/comment` | POST | Post an answer as a comment on the thread's ticket (SIO-1145) |
| `/health` | GET | Always HTTP 200; `status` is `ok` or `degraded` (SIO-482) |

### Development Server

```bash
bun run dev:web           # Starts on port 5173
```

Always check the port is free before starting:

```bash
lsof -i :5173
```

---

## Component Architecture

The app has grown to 42 components (`ls apps/web/src/lib/components/*.svelte`). They fall into six families. The same directory also holds three plain `.ts` helper modules, listed with the panes below.

**Chat shell** — the core conversation UI:

| Component | Responsibility | Key Props |
|-----------|---------------|-----------|
| `ChatMessage` | Renders a single user or assistant message with markdown, progress, feedback, and follow-ups | `message`, `index`, `isLast`, `isStreaming`, `onSuggestionClick`, `onFeedback` |
| `ChatInput` | Text input with auto-resize, Enter-to-submit (Shift+Enter for newline), file attachments, stop button during streaming | `onSend`, `isStreaming`, `onStop`, `attachments` |
| `Icon` | SVG icon wrapper with consistent stroke styling | `name` (typed union), `class` |
| `MarkdownRenderer` | Converts markdown to HTML using `marked`, syntax highlighting via `highlight.js` (json, bash, javascript, yaml) | `content` |
| `StreamingProgress` | Animated pipeline progress showing active/completed nodes during streaming | `activeNodes`, `completedNodes` |
| `CompletedProgress` | Expandable summary of completed pipeline nodes, data source results, and tools used | `responseTime`, `toolsUsed`, `completedNodes`, `dataSourceResults` |
| `FeedbackBar` | Thumbs up/down feedback with copy-to-clipboard + a "Create ticket" action; sends feedback to LangSmith | `content`, `feedback`, `onFeedback` |
| `FollowUpSuggestions` | Clickable follow-up question buttons after an agent response | `suggestions`, `onSelect` |
| `DataSourceSelector` | Toggle bar for selecting active datasources, shows connection status | `dataSources`, `connected`, `selected` (bindable) |

**Findings and topology cards** -- one structured card per datasource result, a per-turn network topology card, plus the pipeline progress card: `ElasticFindingsCard`, `KafkaFindingsCard`, `CouchbaseFindingsCard`, `GitLabFindingsCard`, `AtlassianFindingsCard`, `AWSFindingsCard`, `PipelineProgressCard`. `MlAnomalyExplainerCard` (SIO-1215) renders the elastic ML anomaly-detection explainer (severity bands, contributing influencers) when the elastic-agent surfaces ML anomaly records. `ConfidenceBadge` (SIO-1194) no longer exists: SIO-1810 removed it because it printed the same number as the answer's own "Confidence: ..." line, and the aggregate node now guarantees that line instead. `FleetInboxCard` (SIO-1652) renders the fleet inbox digest as inert data next to the report, labelling the monitor's three kinds differently (incident report, daily digest, suppression review, SIO-1825); see [Fleet Inbox Enrichment](../architecture/fleet-inbox-enrichment.md). `LandingZoneTopologyCard` renders the Landing Zone network, DNS, or DNS-and-route-path view, with a visual state per node (confirmed, proposed, drift, unverified). SIO-1204 adds `NetworkTopologyCard` -- the per-turn network map rendered as an ECharts `graph` series (force layout, roam/zoom, category legend per node kind, dashed CIDR-derived edges, red ring on unhealthy target groups; SSR-guarded dynamic import of modular `echarts/core`, pure option transform in `src/lib/network-chart.ts`). SIO-1457 adds `ApplicationTopologyCard` -- the per-turn application map (services, runtime call edges, kafka consumer edges, datastore/external dependencies) on the same structure: pure option transform in `src/lib/app-chart.ts`, hues disjoint from the network map's, dashed KG prior-knowledge edges, red ring on services above the 5 percent APM error-rate threshold.

`ArchifyDiagram` (SIO-1876) is the Diagram tab inside both of those cards; see "Archify diagrams" below.

**Accessibility -- topology text view (SIO-1459).** Both `NetworkTopologyCard` and `ApplicationTopologyCard` ship a keyboard- and screen-reader-accessible text equivalent of the ECharts canvas: a `<details>`/`<summary>` region (`role="region"`, `aria-label="... text view"`) that lists the same nodes and edges as structured text, so the map is not canvas-only. The ECharts graph stays the primary visual; the text view is the a11y fallback for the same `networkTopology` / `applicationTopology` data.

**IaC / HITL cards** -- the elastic-iac proposer and its human-in-the-loop gates: `PlanReviewCard`, `DriftReportCard`, `ReconcileChoiceCard`, `SyntheticsDriftCard`, `SyntheticsPushChoiceCard`, `FleetUpgradeChoiceCard`, `RenovateTriggerChoiceCard` (the Renovate-trigger choice, with knowledge-graph and memory history for the deployment, SIO-1472/1475), `ActionConfirmationCard`. The Landing Zone agent's gate is `LandingZonePlanReviewCard` (approve, reject with a reason, or amend with instructions; it POSTs to `/api/agent/landing-zone/resume`).

**HIL-learning cards** — the learn-from-ticket lane (see [Agent Pipeline: HIL learning lane](../architecture/agent-pipeline.md#hil-learning-lane)): `LearningMatchCard` (confirm the matched incident), `LearningProposalCard` (per-item approve/reject/edit), `LearningOutcomeCard` (terminal done state).

**Ticket / selectors** — `CreateTicketCard`, `AddCommentCard` (see below), and the scope selectors `AwsEstateSelector`, `ElasticDeploymentSelector`.

**Split-screen panes** -- mounted by `+page.svelte` to the right of the chat column, each behind a header toggle:

| Component | What it shows | Offered when |
|-----------|---------------|--------------|
| `GraphTriagePanel` (SIO-1572) | The running graph, drawn from `/api/agent/topology`, with live node state | the agent's registry entry has `hasTriageGraph` |
| `PiFleetPane` (SIO-1650) | Live account spokes, the prompt box that addresses them, their replies, and the ops inbox; see [Pi Fleet Pane](../architecture/pi-fleet-pane.md) | a pi-coms hub is configured and the agent is `incident-analyzer` or `pi-fleet-console` |
| `PiReplyBody` (SIO-1789) | The rendered pi verdict or investigation inside the fleet pane. `ActionConfirmationCard` uses it only when there is no pane to show the reply | inside `PiFleetPane` |
| `LearningReviewPane` (SIO-1891) | Learning candidates and the approve / reject / supersede actions (see "Learning review pane") | `/api/agents` reports `learningReview` |

Three helper modules sit beside them. Each holds the testable decision for a scroll that is itself browser-only:

- `chat-follow.ts` -- `followAfterScroll`: whether the chat column keeps its newest content in view. Decided from the direction of travel in a scroll event, because content growing under the reader must never look like the reader leaving.
- `pi-fleet-scroll.ts` (SIO-1794, SIO-1800) -- when the fleet pane reveals its newest entry, and the shared `isAtBottom` tolerance.
- `graph-triage-scroll.ts` (SIO-1812) -- when the triage pane centres the running node. `following` is explicit state there, not an at-bottom test, because centring a node leaves the scroller mid-content.

### Component Relationships

```
+page.svelte
  |
  +-- DataSourceSelector     (header bar)
  |
  +-- ChatMessage[]          (message list)
  |     |
  |     +-- MarkdownRenderer (message body)
  |     +-- CompletedProgress (after completion)
  |     +-- FeedbackBar      (after completion)
  |     +-- FollowUpSuggestions (after completion)
  |
  +-- StreamingProgress      (during streaming)
  |
  +-- ChatInput              (footer)
        |
        +-- Icon             (buttons)
```

---

## Create ticket flow (SIO-1124/1139/1145)

The `FeedbackBar` action row includes a **Create ticket** button that opens an inline `CreateTicketCard`. The card lets the user raise a Jira issue seeded from the message: it offers a project typeahead (with a client-side cache), issue type (default Task), an epic picker, and assignee search. The backend is a **provider-agnostic `TicketProvider`** (`packages/agent/src/ticket-providers/`): the Jira provider rides the already-connected Atlassian MCP bridge (`atlassian_createJiraIssue`), so no new credentials or transport are introduced, and the button self-gates on that write tool's presence — it is hidden while the Atlassian MCP is read-only (`ATLASSIAN_READ_ONLY=true`).

Five thin route groups under `apps/web/src/routes/api/tickets/` back the card: provider discovery, project / epic / issue-type / assignee pickers, and issue creation. Once a thread has an associated ticket, the follow-up action becomes **Add as comment** (`AddCommentCard`) instead of Create ticket, posting the answer onto the existing Jira ticket via the same `TicketProvider` seam (SIO-1145). Adding a Linear or GitLab ticket provider later is one module plus one registry entry.

These are the only two user-initiated write paths in the otherwise read-only UI (see the read-only nuance in [system-overview.md](../architecture/system-overview.md)).

---

## Agents and the header control (SIO-1655, SIO-1657)

There are four agents. Their ids live in `apps/web/src/lib/agent-ids.ts` (`AGENT_IDS`, plus the selector's title and subtitle in `AGENT_CHOICES`), a runtime-free module both the server and the client can import. Each id has one descriptor in `apps/web/src/lib/server/graph-registry.ts`:

| Agent | `surface` | `hasConfidence` | `hasDataSources` | `streamsTokens` | `hasTriageGraph` |
|-------|-----------|-----------------|------------------|-----------------|------------------|
| `incident-analyzer` | `mode` | true | true | true | true |
| `elastic-iac` | `mode` | false | false | false | true |
| `landing-zone-terraform` | `mode` | false | false | false | true |
| `pi-fleet-console` | `contextual` | false | false | false | false |

The page does not hardcode this list. It fetches `/api/agents`, which returns the agents this deployment can run (`listSelectableAgents()` drops `pi-fleet-console` unless `PI_FLEET_GRAPH_ENABLED` is on and a pi-coms hub is configured). The header control cycles the `mode` agents in registry order. The fleet console is `contextual`, never a mode, so the control never cycles to it; if it is the current agent the control is the way back to the default agent. Note that `cycleAgent` is the only caller of `agentStore.switchAgent` in the page, and the separate "open the fleet console" button was removed (SIO-1662, SIO-1706): the operator's fleet entry point is the fleet pane, whose own box addresses the spokes directly through `/api/pi/messages`, not the `pi-fleet-console` graph. If `/api/agents` fails, the page falls back to the three always-available agents.

Ask a capability question through the descriptor flag, not through `agentName === "..."`. Adding an agent is one id in `agent-ids.ts` plus one registry entry. `isIac` in `+page.svelte` still gates rendering that is specific to the IaC agent (drift reports, the plan-review card).

Switching agents starts a fresh conversation (`switchAgent` calls `clearChat`), and the page clears the fleet pane with it (SIO-1811).

---

## Archify diagrams (SIO-1876..1879)

`NetworkTopologyCard` and `ApplicationTopologyCard` carry a **Diagram** tab beside the ECharts map, rendered by `ArchifyDiagram.svelte`.

- **Flag.** `isArchifyEnabled()` in `apps/web/src/lib/server/archify/flag.ts` is the one read point for `ARCHIFY_DIAGRAMS_ENABLED`. It defaults ON; only `false` or `0` turns the tab and the route off. The component asks `GET /api/diagram` once (`{ enabled }`) to decide whether to show the tab, so the flag stays server-side.
- **Render.** `POST /api/diagram` takes `{ view, theme, topology }`, re-validates the topology like any client input, and bounds it to the builders' own node and edge caps plus a 512 KB body cap read while streaming (the route is unauthenticated). `to-archify.ts` converts the topology, and `render.ts` runs the vendored Archify CLI (`vendor/archify/bin/archify.mjs`) as a child process. The directory is found by walking up from the working directory, or taken from `ARCHIFY_DIR` when set. Results are cached by input hash; a crash or a busy refusal (HTTP 503) is not cached. A diagram that fails validation returns 422 with diagnostics.
- **Embed.** The HTML runs in a sandboxed `srcdoc` iframe (`sandbox="allow-scripts allow-downloads"`), an opaque origin. `embedHtml` in `render.ts` injects a small `<style>` fit rule and answers the theme query, because a `srcdoc` iframe has no URL query to carry `?embed=1&theme=`. This is the second sanctioned exception to the Tailwind-only rule (SIO-1878): it styles a vendored document the app does not author, where Tailwind is not loaded.
- **Sizing and expand.** The response carries `x-archify-viewbox`, and the card sizes the frame to the diagram's aspect ratio. The expand button asks the card for its dialog (SIO-1879): the card owns the expanded state, focus save and restore, Escape and the focus trap, so there is one dialog per card.

---

## Surface vocabulary and panes

Conventions the UI holds to since SIO-1808..1812. Break one and the app stops reading as one surface.

- **Square surfaces (SIO-1808).** No text-bearing `rounded-full` pill: target chips are squared (`rounded`), and only status dots, avatars, spinners and progress tracks stay round. The state badges in `LandingZoneTopologyCard`, added later, are the one text pill that still uses `rounded-full`.
- **A binary state gets a binary cue (SIO-1810).** Selection is fill versus outline, never a hue or a tint. A selected ready target chip is solid navy with white text (`bg-tommy-navy text-white`); unselected is white with a grey border. SIO-1809's weight-and-tint cue was superseded by this.
- **Health owns red and yellow.** In `DataSourceSelector.classFor`, `down` and `misidentified` are red and not selectable; `unready` and `replaced` are yellow, filled when selected and outlined when not, with a `yellow-900` foreground (white on `yellow-500` fails contrast). Every branch carries an explicit border so the chip is the same size in every state.
- **One plane.** The panes, the page root and the gate cards share the chat column's white surface. Do not reintroduce a cream pane carrying white cards.
- **No duplicate confidence (SIO-1810).** The answer's own "Confidence: ..." line is the only place the score is shown.
- **A starved probe is not a degraded datasource (SIO-1811).** `/api/datasources` reads `getServerStatesForUi()`, which debounces a single `unready` probe; `/health` keeps the raw `getServerStates()` so an operational endpoint reports a real degradation on first sight. Do not fold the two together.
- **The header row is one family (SIO-1812).** The pane toggles and Clear share `HEADER_BUTTON`, `HEADER_BUTTON_ON` and `HEADER_BUTTON_OFF` in `+page.svelte`: active is a white overlay, inactive a dimmed icon. Red is reserved for Clear's hover. Clear empties the fleet pane as well as the chat.
- **Panes and gate cards.** The chat column is a flex column: messages, then the HITL gate region (capped at `max-h-[55vh]`, scrolling internally), then the prompt bar. Gate cards live inside that column, so a tall plan review never runs under a pane and the panes stay on screen while a gate is up (SIO-1658, SIO-1659). Panes are `w-2/5 max-w-xl`; from `xl` up they have a 320px floor and yield before the chat column does.
- **The triage pane fits and follows.** A graph layer wider than `MAX_ROW_NODES` (3, `src/lib/graph-layout.ts`) wraps onto sub-rows so the graph fits the pane width without horizontal scroll (SIO-1657). The pane scrolls to keep the running node in view unless the reader has scrolled away (SIO-1812).
- **Progress labels.** The `aggregate` node reads "Writing report" / "Report written" (SIO-1824, `src/lib/node-labels.ts`): it is the node that streams the report, so "Analyzing" read as stale.

---

## Learning review pane (SIO-1891)

`LearningReviewPane` is the human gate over learning candidates, offered for every agent from the lightbulb toggle in the header. It lists the current agent's candidates (latest state per skill) from `GET /api/agent/memory/candidates?agent=<id>`. A reviewer expands a row, may edit the title and body, then sends one action with `POST /api/agent/memory/candidates`:

| Action | Effect |
|--------|--------|
| `approve` (with `edits`) | Opens the promotion PR through memory-pr. Refused without a confirmed `task_success`. Merging that PR is the only activation. |
| `reject` | Marks the candidate rejected. |
| `supersede` (with `supersedes`) | Marks it superseded by the named skill. |

Candidate text is agent-authored: the pane renders it as text, never as HTML, and never feeds it to a model. The kill-switch is `LEARNING_REVIEW_ENABLED` (defaults ON; `false` or `0` disables). When it is off the route returns 404 and `/api/agents` reports `learningReview: false`, which hides the toggle.

---

## State Management

All reactive state lives in `apps/web/src/lib/stores/agent.svelte.ts`, which exports a singleton `agentStore`. The store uses Svelte 5 runes for fine-grained reactivity.

### $state -- Mutable Reactive State

```typescript
let messages = $state<ChatMessage[]>([]);
let isStreaming = $state(false);
let currentContent = $state("");
let selectedDataSources = $state<string[]>([]);
let connectedDataSources = $state<string[]>([]);
let activeNodes = $state<Set<string>>(new Set());
let completedNodes = $state<Map<string, { duration: number }>>(new Map());
```

### $derived -- Computed Values

```typescript
// CompletedProgress.svelte
const dataSources = $derived(
  dataSourceResults ? [...dataSourceResults.entries()] : [],
);
const successCount = $derived(
  dataSources.filter(([, d]) => d.status === "success").length,
);
const formattedTime = $derived(
  responseTime !== undefined ? `${(responseTime / 1000).toFixed(1)}s` : undefined,
);
```

### $effect -- Side Effects

```typescript
// +page.svelte -- auto-scroll to bottom on new messages
$effect(() => {
  agentStore.messages;
  agentStore.currentContent;
  if (messagesContainer) {
    const nearBottom =
      messagesContainer.scrollHeight -
      messagesContainer.scrollTop -
      messagesContainer.clientHeight < 100;
    if (nearBottom) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }
});
```

The snippet shows the `$effect` shape only. The live page no longer uses the "within 100px of the end" test, which stopped following mid-turn whenever content grew by more than 100px at once: it keeps a `followingChat` flag updated by `followAfterScroll` in `src/lib/components/chat-follow.ts`.

### $props -- Component Props

All components use `$props()` with TypeScript type annotations:

```typescript
// ChatMessage.svelte
let {
  message,
  index,
  isLast = false,
  isStreaming = false,
  onSuggestionClick,
  onFeedback,
}: {
  message: ChatMessage;
  index: number;
  isLast?: boolean;
  isStreaming?: boolean;
  onSuggestionClick?: (s: string) => void;
  onFeedback?: (index: number, score: "up" | "down") => void;
} = $props();
```

### $bindable -- Two-Way Binding

Used for props that the parent needs to read back:

```typescript
// DataSourceSelector.svelte
let {
  selected = $bindable([]),
}: {
  selected: string[];
} = $props();
```

---

## SSE Streaming Integration

Agent responses stream token-by-token from the LangGraph pipeline to the UI via Server-Sent Events.

```
User Input (ChatInput)
     |
     v
POST /api/agent/stream (JSON body with messages, dataSources, attachments)
     |
     v
Server Hook (creates LangGraph run, pipes SSE events)
     |
     v
EventSource (agentStore.sendMessage reads SSE stream)
     |
     v
agentStore updates ($state triggers reactivity)
     |
     v
Components re-render (ChatMessage, StreamingProgress)
```

### Stream Event Types

The SSE stream emits events that the `agentStore` processes:

- **Token events** -- append to `currentContent`, rendered incrementally by `ChatMessage`
- **Node start/end events** -- update `activeNodes` and `completedNodes`, rendered by `StreamingProgress`
- **Data source events** -- update `dataSourceProgress` with status per datasource
- **`subagent_progress`** -- live per-sub-agent status during the `queryDataSource` fan-out (which datasource is querying / done / failed), so the fan-out is not an opaque single spinner; handled in `apps/web/src/lib/server/sse-pump.ts` + `agent-reducer.ts`
- **`network_topology`** (SIO-1204) -- the once-per-turn merged network map (replace semantics); rendered by `NetworkTopologyCard` as an interactive ECharts force graph
- **`application_topology`** (SIO-1457) -- the once-per-turn merged application map (replace semantics); rendered by `ApplicationTopologyCard` as an interactive ECharts force graph with dashed KG prior-knowledge edges
- **Completion events** -- finalize the message with `suggestions`, `responseTime`, `toolsUsed`, `runId`
- **Error events** -- display error state in the UI

### Request Body

```typescript
{
  messages: [{ role: "user", content: "..." }, ...],
  threadId: "optional-thread-id",
  dataSources: ["elastic", "kafka"],
  attachments: [{ type: "image", data: "base64..." }],
  isFollowUp: true,
  dataSourceContext: { ... }
}
```

### Pipeline Node Labels

Node ID -> human-readable label mapping lives in **`apps/web/src/lib/node-labels.ts`** (a single `{ id, activeLabel, completeLabel }` table, ~42 entries), consolidated there so `StreamingProgress` shows the **full pipeline** live, not just a handful of hardcoded steps (previously only 6 node IDs were labelled). Which nodes emit `node_start`/`node_end` at all is NOT decided here: since SIO-1641 the SSE pump takes the compiled graph's own node list (`getPipelineNodes` in `apps/web/src/lib/server/agent.ts`, built from `graph.getGraphAsync()`), so every registered node lights up in the live graph triage panel without a hand-maintained allowlist. The label table is cosmetic and covers both graphs:

- **Incident pipeline:** `classify`, `normalize`, `entityExtractor`, `detectTopicShift`, `queryDataSource`, `align`, `aggregate`, `extractFindings`, `checkConfidence`, `validate`, the mutually-exclusive mitigation branch (`proposeInvestigate` / `proposeMonitor` / `proposeEscalate` -> `aggregateMitigation`), `followUp`, `responder`, and the HIL-learning lane (`learnFetchTicket` -> `learnMatchIncident` -> `learnMatchGate` -> `learnDistill` -> `learnReviewGate` -> `applyLearnings`).
- **Elastic-IaC proposer:** `parseIntent`, `readClusterState`, `draftChange`, `reviewPlan`/`reviewGate`, `openMr`, `watchPipeline`, and the drift / synthetics-drift / fleet-upgrade sub-flow nodes.

Add the node's id + labels to `node-labels.ts` when you add a pipeline node (plumbing nodes go in the completed-only group so they stay out of the live strip); an unlabelled id still emits and lights up, it just falls back to the raw id in the progress UI.

---

## Tailwind CSS v4

The frontend uses Tailwind CSS v4 with the Tommy Hilfiger brand palette. Custom colors are defined in the Tailwind config:

| Token | Usage |
|-------|-------|
| `tommy-navy` | Primary brand color, header background, buttons |
| `tommy-dark-navy` | Hover states for navy elements |
| `tommy-cream` | Page background |
| `tommy-offwhite` | Card backgrounds, subtle containers |
| `tommy-red` | Stop/cancel actions, error states |
| `tommy-accent-blue` | Focus rings, active datasource pills, links |

### Rules

- **Tailwind utility classes only** -- no custom CSS in `<style>` blocks
- **Exception:** `MarkdownRenderer.svelte` uses a `<style>` block because it renders dynamic HTML content from `{@html}` that cannot be targeted with utility classes
- **Exception:** `embedHtml` in `src/lib/server/archify/render.ts` injects a fit rule into the vendored Archify document shown in a sandboxed `srcdoc` iframe, where Tailwind is not loaded (SIO-1878)
- Use responsive prefixes (`sm:`, `md:`, `lg:`) for breakpoint-specific styles
- Animation utilities: `animate-slide-up-fade`, `animate-fade-in`, `animate-pulse-dot`

---

## Stores and Composables

### agentStore (agent.svelte.ts)

Singleton store managing all chat state. Key methods:

| Method | Purpose |
|--------|---------|
| `sendMessage(content, context?)` | Sends user message, initiates SSE stream |
| `cancelStream()` | Aborts the active SSE connection |
| `clearChat()` | Resets all messages and state |
| `setFeedback(index, score)` | Sends thumbs up/down to LangSmith |
| `loadDataSources()` | Fetches available/connected datasources from server |
| `stopHealthPolling()` | Clears the 15-second health poll interval |

### The other store modules

`apps/web/src/lib/stores/` holds four more modules. The two runes stores are thin: the logic lives in pure reducers that can be tested without a browser.

| Module | Role |
|--------|------|
| `agent-reducer.ts` | Pure `applyStreamEvent(state, event)` behind `agentStore`, plus the prompt types for every HITL gate (topic shift, HIL learning, IaC, Landing Zone, Renovate). Add a new SSE event here, not in the runes file. |
| `sse-buffer.ts` | `parseSseChunks(stream)`: turns the response body into `StreamEvent`s, skipping malformed events. |
| `pi-fleet.svelte.ts` | `piFleetStore`, the fleet pane's runes store (SIO-1650): loads the peer listing, sends a prompt, re-polls the message by id until the reply is terminal or the pane budget is spent, loads the ops inbox. Used from `+page.svelte` as `load()`, `send()`, `select()`, `loadMailbox()`, `toggle()` and `clear()`. |
| `pi-fleet-reducer.ts` | Pure state transitions for that pane. Selection and routing key off `hubKey`, because a peer name is only unique within its hub (SIO-1666). `clearConversation` drops entries and mailboxes but keeps the roster and selection. |

### createFileAttachments (file-attachments.svelte.ts)

Composable for managing file uploads in `ChatInput`:

- Handles file picker, paste events, drag-and-drop
- Generates image previews for supported formats
- Enforces `MAX_ATTACHMENTS` limit from shared package
- Returns `filePreviews`, `errors`, `handlePaste`, `triggerPicker`, `removeFile`, `clearAll`

---

## Adding New Components

1. **Create the file** in `apps/web/src/lib/components/` with a descriptive name
2. **Use `$props()`** with TypeScript type annotations for all props
3. **Use `$state`** for local reactive state, `$derived` for computed values
4. **Use Tailwind classes only** -- no `<style>` blocks (unless rendering dynamic HTML)
5. **Follow existing patterns** -- look at `FeedbackBar.svelte` or `FollowUpSuggestions.svelte` as clean examples
6. **Import from `$lib/`** using SvelteKit aliases, not relative paths
7. **Add to parent** -- wire into `+page.svelte` or the relevant parent component

Example skeleton:

```svelte
<script lang="ts">
  import Icon from "./Icon.svelte";

  let {
    label,
    onClick,
  }: {
    label: string;
    onClick: () => void;
  } = $props();

  let isActive = $state(false);
</script>

<button
  onclick={() => { isActive = !isActive; onClick(); }}
  class="px-3 py-2 rounded-lg text-sm {isActive ? 'bg-tommy-accent-blue text-white' : 'bg-white text-gray-600 border border-gray-300'}"
>
  <Icon name="check" class="w-3.5 h-3.5" />
  {label}
</button>
```

---

## Cross-References

- [Getting Started](./getting-started.md) -- initial setup including web dev server
- [System Overview](../architecture/system-overview.md) -- how the frontend fits in the architecture
- [Environment Variables](../configuration/environment-variables.md) -- `CORS_ORIGINS` and frontend-related config

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial version |
| 2026-04-23 | Updated datasource count from 5 to 6 (added Atlassian alongside Elasticsearch, Kafka, Couchbase, Konnect, GitLab) |
| 2026-07-19 | SIO-1039..1161 sync: datasource count 6 -> 7 (AWS); component list 9 -> 30, grouped into five families (chat shell, per-datasource findings cards, IaC/HITL cards, HIL-learning cards, ticket/selectors); added the Create ticket flow section (SIO-1124/1139/1145). |
| 2026-08-08 | SIO-1204..1459 sync: component count 30 -> **34**. Added `MlAnomalyExplainerCard` (SIO-1215) and `ConfidenceBadge` (SIO-1194) to the findings family; documented the **SIO-1459 topology text view** (a11y `<details>` fallback for both ECharts topology cards); added the **`subagent_progress`** SSE event to the stream-event list; replaced the stale 6-row node-label table with a pointer to the consolidated `apps/web/src/lib/node-labels.ts` full-pipeline map. |
| 2026-09-30 | SIO-1897 docs sync (SIO-1635..1896 window): component count 34 -> 42, with a new split-screen panes family (`GraphTriagePanel`, `PiFleetPane`, `PiReplyBody`, `LearningReviewPane`), `ArchifyDiagram`, `FleetInboxCard`, the two Landing Zone cards, `RenovateTriggerChoiceCard` and the three scroll helper modules; `ConfidenceBadge` recorded as removed (SIO-1810). Added the API route table (30 handlers), the other store modules, and four sections: agents and the header control (SIO-1655, SIO-1657), Archify diagrams (SIO-1876..1879), surface vocabulary and panes (SIO-1808..1812, SIO-1657..1659, SIO-1824), and the learning review pane (SIO-1891). |
