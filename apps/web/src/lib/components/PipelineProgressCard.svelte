<script lang="ts">
// apps/web/src/lib/components/PipelineProgressCard.svelte
import Icon from "./Icon.svelte";

let {
	lines,
	variant = "live",
}: {
	lines: string[];
	variant?: "live" | "collapsed";
} = $props();
</script>

{#if lines.length > 0}
  {#if variant === "live"}
    <div class="animate-slide-up-fade py-2 px-4">
      <div class="flex gap-3 items-start">
        <div class="w-7 h-7 bg-tommy-offwhite rounded-full flex items-center justify-center shrink-0 mt-0.5">
          <Icon name="bot" class="w-3.5 h-3.5 text-tommy-navy" />
        </div>
        <div class="max-w-[85%]">
          <div class="bg-gradient-to-br from-tommy-offwhite/80 to-tommy-offwhite border border-tommy-offwhite rounded-xl p-3 text-xs animate-fade-in">
            <div class="flex items-center gap-2 mb-2">
              <span class="relative flex h-2 w-2">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-tommy-accent-blue opacity-75"></span>
                <span class="relative inline-flex rounded-full h-2 w-2 bg-tommy-accent-blue"></span>
              </span>
              <span class="text-tommy-navy font-medium">Pipeline progress</span>
            </div>
            <ul class="space-y-0.5 font-mono text-xs text-tommy-navy/80">
              {#each lines as line, i (i)}
                <li class="flex items-start gap-1.5">
                  <span class="inline-block w-1.5 h-1.5 rounded-full bg-tommy-accent-blue/60 mt-1 shrink-0"></span>
                  <span>{line}</span>
                </li>
              {/each}
            </ul>
          </div>
        </div>
      </div>
    </div>
  {:else}
    <div class="py-1 px-4">
      <div class="flex gap-3 items-start">
        <div class="w-7 h-7 bg-tommy-offwhite rounded-full flex items-center justify-center shrink-0 mt-0.5">
          <Icon name="bot" class="w-3.5 h-3.5 text-tommy-navy" />
        </div>
        <div class="max-w-[85%]">
          <details class="bg-gray-50 rounded-lg border border-gray-200">
            <summary class="cursor-pointer select-none px-3 py-2 text-xs text-tommy-navy/70 flex items-center gap-1.5 hover:text-tommy-navy">
              <Icon name="chevron-down" class="w-3 h-3" />
              <span>Pipeline log ({lines.length} {lines.length === 1 ? "step" : "steps"})</span>
            </summary>
            <ul class="px-3 pb-2 space-y-0.5 font-mono text-[0.7rem] text-tommy-navy/70">
              {#each lines as line, i (i)}
                <li class="flex items-start gap-1.5">
                  <span class="inline-block w-1.5 h-1.5 rounded-full bg-tommy-accent-blue/60 mt-1 shrink-0"></span>
                  <span>{line}</span>
                </li>
              {/each}
            </ul>
          </details>
        </div>
      </div>
    </div>
  {/if}
{/if}
