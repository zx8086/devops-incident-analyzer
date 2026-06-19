<script lang="ts">
// apps/web/src/lib/components/FleetUpgradeChoiceCard.svelte
import MarkdownRenderer from "$lib/components/MarkdownRenderer.svelte";
import type { FleetUpgradeChoice } from "$lib/stores/agent-reducer.ts";

let {
	prompt,
	disabled = false,
	onApprove,
	onDecline,
}: {
	prompt: FleetUpgradeChoice;
	disabled?: boolean;
	onApprove: () => void;
	onDecline: () => void;
} = $props();

// SIO-935: the version partition (present once the CI report carries version_crosstab). When
// present, the headline "will upgrade" count is the upgradeable-AND-outdated set -- the raw
// upgradeableCount can include agents already on target that bulk_upgrade would no-op. Pre-CI
// reports have no partition, so we fall back to the old upgradeableCount and the old 3-stat row.
const vc = $derived(prompt.versionCrosstab);
const willUpgrade = $derived(vc ? vc.upgradeableOutdated : prompt.upgradeableCount);

// SIO-935: the by_reason buckets are Fleet's upgradeable:false reasons (Wolfi detection via
// os.name), NOT version facts. "unknown"/"other" just means os.name didn't match the heuristic;
// render an honest label instead of the bare "unknown" that confused operators.
function reasonLabel(reason: string): string {
	if (reason === "unknown" || reason === "other") return "other OS / not detected";
	if (reason === "wolfi_container") return "Wolfi container";
	return reason;
}
</script>

<div
  class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3"
  role="dialog"
  aria-labelledby="fleet-upgrade-heading"
>
  <div class="max-w-4xl mx-auto">
    <div class="flex items-center justify-between gap-2">
      <h3 id="fleet-upgrade-heading" class="text-sm font-semibold text-tommy-navy">
        Fleet upgrade: {prompt.deployment}
      </h3>
      <span class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-700">target: {prompt.targetVersion}</span>
    </div>
    <p class="text-sm text-tommy-navy/80 mt-1">{prompt.message}</p>

    {#if vc}
      <!-- Version-aware story: already-on-target (no action) / will upgrade / not Fleet-upgradeable. -->
      <div class="mt-2 grid grid-cols-3 gap-2">
        <div class="rounded-md bg-white/70 border border-gray-200 p-2 text-center">
          <p class="text-lg font-semibold text-gray-600">{vc.alreadyOnTarget}</p>
          <p class="text-xs text-gray-500">already on {prompt.targetVersion}</p>
        </div>
        <div class="rounded-md bg-white/70 border border-tommy-accent-blue/20 p-2 text-center">
          <p class="text-lg font-semibold text-tommy-navy">{willUpgrade}</p>
          <p class="text-xs text-tommy-navy/70">will upgrade</p>
        </div>
        <div class="rounded-md bg-gray-50 border border-gray-200 p-2 text-center">
          <p class="text-lg font-semibold text-gray-600">{prompt.notUpgradeableCount}</p>
          <p class="text-xs text-gray-500">not Fleet-upgradeable</p>
        </div>
      </div>
      <p class="mt-1.5 text-xs text-tommy-navy/60">
        {prompt.resolvedCount} agents matched &middot; {vc.outdated} outdated total{#if vc.versionUnknown > 0} &middot; {vc.versionUnknown} version unknown{/if}
      </p>
    {:else}
      <!-- Back-compat (pre version_crosstab): the original three stats. -->
      <div class="mt-2 grid grid-cols-3 gap-2">
        <div class="rounded-md bg-white/70 border border-tommy-accent-blue/20 p-2 text-center">
          <p class="text-lg font-semibold text-tommy-navy">{prompt.upgradeableCount}</p>
          <p class="text-xs text-tommy-navy/70">will upgrade</p>
        </div>
        <div class="rounded-md bg-gray-50 border border-gray-200 p-2 text-center">
          <p class="text-lg font-semibold text-gray-600">{prompt.notUpgradeableCount}</p>
          <p class="text-xs text-gray-500">skipped (not upgradeable)</p>
        </div>
        <div class="rounded-md bg-white/70 border border-tommy-accent-blue/20 p-2 text-center">
          <p class="text-lg font-semibold text-tommy-navy">{prompt.resolvedCount}</p>
          <p class="text-xs text-tommy-navy/70">agents matched</p>
        </div>
      </div>
    {/if}

    <p class="mt-2 text-xs text-tommy-navy/70">
      Rollout window: {prompt.rolloutSeconds}s &middot; imperative bulk_upgrade run via CI (not Terraform).
    </p>

    {#if prompt.notUpgradeableCount > 0 && prompt.byReason.length > 0}
      <div class="mt-2 rounded-md bg-gray-50 border border-gray-200 p-2">
        <p class="text-xs font-semibold text-gray-600">
          Skipped &mdash; not Fleet-upgradeable (bump the image tag upstream instead)
        </p>
        <ul class="mt-1 space-y-0.5 text-xs">
          {#each prompt.byReason as r (r.reason)}
            <li class="text-gray-500"><span class="font-medium">{r.count}</span> &times; {reasonLabel(r.reason)}</li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- SIO-971: cross-session agent-memory recall of prior fleet upgrades for this deployment,
         so the operator sees "we've upgraded this deployment before" (and how it went) before
         approving. The fleet-path twin of SIO-970's plan-review "Prior learnings" block. -->
    {#if prompt.priorUpgrades}
      <details class="mt-2" open>
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">Prior upgrades (memory)</summary>
        <div class="mt-1 rounded bg-white border border-tommy-accent-blue/30 px-2 py-1 text-xs text-tommy-navy">
          <MarkdownRenderer content={prompt.priorUpgrades} />
        </div>
      </details>
    {/if}

    <p class="mt-3 text-xs font-semibold text-amber-700">
      Approving starts a LIVE bulk_upgrade via CI now (there is no MR for a binary upgrade). It rolls out over ~{prompt.rolloutSeconds}s &mdash; I won't block on the full rollout; you can track the apply pipeline here or ask me to check on it.
    </p>
    <div class="mt-3 flex flex-wrap gap-2">
      <button
        type="button"
        onclick={() => onApprove()}
        disabled={disabled || willUpgrade === 0}
        class="px-3 py-1.5 text-sm font-medium rounded-md bg-tommy-navy text-white hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Approve & apply now
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
      CI owns the apply; I never run bulk_upgrade locally. Wolfi/container agents are skipped, not upgraded here.
    </p>
  </div>
</div>
