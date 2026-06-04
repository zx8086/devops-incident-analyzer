<script lang="ts">
// apps/web/src/lib/components/SyntheticsPushChoiceCard.svelte
import type { SyntheticsPushChoice } from "$lib/stores/agent-reducer.ts";

let {
	prompt,
	disabled = false,
	onApprove,
	onDecline,
}: {
	prompt: SyntheticsPushChoice;
	disabled?: boolean;
	onApprove: () => void;
	onDecline: () => void;
} = $props();
</script>

<div
  class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3"
  role="dialog"
  aria-labelledby="synthetics-push-heading"
>
  <div class="max-w-4xl mx-auto">
    <div class="flex items-center justify-between gap-2">
      <h3 id="synthetics-push-heading" class="text-sm font-semibold text-tommy-navy">
        Push synthetics: {prompt.deployment}
      </h3>
      {#if prompt.kibanaSpace}
        <span class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-700">space: {prompt.kibanaSpace}</span>
      {/if}
    </div>
    <p class="text-sm text-tommy-navy/80 mt-1">{prompt.message}</p>
    <p class="mt-1 text-xs text-tommy-navy/70">
      Scope: {prompt.projectScope ? `project '${prompt.projectScope}'` : "fleet-wide"}
    </p>

    {#if prompt.pushMonitors.length > 0}
      <div class="mt-2 rounded-md bg-white/70 border border-tommy-accent-blue/20 p-2">
        <p class="text-xs font-semibold text-tommy-navy">
          Will be pushed to Kibana ({prompt.pushableCount})
        </p>
        <ul class="mt-1 space-y-0.5 text-xs">
          {#each prompt.pushMonitors as m (`${m.project}/${m.monitorName}`)}
            <li class="text-tommy-navy/80"><span class="font-medium">{m.project}</span> / {m.monitorName}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if prompt.extraMonitors.length > 0}
      <div class="mt-2 rounded-md bg-gray-50 border border-gray-200 p-2">
        <p class="text-xs font-semibold text-gray-600">
          Surface-only &mdash; never pushed ({prompt.extraCount})
        </p>
        <p class="text-xs text-gray-500">
          These live in Kibana with no source YAML. The push never deletes them.
        </p>
        <ul class="mt-1 space-y-0.5 text-xs">
          {#each prompt.extraMonitors as m (`${m.project}/${m.monitorName}`)}
            <li class="text-gray-500"><span class="font-medium">{m.project}</span> / {m.monitorName}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if prompt.command}
      <code class="mt-2 block break-all rounded bg-white/70 border border-tommy-accent-blue/20 px-2 py-1 text-xs font-mono text-tommy-navy/80">
        {prompt.command}
      </code>
    {/if}

    <div class="mt-3 flex flex-wrap gap-2">
      <button
        type="button"
        onclick={() => onApprove()}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium rounded-md bg-tommy-navy text-white hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Approve push
      </button>
      <button
        type="button"
        onclick={() => onDecline()}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium rounded-md bg-white text-tommy-navy border border-tommy-navy hover:bg-tommy-cream disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Decline
      </button>
    </div>
    <p class="mt-2 text-xs text-gray-500">
      I never delete live monitors; extra-in-Kibana stays untouched.
    </p>
  </div>
</div>
