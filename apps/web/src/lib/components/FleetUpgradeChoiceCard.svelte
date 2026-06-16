<script lang="ts">
// apps/web/src/lib/components/FleetUpgradeChoiceCard.svelte
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
            <li class="text-gray-500"><span class="font-medium">{r.count}</span> &times; {r.reason}</li>
          {/each}
        </ul>
      </div>
    {/if}

    <p class="mt-3 text-xs font-semibold text-amber-700">
      Approving starts a LIVE bulk_upgrade via CI now (there is no MR for a binary upgrade). It rolls out over ~{prompt.rolloutSeconds}s &mdash; I won't block on the full rollout; you can track the apply pipeline here or ask me to check on it.
    </p>
    <div class="mt-3 flex flex-wrap gap-2">
      <button
        type="button"
        onclick={() => onApprove()}
        disabled={disabled || prompt.upgradeableCount === 0}
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
