<script lang="ts" module>
// apps/web/src/lib/components/ArchifyDiagram.svelte
// One flag probe per page load, shared by every card. Never on the server: there is no origin
// to resolve "/api/diagram" against, and the tabs only matter once the page is interactive.
let probe: Promise<boolean> | undefined;
function archifyEnabled(): Promise<boolean> {
	// typeof window, not $app/environment: bun test (ChatMessage.test.ts) cannot resolve $app/*.
	if (typeof window === "undefined") return Promise.resolve(false);
	probe ??= fetch("/api/diagram")
		.then((r) => (r.ok ? r.json() : { enabled: false }))
		.then((b: { enabled?: boolean }) => b.enabled === true)
		.catch(() => false);
	return probe;
}
</script>

<script lang="ts">
// SIO-1876: spike -- a Diagram tab beside a topology card's ECharts map. The HTML comes from
// /api/diagram (the vendored Archify renderer) and runs in a sandboxed srcdoc iframe: an opaque
// origin, so the viewer's scripts run but cannot reach the app's cookies or DOM. allow-downloads
// keeps Archify's own PNG/SVG export working.
import type { ApplicationTopology, NetworkTopology } from "@devops-agent/shared";
import { diagramFrameHeight } from "$lib/archify-frame";
import Icon from "./Icon.svelte";

type Tab = "map" | "diagram";
// SIO-1879: the card owns the expanded dialog (state, focus save/restore, Escape, focus trap); the
// Diagram tab only asks for it, so there is one dialog per card, not a second one here.
type Shared = { tab?: Tab; expanded?: boolean; onToggleExpand?: () => void };
type Props =
	| ({ view: "network"; topology: NetworkTopology } & Shared)
	| ({ view: "application"; topology: ApplicationTopology } & Shared);

let { view, topology, tab = $bindable("map"), expanded = false, onToggleExpand }: Props = $props();

type Loaded = { html: string; ms: string; viewBox: string | null } | { error: string; details: string[] };

const enabled = archifyEnabled();

let loaded = $state<Loaded | undefined>();
let loading = $state(false);

async function open(next: Tab) {
	tab = next;
	if (next === "map" || loaded || loading) return;
	loading = true;
	try {
		const response = await fetch("/api/diagram", {
			method: "POST",
			headers: { "content-type": "application/json" },
			// SIO-1878: dark, like the Archify gallery; the diagram is its own panel inside the light card.
			body: JSON.stringify({ view, theme: "dark", topology }),
		});
		if (response.ok) {
			loaded = {
				html: await response.text(),
				ms: response.headers.get("x-archify-ms") ?? "?",
				viewBox: response.headers.get("x-archify-viewbox"),
			};
		} else {
			const body = (await response.json().catch(() => ({}))) as {
				error?: string;
				message?: string;
				diagnostics?: { message: string }[];
			};
			loaded = {
				error: body.error ?? body.message ?? `HTTP ${response.status}`,
				details: (body.diagnostics ?? []).map((d) => d.message),
			};
		}
	} catch (err) {
		loaded = { error: err instanceof Error ? err.message : String(err), details: [] };
	} finally {
		loading = false;
	}
}

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
	{ id: "map", label: "Map" },
	{ id: "diagram", label: "Diagram" },
];
const current = $derived(tab === "map" ? undefined : loaded);
let frameWidth = $state(0);
</script>

{#await enabled then on}
  {#if on}
    <div class="mb-1 flex gap-1" role="tablist" aria-label="{view} map view">
      {#each TABS as t (t.id)}
        <button
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          onclick={() => open(t.id)}
          class={tab === t.id
            ? "rounded border border-teal-700 bg-teal-700 px-2 py-0.5 text-[0.625rem] text-white"
            : "rounded border border-gray-300 bg-white px-2 py-0.5 text-[0.625rem] text-gray-700 hover:bg-gray-100"}
        >
          {t.label}
        </button>
      {/each}
    </div>
    {#if tab !== "map"}
      {#if loading && !current}
        <div class="flex h-[28rem] items-center justify-center text-[0.6875rem] text-gray-400">
          Rendering diagram...
        </div>
      {:else if current && "html" in current}
        <!-- Expanded, the frame fills the dialog; the embed CSS scales the SVG to its height. -->
        <div class={expanded ? "relative flex min-h-0 flex-1 flex-col" : "relative"}>
          <iframe
            title="{view} map diagram"
            srcdoc={current.html}
            sandbox="allow-scripts allow-downloads"
            bind:clientWidth={frameWidth}
            style:height={expanded ? undefined : `${diagramFrameHeight(current.viewBox, frameWidth)}px`}
            class={expanded ? "min-h-0 w-full flex-1 rounded border-0 bg-slate-950" : "w-full rounded border-0 bg-slate-950"}
          ></iframe>
          {#if onToggleExpand}
            <button
              type="button"
              onclick={onToggleExpand}
              class="absolute right-2 top-2 rounded-md border border-slate-600 bg-slate-900/80 p-1.5 text-slate-200 shadow-sm hover:bg-slate-800"
              aria-label={expanded ? `Collapse ${view} diagram` : `Expand ${view} diagram`}
              title={expanded ? "Collapse" : "Expand"}
            >
              <Icon name={expanded ? "collapse" : "expand"} class="h-3.5 w-3.5" />
            </button>
          {/if}
        </div>
        <p class="mt-1 text-[0.5625rem] text-gray-500 tabular-nums">
          Rendered in {current.ms} ms
        </p>
      {:else if current}
        <div class="rounded border border-red-200 bg-red-50 p-2 text-[0.6875rem] text-red-800">
          <p class="font-medium">Diagram not rendered: {current.error}</p>
          {#if current.details.length}
            <ul class="mt-1 list-disc pl-4">
              {#each current.details.slice(0, 5) as detail, i (i)}<li>{detail}</li>{/each}
            </ul>
          {/if}
        </div>
      {/if}
    {/if}
  {/if}
{/await}
