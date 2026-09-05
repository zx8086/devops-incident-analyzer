# Frontend Development

> **Targets:** SvelteKit 2.0 | Svelte 5 | Tailwind CSS v4 | Bun 1.3.9+
> **Last updated:** 2026-08-08

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
  lib/
    components/           # All UI components
    stores/
      agent.svelte.ts     # Central reactive store
    composables/
      file-attachments.svelte.ts  # File upload composable
    utils/
      file-utils.ts       # File formatting helpers
  app.css                 # Tailwind directives + custom animations
```

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

The app has grown to 34 components (`ls apps/web/src/lib/components/*.svelte`). They fall into five families.

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

**Findings and topology cards** — one structured card per datasource result, a per-turn network topology card, plus the pipeline progress card: `ElasticFindingsCard`, `KafkaFindingsCard`, `CouchbaseFindingsCard`, `GitLabFindingsCard`, `AtlassianFindingsCard`, `AWSFindingsCard`, `PipelineProgressCard`. `MlAnomalyExplainerCard` (SIO-1215) renders the elastic ML anomaly-detection explainer (severity bands, contributing influencers) when the elastic-agent surfaces ML anomaly records. `ConfidenceBadge` (SIO-1194) is the small shared badge that renders the answer's confidence class (grounded / partial / degraded) next to the response; see [Agent Pipeline: confidence](../architecture/agent-pipeline.md). SIO-1204 adds `NetworkTopologyCard` -- the per-turn network map rendered as an ECharts `graph` series (force layout, roam/zoom, category legend per node kind, dashed CIDR-derived edges, red ring on unhealthy target groups; SSR-guarded dynamic import of modular `echarts/core`, pure option transform in `src/lib/network-chart.ts`). SIO-1457 adds `ApplicationTopologyCard` -- the per-turn application map (services, runtime call edges, kafka consumer edges, datastore/external dependencies) on the same structure: pure option transform in `src/lib/app-chart.ts`, hues disjoint from the network map's, dashed KG prior-knowledge edges, red ring on services above the 5 percent APM error-rate threshold.

**Accessibility -- topology text view (SIO-1459).** Both `NetworkTopologyCard` and `ApplicationTopologyCard` ship a keyboard- and screen-reader-accessible text equivalent of the ECharts canvas: a `<details>`/`<summary>` region (`role="region"`, `aria-label="... text view"`) that lists the same nodes and edges as structured text, so the map is not canvas-only. The ECharts graph stays the primary visual; the text view is the a11y fallback for the same `networkTopology` / `applicationTopology` data.

**IaC / HITL cards** — the elastic-iac proposer and its human-in-the-loop gates: `PlanReviewCard`, `DriftReportCard`, `ReconcileChoiceCard`, `SyntheticsDriftCard`, `SyntheticsPushChoiceCard`, `FleetUpgradeChoiceCard`, `ActionConfirmationCard`.

**HIL-learning cards** — the learn-from-ticket lane (see [Agent Pipeline: HIL learning lane](../architecture/agent-pipeline.md#hil-learning-lane)): `LearningMatchCard` (confirm the matched incident), `LearningProposalCard` (per-item approve/reject/edit), `LearningOutcomeCard` (terminal done state).

**Ticket / selectors** — `CreateTicketCard`, `AddCommentCard` (see below), and the scope selectors `AwsEstateSelector`, `ElasticDeploymentSelector`.

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
