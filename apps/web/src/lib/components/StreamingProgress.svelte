<script lang="ts">
import Icon from "./Icon.svelte";

let {
	activeNodes,
	completedNodes,
}: {
	activeNodes: Set<string>;
	completedNodes: Map<string, { duration: number }>;
} = $props();

const pipeline = ["classify", "entityExtractor", "supervisor", "queryDataSource", "align", "aggregate", "validate"];
</script>

{#if activeNodes.size > 0 || completedNodes.size > 0}
  <div class="flex items-center gap-1.5 py-3 px-4 overflow-x-auto">
    {#each pipeline as node, i}
      {@const isActive = activeNodes.has(node)}
      {@const isCompleted = completedNodes.has(node)}
      {@const duration = completedNodes.get(node)?.duration}

      {#if i > 0}
        <div class="w-4 h-0.5 {isCompleted ? 'bg-green-500' : 'bg-gray-300'}"></div>
      {/if}

      <div class="flex items-center gap-1 px-2 py-1 rounded-full text-xs whitespace-nowrap
        {isActive ? 'bg-tommy-accent-blue/10 text-tommy-accent-blue border border-tommy-accent-blue/30 animate-pulse-glow' : ''}
        {isCompleted ? 'bg-green-50 text-green-700 border border-green-200' : ''}
        {!isActive && !isCompleted ? 'bg-gray-50 text-gray-400 border border-gray-200' : ''}
      ">
        {#if isActive}
          <Icon name="spinner" size={12} />
        {:else if isCompleted}
          <Icon name="check" size={12} />
        {/if}
        <span>{node}</span>
        {#if isCompleted && duration}
          <span class="text-gray-400 text-[10px]">{duration}ms</span>
        {/if}
      </div>
    {/each}
  </div>
{/if}
