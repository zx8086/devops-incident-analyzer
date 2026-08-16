<script lang="ts">
// apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte
import MarkdownRenderer from "$lib/components/MarkdownRenderer.svelte";
import type { RenovateTriggerChoice } from "$lib/stores/agent-reducer.ts";

let {
	prompt,
	disabled = false,
	onApprove,
	onDecline,
}: {
	prompt: RenovateTriggerChoice;
	disabled?: boolean;
	onApprove: () => void;
	onDecline: () => void;
} = $props();

// SIO-XXXX: stat tiles render only when at least one Kibana enrichment value is present --
// best-effort, degrades cleanly to today's plain card when Kibana lookup failed/wasn't
// configured for this deployment.
const hasStats = $derived(
	prompt.installedVersion != null || prompt.targetVersion != null || prompt.policyCount != null,
);
const changelogCount = $derived(prompt.changelog?.length ?? 0);
</script>

<div
  class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3"
  role="dialog"
  aria-labelledby="renovate-trigger-heading"
>
  <div class="max-w-4xl mx-auto">
    <h3 id="renovate-trigger-heading" class="text-sm font-semibold text-tommy-navy">
      Trigger Renovate update
    </h3>
    <p class="text-sm text-tommy-navy/80 mt-1">{prompt.message}</p>

    {#if hasStats}
      <div class="mt-2 grid grid-cols-3 gap-2">
        <div class="rounded-md bg-white/70 border border-gray-200 p-2 text-center">
          <p class="text-lg font-semibold text-gray-600">{prompt.installedVersion ?? "?"}</p>
          <p class="text-xs text-gray-500">installed</p>
        </div>
        <div class="rounded-md bg-white/70 border border-tommy-accent-blue/20 p-2 text-center">
          <p class="text-lg font-semibold text-tommy-navy">{prompt.targetVersion ?? "?"}</p>
          <p class="text-xs text-tommy-navy/70">target</p>
        </div>
        <div class="rounded-md bg-white/70 border border-gray-200 p-2 text-center">
          <p class="text-lg font-semibold text-gray-600">{prompt.policyCount ?? "?"}</p>
          <p class="text-xs text-gray-500">affected policies</p>
        </div>
      </div>
    {/if}

    <!-- SIO-1472: knowledge-graph change history for this deployment, mirroring
         FleetUpgradeChoiceCard's own "Recent changes (knowledge graph)" panel -- the
         renovate-integration-update lane also bypasses graphEnrichIac, so enrichRenovateTarget
         reads the KG itself via the same recallDeploymentKgChanges function fleet-upgrade uses.
         Gated on presence -- an off/empty KG yields "" and the panel stays hidden. -->
    {#if prompt.recentChanges}
      <details class="mt-2" open>
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">Recent changes (knowledge graph)</summary>
        <div class="mt-1 rounded bg-white border border-tommy-accent-blue/30 px-2 py-1 text-xs text-tommy-navy">
          <MarkdownRenderer content={prompt.recentChanges} />
        </div>
      </details>
    {/if}

    <!-- SIO-1472: cross-session agent-memory recall of prior Renovate triggers for this exact
         deployment+integration pair, so the operator sees "we've triggered this before" (and its
         MR, if one was found) before approving -- the renovate-path twin of
         FleetUpgradeChoiceCard's "Prior upgrades (memory)" block. -->
    {#if prompt.priorTriggers}
      <details class="mt-2" open>
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">Prior triggers (memory)</summary>
        <div class="mt-1 rounded bg-white border border-tommy-accent-blue/30 px-2 py-1 text-xs text-tommy-navy">
          <MarkdownRenderer content={prompt.priorTriggers} />
        </div>
      </details>
    {/if}

    {#if changelogCount > 0}
      <details class="mt-2">
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">
          Changelog ({prompt.installedVersion ?? "?"} &rarr; {prompt.targetVersion ?? "?"}, {changelogCount} release{changelogCount === 1 ? "" : "s"})
        </summary>
        <ul class="mt-1 space-y-1.5 text-xs">
          {#each prompt.changelog ?? [] as entry (entry.version)}
            <li>
              <p class="font-medium text-tommy-navy">{entry.version}</p>
              <ul class="ml-3 list-disc space-y-0.5 text-tommy-navy/70">
                {#each entry.changes as change, i (i)}
                  <li>{change.description}</li>
                {/each}
              </ul>
            </li>
          {/each}
        </ul>
      </details>
    {/if}

    <div class="mt-3 flex flex-wrap gap-2">
      <button
        type="button"
        onclick={() => onApprove()}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium rounded-md bg-tommy-navy text-white hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Trigger update
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
      Runs via the schedule-triggered Renovate job (branches/MRs only); apply stays manual.
    </p>
  </div>
</div>
