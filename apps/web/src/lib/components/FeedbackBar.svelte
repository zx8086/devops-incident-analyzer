<script lang="ts">
// apps/web/src/lib/components/FeedbackBar.svelte
import Icon from "./Icon.svelte";

let {
	content,
	feedback = null,
	onFeedback,
	onCreateTicket,
	ticketCreated = false,
	onAddComment,
	commentPosted = false,
	commentTargetKey,
}: {
	content: string;
	feedback?: "up" | "down" | null;
	onFeedback: (value: "up" | "down") => void;
	onCreateTicket?: () => void;
	// SIO-1139: once this answer has a ticket, the button reflects that and is
	// disabled -- an answer produces at most one ticket.
	ticketCreated?: boolean;
	// SIO-1145: comment-mode (the thread already has a ticket and this is a later
	// answer). Only one of onCreateTicket / onAddComment is ever passed.
	onAddComment?: () => void;
	commentPosted?: boolean;
	commentTargetKey?: string;
} = $props();

let copied = $state(false);

async function handleCopy() {
	try {
		await navigator.clipboard.writeText(content);
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 2000);
	} catch {
		// clipboard API may be unavailable
	}
}
</script>

<div class="flex items-center gap-2 mt-3 p-2 bg-white border border-gray-200 rounded-lg shadow-sm animate-fade-in">
  <button
    onclick={handleCopy}
    class="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors {copied ? 'text-green-600 bg-green-50' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}"
  >
    <Icon name="copy" class="w-3 h-3" />
    {copied ? "Copied" : "Copy"}
  </button>

  {#if onCreateTicket}
    <button
      onclick={onCreateTicket}
      class="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors {ticketCreated ? 'text-green-600 bg-green-50 hover:bg-green-100' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}"
    >
      <Icon name={ticketCreated ? "check" : "ticket"} class="w-3 h-3" />
      {ticketCreated ? "Ticket created" : "Create ticket"}
    </button>
  {/if}

  {#if onAddComment}
    <button
      onclick={onAddComment}
      disabled={commentPosted}
      class="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors {commentPosted ? 'text-green-600 bg-green-50' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'} disabled:cursor-default"
    >
      <Icon name={commentPosted ? "check" : "message-square"} class="w-3 h-3" />
      {commentPosted ? "Comment added" : `Add as comment to ${commentTargetKey}`}
    </button>
  {/if}

  <div class="w-px h-4 bg-gray-200"></div>

  <span class="text-[0.625rem] text-gray-400">Helpful?</span>

  <button
    onclick={() => onFeedback("up")}
    class="p-1 rounded transition-colors {feedback === 'up' ? 'bg-green-100 text-green-600' : 'text-gray-400 hover:text-green-600 hover:bg-green-50'}"
    aria-label="Helpful"
  >
    <Icon name="thumbs-up" class="w-3.5 h-3.5" />
  </button>

  <button
    onclick={() => onFeedback("down")}
    class="p-1 rounded transition-colors {feedback === 'down' ? 'bg-red-100 text-red-600' : 'text-gray-400 hover:text-red-600 hover:bg-red-50'}"
    aria-label="Not helpful"
  >
    <Icon name="thumbs-down" class="w-3.5 h-3.5" />
  </button>
</div>
