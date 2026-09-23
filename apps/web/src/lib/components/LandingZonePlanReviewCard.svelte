<script lang="ts">
// apps/web/src/lib/components/LandingZonePlanReviewCard.svelte

import type { LandingZonePlanReviewPrompt } from "$lib/stores/agent-reducer.ts";

let {
	prompt,
	disabled = false,
	onApprove,
	onReject,
	onAmend,
}: {
	prompt: LandingZonePlanReviewPrompt;
	disabled?: boolean;
	onApprove: () => void;
	onReject: (reason: string) => void;
	onAmend: (instructions: string) => void;
} = $props();

let feedback = $state("");
const review = $derived(prompt.review);
const canSendFeedback = $derived(feedback.trim().length > 0 && !disabled);
</script>

<div class="border-t border-gray-200 bg-gray-50 px-4 py-3" role="dialog" aria-labelledby="landing-zone-review-heading">
  <div class="mx-auto max-w-4xl">
    <h3 id="landing-zone-review-heading" class="text-sm font-semibold text-tommy-navy">Review Landing Zone proposal</h3>
    <p class="mt-1 text-sm text-tommy-navy/80">{prompt.message}</p>

    <div class="mt-2 grid gap-1 text-xs text-gray-600 sm:grid-cols-2">
      <span><span class="font-semibold">Repository:</span> {review.repository}</span>
      <span><span class="font-semibold">Base:</span> {review.baseBranch} at {review.baseSha.slice(0, 12)}</span>
      <span><span class="font-semibold">Branch:</span> {review.targetBranch}</span>
      <span><span class="font-semibold">Risk:</span> {review.riskLevel}</span>
    </div>

    <details class="mt-2" open>
      <summary class="cursor-pointer text-xs font-semibold text-tommy-navy">Reviewed files and diff</summary>
      <pre class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-tommy-navy p-2 text-xs text-tommy-cream">{review.diffSummary}</pre>
    </details>

    <details class="mt-2" open>
      <summary class="cursor-pointer text-xs font-semibold text-tommy-navy">Validation</summary>
      <ul class="mt-1 space-y-1 text-xs text-tommy-navy">
        {#each review.validations as validation}
          <li class="rounded border border-gray-200 bg-white px-2 py-1">
            <span class="font-semibold">{validation.command}:</span> {validation.status}. {validation.summary}
          </li>
        {/each}
      </ul>
    </details>

    <details class="mt-2" open>
      <summary class="cursor-pointer text-xs font-semibold text-tommy-navy">Expected Terraform plan</summary>
      <p class="mt-1 rounded border border-gray-200 bg-white px-2 py-1 text-xs text-tommy-navy">{review.expectedPlan}</p>
    </details>

    {#if review.standardsComparison.length > 0}
      <details class="mt-2">
        <summary class="cursor-pointer text-xs font-semibold text-tommy-navy">Standards comparison</summary>
        <ul class="mt-1 space-y-1 text-xs text-tommy-navy">
          {#each review.standardsComparison as comparison}
            <li><span class="font-semibold">{comparison.claim}:</span> {comparison.alignment} ({comparison.action})</li>
          {/each}
        </ul>
      </details>
    {/if}

    {#if review.destructiveFlags.length > 0 || review.stopConditions.length > 0 || review.unresolvedEvidence.length > 0}
      <div class="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
        <p class="font-semibold">Risk and unresolved evidence</p>
        <ul class="mt-1 list-inside list-disc">
          {#each [...review.destructiveFlags, ...review.stopConditions, ...review.unresolvedEvidence] as item}
            <li>{item}</li>
          {/each}
        </ul>
      </div>
    {/if}

    <label for="landing-zone-review-feedback" class="mt-3 block text-xs font-semibold text-tommy-navy">
      Reason for rejection or amendment instructions
    </label>
    <textarea
      id="landing-zone-review-feedback"
      bind:value={feedback}
      {disabled}
      rows="2"
      class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-tommy-accent-blue focus:outline-none disabled:opacity-50"
    ></textarea>

    <div class="mt-3 flex flex-wrap gap-2">
      <button
        type="button"
        onclick={onApprove}
        {disabled}
        class="min-h-[44px] rounded-lg bg-tommy-navy px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-tommy-navy/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Approve and open MR
      </button>
      <button
        type="button"
        onclick={() => onAmend(feedback.trim())}
        disabled={!canSendFeedback}
        class="min-h-[44px] rounded-lg border border-tommy-navy bg-white px-3 py-1.5 text-sm font-medium text-tommy-navy transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Amend proposal
      </button>
      <button
        type="button"
        onclick={() => onReject(feedback.trim())}
        disabled={!canSendFeedback}
        class="min-h-[44px] rounded-lg border border-red-700 bg-white px-3 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Reject
      </button>
    </div>
    <p class="mt-2 text-xs text-gray-500">
      Approval opens or updates a ready-for-review merge request. It never merges or applies Terraform.
    </p>
  </div>
</div>
