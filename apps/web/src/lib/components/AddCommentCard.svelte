<script lang="ts">
// apps/web/src/lib/components/AddCommentCard.svelte
// Deep import, NOT the barrel: this component ships to the browser, and a value
// import of the @devops-agent/shared index drags server-only modules into the
// client bundle (see CreateTicketCard for the same convention).
import type { TicketProviderId } from "@devops-agent/shared/src/ticket-types.ts";
import Icon from "./Icon.svelte";

let {
	ticketKey,
	ticketUrl,
	content,
	providerId,
	posted = false,
	onPosted,
	onClose,
}: {
	ticketKey: string;
	ticketUrl?: string;
	content: string;
	providerId: TicketProviderId;
	// SIO-1145: posted state is owned by the parent (ChatMessage) so it survives
	// this card unmounting -- once this answer is commented, the button stays
	// disabled and reopening shows the confirmation.
	posted?: boolean;
	onPosted?: () => void;
	onClose: () => void;
} = $props();

let submitting = $state(false);
let errorMessage = $state<string | null>(null);

// Short header marks the comment as a follow-up, then the full answer markdown.
const HEADER = "_Follow-up analysis added from the incident assistant._\n\n";
const commentBody = $derived(`${HEADER}${content}`);
// Mirror AddCommentRequestSchema's body cap so an over-long answer fails with a
// clear message here instead of a generic 400 from the API.
const MAX_COMMENT_BODY = 32_000;

function errorFrom(data: unknown, status: number): string {
	if (data && typeof data === "object" && "error" in data) {
		const message = (data as { error?: unknown }).error;
		if (typeof message === "string") return message;
	}
	return `Request failed (${status})`;
}

async function post() {
	if (submitting || posted) return;
	if (commentBody.length > MAX_COMMENT_BODY) {
		errorMessage = `This answer is too long to post as a comment (${commentBody.length.toLocaleString()} of ${MAX_COMMENT_BODY.toLocaleString()} characters).`;
		return;
	}
	submitting = true;
	errorMessage = null;
	try {
		const res = await fetch(`/api/tickets/${providerId}/comment`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ issueKey: ticketKey, body: commentBody }),
		});
		const data: unknown = await res.json();
		if (!res.ok) throw new Error(errorFrom(data, res.status));
		// The parent owns the posted record so it outlives this card.
		onPosted?.();
	} catch (err) {
		errorMessage = err instanceof Error ? err.message : "Failed to add the comment";
	} finally {
		submitting = false;
	}
}
</script>

{#if posted}
	<div class="rounded-lg border border-green-200 bg-green-50 px-3 py-2 mt-2" role="dialog" aria-label="Comment added">
		<div class="flex items-center gap-2 text-sm">
			<Icon name="check" class="w-4 h-4 text-green-600" />
			<span class="font-medium text-green-800">Comment added to {ticketKey}</span>
			{#if ticketUrl}
				<a href={ticketUrl} target="_blank" rel="noopener noreferrer" class="text-tommy-navy underline ml-auto">
					View
				</a>
			{/if}
			<button
				onclick={onClose}
				class="text-xs text-gray-500 hover:text-gray-700 {ticketUrl ? '' : 'ml-auto'}"
			>
				Close
			</button>
		</div>
	</div>
{:else}
	<div class="rounded-lg border border-gray-200 bg-white px-3 py-3 mt-2 shadow-sm" role="dialog" aria-label="Add comment">
		<div class="flex items-center gap-2 mb-2">
			<Icon name="message-square" class="w-4 h-4 text-tommy-navy" />
			<span class="text-sm font-semibold text-tommy-navy">Add this answer as a comment to {ticketKey}</span>
			<button onclick={onClose} class="ml-auto p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors" aria-label="Close">
				<Icon name="x" class="w-3.5 h-3.5" />
			</button>
		</div>

		<p class="text-xs text-gray-500 mb-3">The full follow-up answer will be posted as a markdown comment on {ticketKey}.</p>

		{#if errorMessage}
			<p class="text-xs text-red-600 mb-2" role="alert">{errorMessage}</p>
		{/if}

		<div class="flex gap-2">
			<button
				onclick={post}
				disabled={submitting}
				class="px-3 py-1 text-xs font-medium rounded bg-tommy-navy text-white hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
			>
				{submitting ? "Posting..." : "Post comment"}
			</button>
			<button
				onclick={onClose}
				disabled={submitting}
				class="px-3 py-1 text-xs font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
			>
				Cancel
			</button>
		</div>
	</div>
{/if}
