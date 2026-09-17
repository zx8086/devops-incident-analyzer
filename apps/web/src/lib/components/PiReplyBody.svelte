<script module lang="ts">
// apps/web/src/lib/components/PiReplyBody.svelte
// Exported so the card's one-line status shows the same verdict chip the pane does.
export const verdictColors: Record<string, string> = {
	confirmed: "bg-green-100 text-green-800 border-green-200",
	partially_confirmed: "bg-yellow-100 text-yellow-800 border-yellow-200",
	contradicted: "bg-red-100 text-red-800 border-red-200",
	unverifiable: "bg-gray-100 text-gray-600 border-gray-200",
};
</script>

<script lang="ts">
// SIO-1789: the rendered pi verdict / investigation. It lives in the fleet pane, where
// the reply arrives; ActionConfirmationCard uses it only when there is no pane to show it.
// SIO-1635: hub replies are data. Text interpolation only, never {@html}.
import type { PiInvestigation, PiVerdict } from "@devops-agent/shared/src/pi-coms-types.ts";

let { verdict, investigation }: { verdict?: PiVerdict; investigation?: PiInvestigation } = $props();

const claimColors: Record<string, string> = {
	confirmed: "bg-green-100 text-green-800 border-green-200",
	contradicted: "bg-red-100 text-red-800 border-red-200",
	unverifiable: "bg-yellow-100 text-yellow-800 border-yellow-200",
};
</script>

{#if verdict}
	<p class="mb-2">
		<span class="text-xs px-2 py-0.5 rounded-full border {verdictColors[verdict.verdict] ?? verdictColors.unverifiable}">
			{verdict.verdict.replace(/_/g, " ")}
		</span>
	</p>
	<p class="text-sm text-gray-800 mb-2">{verdict.summary}</p>
	{#if verdict.claims.length > 0}
		<ul class="space-y-1 mb-2">
			{#each verdict.claims as claim, i (i)}
				<li class="text-xs bg-gray-50 rounded p-2">
					<div class="flex items-start gap-2">
						<span class="px-1.5 py-0.5 rounded-full border shrink-0 {claimColors[claim.status] ?? claimColors.unverifiable}">{claim.status}</span>
						<span class="text-gray-800">{claim.claim}</span>
					</div>
					<div class="text-gray-500 mt-1 pl-1">Evidence: {claim.evidence}</div>
				</li>
			{/each}
		</ul>
	{/if}
	{#if verdict.additional_observations && verdict.additional_observations.length > 0}
		<div class="text-xs text-gray-700 mb-1">
			<span class="font-medium">Also observed:</span>
			<ul class="list-disc pl-5">
				{#each verdict.additional_observations as obs, i (i)}
					<li>{obs}</li>
				{/each}
			</ul>
		</div>
	{/if}
	{#if verdict.recommended_investigation}
		<p class="text-xs text-gray-700"><span class="font-medium">Recommended next step:</span> {verdict.recommended_investigation}</p>
	{/if}
{:else if investigation}
	<p class="mb-2">
		<span class="text-xs px-2 py-0.5 rounded-full border bg-gray-100 text-gray-600 border-gray-200">
			confidence {Math.round(investigation.confidence * 100)}%
		</span>
	</p>
	<p class="text-sm text-gray-800 mb-2">{investigation.summary}</p>
	<p class="text-xs text-gray-700 mb-2"><span class="font-medium">Root cause hypothesis:</span> {investigation.root_cause_hypothesis}</p>
	{#if investigation.evidence.length > 0}
		<ul class="space-y-1 mb-2">
			{#each investigation.evidence as row, i (i)}
				<li class="text-xs bg-gray-50 rounded p-2">
					<span class="font-mono text-gray-600">{row.resource}</span>
					<span class="text-gray-800"> {row.observation}</span>
				</li>
			{/each}
		</ul>
	{/if}
	{#if investigation.suggested_actions.length > 0}
		<div class="text-xs text-gray-700">
			<span class="font-medium">Suggested actions:</span>
			<ul class="list-disc pl-5">
				{#each investigation.suggested_actions as step, i (i)}
					<li>{step}</li>
				{/each}
			</ul>
		</div>
	{/if}
{/if}
