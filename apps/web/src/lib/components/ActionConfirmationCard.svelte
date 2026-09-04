<script lang="ts">
// apps/web/src/lib/components/ActionConfirmationCard.svelte
import type { ActionResult, PendingAction, PiActionResultPayload } from "@devops-agent/shared";
import Icon from "./Icon.svelte";

let {
	action,
	onApprove,
	onDismiss,
	result,
}: {
	action: PendingAction;
	onApprove: (action: PendingAction) => void;
	onDismiss: (actionId: string) => void;
	result?: ActionResult;
} = $props();

let isExecuting = $state(false);

const toolLabels: Record<string, string> = {
	"notify-slack": "Send Slack Notification",
	"create-ticket": "Create Incident Ticket",
	// SIO-1635: pi-coms hub handoff.
	"verify-with-pi": "Verify with pi agent",
	"investigate-with-pi": "Launch pi investigation",
};

const toolIcons = {
	"notify-slack": "message-square",
	"create-ticket": "ticket",
	"verify-with-pi": "bot",
	"investigate-with-pi": "zoom-in",
} as const;

type ToolIconName = (typeof toolIcons)[keyof typeof toolIcons] | "tool";

function getToolIcon(): ToolIconName {
	const icon = toolIcons[action.tool as keyof typeof toolIcons];
	return icon ?? "tool";
}

const severityColors: Record<string, string> = {
	critical: "bg-red-100 text-red-800 border-red-200",
	high: "bg-orange-100 text-orange-800 border-orange-200",
	medium: "bg-yellow-100 text-yellow-800 border-yellow-200",
	low: "bg-blue-100 text-blue-800 border-blue-200",
	info: "bg-gray-100 text-gray-600 border-gray-200",
};

// SIO-1635: claim and verdict chips. Hub replies are data: rendered, never executed.
const claimColors: Record<string, string> = {
	confirmed: "bg-green-100 text-green-800 border-green-200",
	contradicted: "bg-red-100 text-red-800 border-red-200",
	unverifiable: "bg-yellow-100 text-yellow-800 border-yellow-200",
};

const verdictColors: Record<string, string> = {
	confirmed: "bg-green-100 text-green-800 border-green-200",
	partially_confirmed: "bg-yellow-100 text-yellow-800 border-yellow-200",
	contradicted: "bg-red-100 text-red-800 border-red-200",
	unverifiable: "bg-gray-100 text-gray-600 border-gray-200",
};

function getSeverity(): string {
	return String(action.params.severity ?? "medium");
}

function paramText(key: string): string {
	const v = action.params[key];
	return v === undefined || v === null ? "" : String(v);
}

function focusList(): string[] {
	const f = action.params.focus;
	return Array.isArray(f) ? f.map((x) => String(x)) : [];
}

// The server already validated the payload with Zod; here we only narrow on `kind`.
function piPayload(): PiActionResultPayload | null {
	const r = result?.result;
	if (!r || typeof r !== "object" || !("kind" in r)) return null;
	const kind = (r as { kind?: unknown }).kind;
	if (kind === "verdict" || kind === "investigation" || kind === "queued") return r as PiActionResultPayload;
	return null;
}

function humanize(s: string): string {
	return s.replace(/_/g, " ");
}

async function handleApprove() {
	isExecuting = true;
	onApprove(action);
}
</script>

{#if result}
	{@const pi = piPayload()}
	{#if result.status === "success" && pi?.kind === "queued"}
		<div class="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 mt-2">
			<div class="flex items-center gap-2 text-sm">
				<Icon name="check" class="w-4 h-4 text-blue-600" />
				<span class="font-medium text-blue-800">{toolLabels[action.tool] ?? action.tool}: Queued to {pi.target} mailbox</span>
			</div>
			<p class="text-xs text-blue-700 mt-1">
				No pi agent for estate {pi.estate} is online. The task is parked in the hub mailbox and will be picked up when the agent connects (message {pi.msg_id}).
			</p>
		</div>
	{:else if result.status === "success" && pi?.kind === "verdict"}
		<div class="rounded-lg border border-gray-200 bg-white px-3 py-3 mt-2 shadow-sm">
			<div class="flex items-center gap-2 mb-2">
				<Icon name="bot" class="w-4 h-4 text-tommy-navy" />
				<span class="text-sm font-semibold text-tommy-navy">{toolLabels[action.tool] ?? action.tool}</span>
				<span class="text-xs px-2 py-0.5 rounded-full border {verdictColors[pi.verdict.verdict] ?? verdictColors.unverifiable}">
					{humanize(pi.verdict.verdict)}
				</span>
				<span class="text-xs text-gray-500 ml-auto">{pi.target} / {pi.estate}</span>
			</div>
			<p class="text-sm text-gray-800 mb-2">{pi.verdict.summary}</p>
			{#if pi.verdict.claims.length > 0}
				<ul class="space-y-1 mb-2">
					{#each pi.verdict.claims as claim, i (i)}
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
			{#if pi.verdict.additional_observations && pi.verdict.additional_observations.length > 0}
				<div class="text-xs text-gray-700 mb-1">
					<span class="font-medium">Also observed:</span>
					<ul class="list-disc pl-5">
						{#each pi.verdict.additional_observations as obs, i (i)}
							<li>{obs}</li>
						{/each}
					</ul>
				</div>
			{/if}
			{#if pi.verdict.recommended_investigation}
				<p class="text-xs text-gray-700"><span class="font-medium">Recommended next step:</span> {pi.verdict.recommended_investigation}</p>
			{/if}
		</div>
	{:else if result.status === "success" && pi?.kind === "investigation"}
		<div class="rounded-lg border border-gray-200 bg-white px-3 py-3 mt-2 shadow-sm">
			<div class="flex items-center gap-2 mb-2">
				<Icon name="zoom-in" class="w-4 h-4 text-tommy-navy" />
				<span class="text-sm font-semibold text-tommy-navy">{toolLabels[action.tool] ?? action.tool}</span>
				<span class="text-xs px-2 py-0.5 rounded-full border bg-gray-100 text-gray-600 border-gray-200">
					confidence {Math.round(pi.investigation.confidence * 100)}%
				</span>
				<span class="text-xs text-gray-500 ml-auto">{pi.target} / {pi.estate}</span>
			</div>
			<p class="text-sm text-gray-800 mb-2">{pi.investigation.summary}</p>
			<p class="text-xs text-gray-700 mb-2"><span class="font-medium">Root cause hypothesis:</span> {pi.investigation.root_cause_hypothesis}</p>
			{#if pi.investigation.evidence.length > 0}
				<ul class="space-y-1 mb-2">
					{#each pi.investigation.evidence as row, i (i)}
						<li class="text-xs bg-gray-50 rounded p-2">
							<span class="font-mono text-gray-600">{row.resource}</span>
							<span class="text-gray-800"> {row.observation}</span>
						</li>
					{/each}
				</ul>
			{/if}
			{#if pi.investigation.suggested_actions.length > 0}
				<div class="text-xs text-gray-700">
					<span class="font-medium">Suggested actions:</span>
					<ul class="list-disc pl-5">
						{#each pi.investigation.suggested_actions as step, i (i)}
							<li>{step}</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	{:else}
		<div class="rounded-lg border px-3 py-2 mt-2 {result.status === 'success' ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}">
			<div class="flex items-center gap-2 text-sm">
				<Icon name={result.status === "success" ? "check" : "x"} class="w-4 h-4 {result.status === 'success' ? 'text-green-600' : 'text-red-600'}" />
				<span class="font-medium {result.status === 'success' ? 'text-green-800' : 'text-red-800'}">
					{toolLabels[action.tool] ?? action.tool}: {result.status === "success" ? "Completed" : "Failed"}
				</span>
				{#if result.status === "success" && result.result?.url}
					<a href={String(result.result.url)} target="_blank" rel="noopener noreferrer" class="text-tommy-navy underline ml-auto">
						View
					</a>
				{/if}
				{#if result.status === "error" && result.error}
					<span class="text-red-600 ml-auto">{result.error}</span>
				{/if}
			</div>
		</div>
	{/if}
{:else}
	<div class="rounded-lg border border-gray-200 bg-white px-3 py-3 mt-2 shadow-sm">
		<div class="flex items-center gap-2 mb-2">
			<Icon name={getToolIcon()} class="w-4 h-4 text-tommy-navy" />
			<span class="text-sm font-semibold text-tommy-navy">{toolLabels[action.tool] ?? action.tool}</span>
			<span class="text-xs px-2 py-0.5 rounded-full border {severityColors[getSeverity()] ?? severityColors.medium}">
				{getSeverity()}
			</span>
		</div>

		<p class="text-xs text-gray-500 mb-2">{action.reason}</p>

		{#if action.tool === "notify-slack"}
			<div class="text-sm space-y-1 mb-3">
				<div><span class="text-gray-500">Channel:</span> {action.params.channel ?? "(default)"}</div>
				<div class="bg-gray-50 rounded p-2 text-xs whitespace-pre-wrap">{action.params.message}</div>
			</div>
		{/if}

		{#if action.tool === "create-ticket"}
			<div class="text-sm space-y-1 mb-3">
				<div><span class="text-gray-500">Title:</span> {action.params.title}</div>
				<div class="bg-gray-50 rounded p-2 text-xs whitespace-pre-wrap max-h-24 overflow-y-auto">{action.params.description}</div>
			</div>
		{/if}

		{#if action.tool === "verify-with-pi"}
			<div class="text-sm space-y-1 mb-3">
				<div><span class="text-gray-500">Estate:</span> {paramText("estate")}</div>
				<div><span class="text-gray-500">Agent:</span> {paramText("target") || paramText("estate")} <span class="text-gray-400">(falls back to the ops mailbox when offline)</span></div>
				{#if paramText("summary")}
					<div class="bg-gray-50 rounded p-2 text-xs whitespace-pre-wrap">{paramText("summary")}</div>
				{/if}
			</div>
		{/if}

		{#if action.tool === "investigate-with-pi"}
			<div class="text-sm space-y-1 mb-3">
				<div><span class="text-gray-500">Estate:</span> {paramText("estate")}</div>
				<div><span class="text-gray-500">Agent:</span> {paramText("target") || paramText("estate")}</div>
				{#if focusList().length > 0}
					<div class="bg-gray-50 rounded p-2 text-xs">
						<div class="text-gray-500 mb-1">Open questions:</div>
						<ul class="list-disc pl-4 space-y-0.5">
							{#each focusList() as item, i (i)}
								<li>{item}</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
		{/if}

		<div class="flex gap-2">
			<button
				onclick={handleApprove}
				disabled={isExecuting}
				class="px-3 py-1 text-xs font-medium rounded bg-tommy-navy text-white hover:bg-tommy-navy/90 disabled:opacity-50 transition-colors"
			>
				{isExecuting ? "Executing..." : "Approve"}
			</button>
			<button
				onclick={() => onDismiss(action.id)}
				disabled={isExecuting}
				class="px-3 py-1 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
			>
				Dismiss
			</button>
		</div>
	</div>
{/if}
