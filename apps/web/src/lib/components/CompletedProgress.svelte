<script lang="ts">
// apps/web/src/lib/components/CompletedProgress.svelte
import Icon from "./Icon.svelte";

const NODE_LABELS: Record<string, string> = {
	classify: "Classified",
	entityExtractor: "Extracted",
	queryDataSource: "Queried",
	align: "Aligned",
	aggregate: "Analyzed",
	validate: "Validated",
};

interface DataSourceStatus {
	status: string;
	message?: string;
}

let {
	responseTime,
	toolsUsed = [],
	completedNodes = new Map(),
	dataSourceResults,
}: {
	responseTime?: number;
	toolsUsed?: string[];
	completedNodes?: Map<string, { duration: number }>;
	dataSourceResults?: Map<string, DataSourceStatus>;
} = $props();

let expanded = $state(false);

const dataSources = $derived(dataSourceResults ? [...dataSourceResults.entries()] : []);

const hasContent = $derived(
	responseTime !== undefined || toolsUsed.length > 0 || completedNodes.size > 0 || dataSources.length > 0,
);

const formattedTime = $derived(responseTime !== undefined ? `${(responseTime / 1000).toFixed(1)}s` : undefined);

const successCount = $derived(dataSources.filter(([, d]) => d.status === "success").length);
const errorCount = $derived(dataSources.filter(([, d]) => d.status === "error").length);

function statusDotClass(status: string): string {
	switch (status) {
		case "success":
			return "bg-green-500";
		case "error":
			return "bg-red-500";
		case "running":
			return "bg-yellow-500";
		default:
			return "bg-gray-400";
	}
}
</script>

{#if hasContent}
  <div class="mt-2 animate-fade-in">
    <button
      onclick={() => expanded = !expanded}
      class="w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-left"
      style="background: linear-gradient(135deg, #f0fdf4, #dcfce7); border: 1px solid #bbf7d0;"
    >
      <Icon name="check" class="w-3.5 h-3.5 text-green-600" />
      <span class="text-xs font-medium text-green-700">
        Completed{#if formattedTime} in {formattedTime}{/if}
        {#if dataSources.length > 0}
          <span class="text-green-500 font-normal">
            -- {dataSources.length} data source{dataSources.length !== 1 ? "s" : ""}
            {#if errorCount > 0}
              ({successCount} ok, {errorCount} failed)
            {/if}
          </span>
        {/if}
      </span>
      <Icon
        name="chevron-down"
        class="w-3 h-3 text-green-500 ml-auto shrink-0 transition-transform {expanded ? 'rotate-180' : ''}"
      />
    </button>

    {#if expanded}
      <div class="mt-1 bg-green-50 border border-green-100 rounded-lg px-3 py-2.5 animate-slide-up-fade">
        {#if completedNodes.size > 0}
          <div class="mb-2.5">
            <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Pipeline</span>
            <div class="flex flex-wrap gap-1.5 mt-1">
              {#each [...completedNodes.entries()] as [nodeId, data]}
                <span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full bg-green-100 text-green-700 text-[0.625rem] font-medium">
                  <Icon name="check" class="w-2.5 h-2.5" />
                  {NODE_LABELS[nodeId] ?? nodeId}
                  <span class="text-green-500 text-[0.5rem]">{(data.duration / 1000).toFixed(1)}s</span>
                </span>
              {/each}
            </div>
          </div>
        {/if}

        {#if dataSources.length > 0}
          <div class="mb-2.5">
            <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Data Sources</span>
            <div class="flex flex-col gap-1 mt-1">
              {#each dataSources as [id, ds]}
                <div class="flex items-center gap-2 py-1">
                  <div class="w-1.5 h-1.5 rounded-full shrink-0 {statusDotClass(ds.status)}"></div>
                  <span class="text-[0.6875rem] font-medium text-gray-800">{id}</span>
                  <span class="text-[0.625rem] text-gray-500 capitalize">{ds.status}</span>
                  {#if ds.message}
                    <span class="text-[0.625rem] text-red-600 ml-auto truncate max-w-[200px]">{ds.message}</span>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#if toolsUsed.length > 0}
          <div>
            <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Tools</span>
            <div class="flex flex-wrap gap-1 mt-1">
              {#each toolsUsed as tool}
                <span class="inline-flex items-center py-0.5 px-1.5 rounded-full bg-amber-100 text-amber-700 text-[0.5625rem] font-medium">
                  <Icon name="tool" class="w-2 h-2 mr-0.5" />
                  {tool}
                </span>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
