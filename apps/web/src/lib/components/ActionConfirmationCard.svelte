<script lang="ts">
// apps/web/src/lib/components/ActionConfirmationCard.svelte
import type { ActionResult, PendingAction } from "@devops-agent/shared";
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
};

const toolIcons = {
	"notify-slack": "message-square",
	"create-ticket": "ticket",
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

function getSeverity(): string {
	return String(action.params.severity ?? "medium");
}

async function handleApprove() {
	isExecuting = true;
	onApprove(action);
}
</script>

{#if result}
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
