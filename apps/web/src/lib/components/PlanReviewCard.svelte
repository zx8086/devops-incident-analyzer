<script lang="ts">
// apps/web/src/lib/components/PlanReviewCard.svelte
import type { IacPlanReviewPrompt } from "$lib/stores/agent-reducer.ts";
import MarkdownRenderer from "./MarkdownRenderer.svelte";

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
// SIO-874 / SIO-912: every IaC proposal is a config edit (the agent edits config + opens an
// MR; CI computes the plan). The agent never runs terraform locally, so there is no terraform
// plan output and no gl-testing pre-check badge -- those rendered only for the retired
// local-terraform path.
const heading = "Review proposed change";
const diffLabel = "Config change";
const planLabel = "How this applies";
</script>

<div class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3" role="dialog" aria-labelledby="iac-plan-heading">
  <div class="max-w-4xl mx-auto">
    <div class="flex items-center justify-between gap-2">
      <h3 id="iac-plan-heading" class="text-sm font-semibold text-tommy-navy">
        {heading}
      </h3>
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

      <!-- SIO-969: knowledge-graph history for this deployment/stack -- prior changes with
           their pass/fail outcome + blast radius, so the reviewer sees whether a similar
           change applied or failed last time before approving. -->
      {#if review.recentChangesStatus && review.recentChangesStatus !== "off"}
        <details class="mt-2" open>
          <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">Recent changes (knowledge graph)</summary>
          <div class="mt-1 rounded bg-white border border-tommy-accent-blue/30 px-2 py-1 text-xs text-tommy-navy">
            {#if review.recentChanges}
              <MarkdownRenderer content={review.recentChanges} />
            {:else}
              <span class="text-tommy-navy/50">No prior changes recorded for this stack yet.</span>
            {/if}
          </div>
        </details>
      {/if}

      <!-- SIO-970: cross-session agent-memory recall -- prior learnings/decisions for this
           deployment/stack cell, so the reviewer sees what we learned last time we touched
           this stack before approving. -->
      {#if review.priorLearningsStatus && review.priorLearningsStatus !== "off"}
        <details class="mt-2" open>
          <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">Prior learnings (memory)</summary>
          <div class="mt-1 rounded bg-white border border-tommy-accent-blue/30 px-2 py-1 text-xs text-tommy-navy">
            {#if review.priorLearnings}
              <MarkdownRenderer content={review.priorLearnings} />
            {:else}
              <span class="text-tommy-navy/50">No prior learnings on record for this stack.</span>
            {/if}
          </div>
        </details>
      {/if}

      <!-- SIO-983: live-parity advisory -- the drafted change diffed against the LIVE cluster.
           Surfaces fields the draft sets that live does not (a stale repo source copied forward),
           value changes, and fields live has that the draft drops, so the reviewer sees drift
           before merge. Non-blocking; styled with a warning accent. -->
      {#if review.liveParity}
        <details class="mt-2" open>
          <summary class="text-xs font-semibold text-yellow-900 cursor-pointer">Differs from live cluster</summary>
          <div class="mt-1 rounded bg-yellow-50 border border-yellow-400/50 px-2 py-1 text-xs text-yellow-900">
            <MarkdownRenderer content={review.liveParity} />
          </div>
        </details>
      {/if}

      <details class="mt-2" open>
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">{planLabel}</summary>
        <pre class="mt-1 max-h-48 overflow-auto rounded bg-tommy-navy text-tommy-cream text-xs p-2 whitespace-pre-wrap">{review.plan || "(none)"}</pre>
      </details>

      <details class="mt-2" open>
        <summary class="text-xs font-semibold text-tommy-navy cursor-pointer">{diffLabel}</summary>
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
