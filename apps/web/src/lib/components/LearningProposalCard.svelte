<script lang="ts">
// apps/web/src/lib/components/LearningProposalCard.svelte
// SIO-1126: HIL learning review gate -- the distilled LearningProposal with
// per-item Approve/Reject decisions. SIO-1147: items start UNDECIDED; deciding
// collapses the item to a one-line row with Undo, and Apply unlocks once every
// item is decided (guarantees the full decisions map the resume endpoint
// requires). Approved items are written to the knowledge graph and agent
// memory on Apply.
import type { HilLearningReviewPrompt } from "$lib/stores/agent-reducer.ts";

let {
	prompt,
	disabled = false,
	onApply,
}: {
	prompt: HilLearningReviewPrompt;
	disabled?: boolean;
	onApply: (decisions: Record<string, "approve" | "reject">, edits: Record<string, Record<string, string>>) => void;
} = $props();

const proposal = $derived(prompt.proposal);

// SIO-1127: all four classes are now applied (root cause, bindings, heuristics,
// memory facts), so every item gets a decision entry and counts toward the approved total.
const itemIds = $derived(
	[
		...(prompt.proposal.rootCause ? [prompt.proposal.rootCause.id] : []),
		...prompt.proposal.bindings.map((b) => b.id),
		...prompt.proposal.heuristics.map((h) => h.id),
		...prompt.proposal.memoryFacts.map((f) => f.id),
	].filter((id) => id.length > 0),
);

// SIO-1147: three-state decisions -- absent key = undecided; each click records
// an explicit "approve" | "reject" and Undo removes the entry again.
let decided = $state<Record<string, "approve" | "reject">>({});

// SIO-1128: local per-item text edits, keyed by id -> field -> value. Seeded lazily
// from the distiller value; only fields that differ from the original are emitted.
let edits = $state<Record<string, Record<string, string>>>({});

function editValue(id: string, field: string, original: string): string {
	return edits[id]?.[field] ?? original;
}

function setEdit(id: string, field: string, value: string) {
	edits = { ...edits, [id]: { ...(edits[id] ?? {}), [field]: value } };
}

// Emit any non-blank edit that belongs to an APPROVED item. A field retyped to its exact
// original still emits -- harmless: the backend applyEdits overwrites with the same value
// and re-gates persistence on approval, so the emit is idempotent (not diffed against the
// original here to avoid threading the distiller value into this helper).
function emittedEdits(): Record<string, Record<string, string>> {
	const out: Record<string, Record<string, string>> = {};
	for (const [id, fields] of Object.entries(edits)) {
		if (decided[id] !== "approve") continue;
		const changed: Record<string, string> = {};
		for (const [field, value] of Object.entries(fields)) {
			if (value.trim().length > 0) changed[field] = value;
		}
		if (Object.keys(changed).length > 0) out[id] = changed;
	}
	return out;
}

function decide(id: string, decision: "approve" | "reject") {
	decided = { ...decided, [id]: decision };
}

function undo(id: string) {
	const { [id]: _removed, ...rest } = decided;
	decided = rest;
}

// Full decisions map for the resume endpoint (explicit approval contract): every
// item id gets an entry. Apply is gated on allDecided, so the "reject" fallback
// for an undecided id is only reachable via Reject all.
function decisions(rejectAll: boolean): Record<string, "approve" | "reject"> {
	const out: Record<string, "approve" | "reject"> = {};
	for (const id of itemIds) {
		out[id] = rejectAll ? "reject" : (decided[id] ?? "reject");
	}
	return out;
}

const decidedCount = $derived(itemIds.filter((id) => decided[id]).length);
const allDecided = $derived(itemIds.every((id) => decided[id] !== undefined));
const approvedCount = $derived(itemIds.filter((id) => decided[id] === "approve").length);
</script>

<!-- SIO-1147: explicit action pair -- the old single chip labeled the CURRENT state
     ("Approved"/"Rejected") and clicking flipped it, which read as an action. An
     undecided item shows both action buttons; clicking either collapses the item to
     a compact decided row (see decidedRow) with an Undo affordance. -->
{#snippet itemActions(id: string)}
  <div class="shrink-0 flex gap-1" role="group" aria-label="Approve or reject this item">
    <button
      type="button"
      onclick={() => decide(id, "approve")}
      {disabled}
      class="px-2 py-0.5 text-xs font-medium rounded border border-tommy-navy bg-tommy-navy text-white hover:bg-tommy-navy/90 transition-colors disabled:opacity-50"
    >
      Approve
    </button>
    <button
      type="button"
      onclick={() => decide(id, "reject")}
      {disabled}
      class="px-2 py-0.5 text-xs font-medium rounded border border-gray-300 bg-white text-gray-500 hover:bg-gray-50 transition-colors disabled:opacity-50"
    >
      Reject
    </button>
  </div>
{/snippet}

<!-- Decided items collapse to this one-line row so undecided items stay prominent.
     The status chip mirrors LearningOutcomeCard's Applied/Rejected chip styling. -->
{#snippet decidedRow(id: string, label: string, cls: string = "")}
  <div class="flex items-center gap-2 rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5 {cls}">
    <span
      class="shrink-0 px-2 py-0.5 text-xs font-medium rounded border {decided[id] === 'approve'
        ? 'bg-green-50 text-green-800 border-green-200'
        : 'bg-white text-gray-500 border-gray-300'}"
    >
      {decided[id] === "approve" ? "Approved" : "Rejected"}
    </span>
    <span class="min-w-0 flex-1 truncate text-xs text-tommy-navy">{label}</span>
    <button
      type="button"
      onclick={() => undo(id)}
      {disabled}
      class="shrink-0 text-xs font-medium text-tommy-navy underline hover:text-tommy-navy/80 transition-colors disabled:opacity-50"
    >
      Undo
    </button>
  </div>
{/snippet}

{#snippet evidence(quotes: string[])}
  <details class="mt-1">
    <summary class="text-xs text-gray-500 cursor-pointer">Evidence ({quotes.length})</summary>
    <ul class="mt-1 space-y-1">
      {#each quotes as quote}
        <li class="text-xs text-gray-600 italic border-l-2 border-tommy-accent-blue/40 pl-2">"{quote}"</li>
      {/each}
    </ul>
  </details>
{/snippet}

<div
  class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3"
  role="dialog"
  aria-labelledby="hil-review-heading"
>
  <div class="max-w-4xl mx-auto">
    <h3 id="hil-review-heading" class="text-sm font-semibold text-tommy-navy">
      Learnings from {prompt.ticketKey}
    </h3>
    <p class="text-sm text-tommy-navy/80 mt-1">{prompt.message}</p>
    <!-- SIO-1147: the review flow was previously explained nowhere in the UI. -->
    <p class="mt-1 text-xs text-gray-600">
      Decide each item: Approve writes it to the knowledge graph and agent memory on apply; Reject skips
      it. Apply becomes available once every item is decided.
    </p>

    <!-- SIO-1130: the linkage is shown here even when the match gate auto-confirmed
         (single ticket-mention pin) or auto-created, so the human always sees which
         investigation the learnings attach to before applying. -->
    {#if prompt.matchCreated}
      <p class="mt-1 text-xs text-gray-600">
        <span class="font-semibold">Matched investigation:</span> none found -- a new incident record will be
        created from the ticket on apply.
      </p>
    {:else if prompt.matchedIncidentSummary}
      <p class="mt-1 text-xs text-gray-600">
        <span class="font-semibold">Matched investigation{prompt.autoMatched ? " (auto, via ticket reference)" : ""}:</span>
        {prompt.matchedIncidentSummary}
      </p>
    {/if}

    {#if prompt.alreadyLearned}
      <p class="mt-1 text-xs text-yellow-900 bg-yellow-50 border border-yellow-400/50 rounded px-2 py-1">
        This ticket was learned from before. Re-applying updates the knowledge graph (idempotent) but skips
        duplicate memory facts.
      </p>
    {/if}

    {#if proposal.rootCause}
      {@const rootCause = proposal.rootCause}
      {#if decided[rootCause.id]}
        {@render decidedRow(rootCause.id, `Corrected root cause: ${rootCause.causeClass}`, "mt-2")}
      {:else}
      <div class="mt-2 rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5">
        <div class="flex items-start justify-between gap-2">
          <div class="text-xs text-tommy-navy">
            <p class="font-semibold">Corrected root cause: {rootCause.causeClass}</p>
            <textarea
              class="mt-0.5 w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
              rows="2"
              {disabled}
              aria-label="Root cause description"
              value={editValue(rootCause.id, "description", rootCause.description)}
              oninput={(e) => setEdit(rootCause.id, "description", e.currentTarget.value)}
            ></textarea>
            <p class="mt-0.5 font-semibold">Resolution:</p>
            <textarea
              class="mt-0.5 w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
              rows="2"
              {disabled}
              aria-label="Root cause resolution"
              value={editValue(rootCause.id, "resolution", rootCause.resolution)}
              oninput={(e) => setEdit(rootCause.id, "resolution", e.currentTarget.value)}
            ></textarea>
            {#if rootCause.invalidatedHypotheses.length > 0}
              <p class="mt-0.5 font-semibold">Ruled out:</p>
              <ul class="list-disc list-inside">
                {#each rootCause.invalidatedHypotheses as hyp}
                  <li>{hyp.hypothesis} -- {hyp.reason}</li>
                {/each}
              </ul>
            {/if}
            {#if rootCause.runbookFilename}
              <p class="mt-0.5 text-gray-600">Links resolution to runbook {rootCause.runbookFilename}</p>
            {/if}
          </div>
          {@render itemActions(rootCause.id)}
        </div>
        {@render evidence(rootCause.evidence)}
      </div>
      {/if}
    {/if}

    {#if proposal.memoryFacts.length > 0}
      <p class="mt-2 text-xs font-semibold text-tommy-navy">Durable memory facts</p>
      <div class="mt-1 space-y-1">
        {#each proposal.memoryFacts as fact (fact.id)}
          {#if decided[fact.id]}
            {@render decidedRow(fact.id, editValue(fact.id, "text", fact.text))}
          {:else}
          <div class="rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5">
            <div class="flex items-start justify-between gap-2">
              <textarea
                class="w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
                rows="2"
                {disabled}
                aria-label="Memory fact text"
                value={editValue(fact.id, "text", fact.text)}
                oninput={(e) => setEdit(fact.id, "text", e.currentTarget.value)}
              ></textarea>
              {@render itemActions(fact.id)}
            </div>
            {@render evidence(fact.evidence)}
          </div>
          {/if}
        {/each}
      </div>
    {/if}

    {#if proposal.bindings.length > 0}
      <p class="mt-2 text-xs font-semibold text-tommy-navy">Telemetry binding corrections</p>
      <div class="mt-1 space-y-1">
        {#each proposal.bindings as binding (binding.id)}
          {#if decided[binding.id]}
            {@render decidedRow(
              binding.id,
              `${binding.action.toUpperCase()} ${binding.service} ${binding.action === "invalidate" ? "!->" : "->"} ${binding.datasource} ${binding.bindingKind}=${binding.resourceId}`,
            )}
          {:else}
          <div class="rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5">
            <div class="flex items-start justify-between gap-2">
              <div class="text-xs text-tommy-navy">
                <p>
                  <span class="font-semibold uppercase">{binding.action}</span>
                  {binding.service}
                  {binding.action === "invalidate" ? "!->" : "->"}
                  {binding.datasource}
                  {binding.bindingKind}=<span class="font-mono">{binding.resourceId}</span>
                </p>
                <textarea
                  class="mt-0.5 w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
                  rows="2"
                  {disabled}
                  aria-label="Binding correction reason"
                  value={editValue(binding.id, "reason", binding.reason)}
                  oninput={(e) => setEdit(binding.id, "reason", e.currentTarget.value)}
                ></textarea>
              </div>
              {@render itemActions(binding.id)}
            </div>
            {@render evidence(binding.evidence)}
          </div>
          {/if}
        {/each}
      </div>
    {/if}

    {#if proposal.heuristics.length > 0}
      <p class="mt-2 text-xs font-semibold text-tommy-navy">Diagnostic heuristics (skill proposals)</p>
      <div class="mt-1 space-y-1">
        {#each proposal.heuristics as heuristic (heuristic.id)}
          {#if decided[heuristic.id]}
            {@render decidedRow(heuristic.id, `Heuristic: ${heuristic.name}`)}
          {:else}
          <div class="rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5">
            <div class="flex items-start justify-between gap-2">
              <div class="text-xs text-tommy-navy">
                <p class="font-semibold">{heuristic.name}</p>
                <textarea
                  class="mt-0.5 w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
                  rows="2"
                  {disabled}
                  aria-label="Heuristic description"
                  value={editValue(heuristic.id, "description", heuristic.description)}
                  oninput={(e) => setEdit(heuristic.id, "description", e.currentTarget.value)}
                ></textarea>
                <p class="mt-0.5 font-semibold">When to use:</p>
                <textarea
                  class="w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
                  rows="2"
                  {disabled}
                  aria-label="Heuristic when to use"
                  value={editValue(heuristic.id, "whenToUse", heuristic.whenToUse)}
                  oninput={(e) => setEdit(heuristic.id, "whenToUse", e.currentTarget.value)}
                ></textarea>
                <p class="mt-0.5 font-semibold">Procedure:</p>
                <textarea
                  class="w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
                  rows="2"
                  {disabled}
                  aria-label="Heuristic procedure"
                  value={editValue(heuristic.id, "procedure", heuristic.procedure)}
                  oninput={(e) => setEdit(heuristic.id, "procedure", e.currentTarget.value)}
                ></textarea>
              </div>
              {@render itemActions(heuristic.id)}
            </div>
            {@render evidence(heuristic.evidence)}
          </div>
          {/if}
        {/each}
      </div>
    {/if}

    <div class="mt-3 flex gap-2 items-center">
      <button
        type="button"
        onclick={() => onApply(decisions(false), emittedEdits())}
        disabled={disabled || !allDecided}
        class="px-3 py-1.5 text-sm font-medium bg-tommy-navy text-white rounded-md hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Apply {approvedCount} approved item{approvedCount === 1 ? "" : "s"}
      </button>
      <button
        type="button"
        onclick={() => onApply(decisions(true), {})}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium bg-white text-tommy-navy border border-tommy-navy rounded-md hover:bg-tommy-cream disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Reject all
      </button>
      {#if !allDecided}
        <span class="text-xs text-gray-500">{decidedCount} of {itemIds.length} decided</span>
      {/if}
    </div>
  </div>
</div>
