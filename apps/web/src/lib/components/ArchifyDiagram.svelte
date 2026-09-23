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

type Tab = "map" | "diagram";
type Props =
	| { view: "network"; topology: NetworkTopology; tab?: Tab }
	| { view: "application"; topology: ApplicationTopology; tab?: Tab };

let { view, topology, tab = $bindable("map") }: Props = $props();

type Loaded = { html: string; ms: string } | { error: string; details: string[] };

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
			body: JSON.stringify({ view, theme: "light", topology }),
		});
		if (response.ok) {
			loaded = { html: await response.text(), ms: response.headers.get("x-archify-ms") ?? "?" };
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
        <iframe
          title="{view} map diagram"
          srcdoc={current.html}
          sandbox="allow-scripts allow-downloads"
          class="h-[28rem] w-full rounded border-0 bg-white"
        ></iframe>
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
