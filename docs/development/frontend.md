# Frontend Development

> **Targets:** SvelteKit 2.0 | Svelte 5 | Tailwind CSS v4 | Bun 1.3.9+
> **Last updated:** 2026-04-04

The SvelteKit frontend provides the user interface for the DevOps Incident Analyzer. It renders chat-based interactions, streams agent responses via SSE, and displays pipeline progress across the four datasources (Elasticsearch, Kafka, Couchbase Capella, Kong Konnect).

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

| Component | Responsibility | Key Props |
|-----------|---------------|-----------|
| `ChatMessage` | Renders a single user or assistant message with markdown, progress, feedback, and follow-ups | `message`, `index`, `isLast`, `isStreaming`, `onSuggestionClick`, `onFeedback` |
| `ChatInput` | Text input with auto-resize, Enter-to-submit (Shift+Enter for newline), file attachments, stop button during streaming | `onSend`, `isStreaming`, `onStop`, `attachments` |
| `Icon` | SVG icon wrapper supporting 17 icon names with consistent stroke styling | `name` (typed union), `class` |
| `MarkdownRenderer` | Converts markdown to HTML using `marked`, syntax highlighting via `highlight.js` (json, bash, javascript, yaml) | `content` |
| `StreamingProgress` | Animated pipeline progress showing active/completed nodes during streaming | `activeNodes`, `completedNodes` |
| `CompletedProgress` | Expandable summary of completed pipeline nodes, data source results, and tools used | `responseTime`, `toolsUsed`, `completedNodes`, `dataSourceResults` |
| `FeedbackBar` | Thumbs up/down feedback with copy-to-clipboard, sends feedback to LangSmith | `content`, `feedback`, `onFeedback` |
| `FollowUpSuggestions` | Clickable follow-up question buttons after an agent response | `suggestions`, `onSelect` |
| `DataSourceSelector` | Toggle bar for selecting active datasources, shows connection status | `dataSources`, `connected`, `selected` (bindable) |

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

The `StreamingProgress` component maps node IDs to human-readable labels:

| Node ID | Active Label | Complete Label |
|---------|-------------|----------------|
| `classify` | Classifying... | Classified |
| `entityExtractor` | Extracting... | Extracted |
| `queryDataSource` | Querying... | Queried |
| `align` | Aligning... | Aligned |
| `aggregate` | Analyzing... | Analyzed |
| `validate` | Validating... | Validated |

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
