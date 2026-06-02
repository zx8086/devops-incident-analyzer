<script lang="ts">
// apps/web/src/lib/components/PlanReviewCard.svelte
import type { IacPlanReviewPrompt } from "$lib/stores/agent-reducer.ts";

let {
	prompt,
	disabled = false,
	onApprove,
	onReject,
}: {
	prompt: IacPlanReviewPrompt;
	disabled?: boolean;
	onApprove: () => void;
	onReject: () => void;
} = $props();

const review = $derived(prompt.review);
</script>

<div class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3" role="dialog" aria-labelledby="iac-plan-heading">
  <div class="max-w-4xl mx-auto">
    <div class="flex items-center justify-between gap-2">
      <h3 id="iac-plan-heading" class="text-sm font-semibold text-tommy-navy">
        Review Terraform plan
      </h3>
      {#if review}
        <span
          class="text-xs px-2 py-0.5 rounded-full {review.precheckPassed ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-900'}"
        >
          gl-testing pre-check: {review.precheckPassed ? "passed" : "not confirmed"}
        </span>
      {/if}
    </div>

    <p class="text-sm text-tommy-navy/80 mt-1">{prompt.message}</p>

    {#if review}
      <div class="mt-2 text-xs text-gray-600 flex flex-wrap gap-x-4 gap-y-1">
        <span><span class="font-semibold">Cluster:</span> {review.cluster || "(unspecified)"}</span>
        <span><span class="font-semibold">Branch:</span> {review.branch || "(none)"}</span>
        <span><span class="font-semibold">Title:</span> {review.title}</span>
      </div>

      {#if review.risks.length > 0}
        <div class="mt-2">
          <p class="text-xs font-semibold text-yellow-900">Risks</p>
          <ul class="list-disc list-inside text-xs text-yellow-900">
            {#each review.risks as risk}
              <li>{risk}</li>
            {/each}
          </ul>
        </div>
      {/if}

      <details class="mt-2" open>
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">Plan output</summary>
        <pre class="mt-1 max-h-48 overflow-auto rounded bg-tommy-navy text-tommy-cream text-xs p-2 whitespace-pre-wrap">{review.plan || "(no plan output)"}</pre>
      </details>

      <details class="mt-2">
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">Terraform diff</summary>
        <pre class="mt-1 max-h-48 overflow-auto rounded bg-gray-900 text-gray-100 text-xs p-2 whitespace-pre-wrap">{review.diff || "(no diff)"}</pre>
      </details>
    {/if}

    <div class="mt-3 flex gap-2">
      <button
        type="button"
        onclick={onApprove}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium bg-tommy-navy text-white rounded-md hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Approve and open MR
      </button>
      <button
        type="button"
        onclick={onReject}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium bg-white text-tommy-navy border border-tommy-navy rounded-md hover:bg-tommy-cream disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Reject
      </button>
    </div>
    <p class="mt-2 text-xs text-gray-500">Apply is never automated; merge and apply happen manually in GitLab.</p>
  </div>
</div>
