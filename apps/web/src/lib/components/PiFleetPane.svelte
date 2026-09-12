<script lang="ts">
// apps/web/src/lib/components/PiFleetPane.svelte
// SIO-1650: live pi-coms spokes next to the incident chat. One prompt goes to
// one spoke on the hub it was listed from. Replies are data: rendered verbatim,
// never executed, never fed to an LLM.
import type { PiFleetEnvironment } from "$lib/pi-fleet-types";
import { formatReply, isTerminal, type PiFleetSelection, type PiFleetState } from "$lib/stores/pi-fleet-reducer";
import Icon from "./Icon.svelte";

let {
	pane,
	busy,
	mailboxBusy,
	onSend,
	onRefresh,
	onSelect,
	onLoadMailbox,
	onAskAll,
	scopeEstates = [],
}: {
	pane: PiFleetState;
	busy: boolean;
	// SIO-1666: which HUB's inbox is loading, by key.
	mailboxBusy: string | null;
	onSend: (prompt: string) => void;
	onRefresh: () => void;
	onSelect: (selection: PiFleetSelection | null) => void;
	onLoadMailbox: (hubKey: string) => void;
	// SIO-1662: switch to the fleet-console AGENT. Distinct from onSend, which
	// addresses ONE spoke and renders its raw reply here: the console asks several
	// spokes and synthesizes one attributed answer in the chat. Optional, so the
	// pane still renders where the console is not available (no hub, flag off).
	onAskAll?: () => void;
	// SIO-1703: the AWS estates the operator selected for this investigation. A
	// spoke is named for the estate it serves, so this scopes the list to the
	// accounts under investigation. Empty means no scoping (nothing selected, or
	// a deployment with no estate selector) -- never "hide everything".
	scopeEstates?: string[];
} = $props();

let prompt = $state("");

// SIO-1702: the console can only ask spokes it can reach. `consoleAvailable`
// upstream is a DEPLOYMENT fact (flag + configured hub, both server-side); it
// says nothing about whether a hub is answering right now. Without this, a down
// tunnel still let the operator switch agents into a console with nothing to ask.
// Derived here rather than passed in: the pane already holds the listing.
// SIO-1704: the estate selector is the scope, and NO estate selected means no
// account is in scope -- so no spoke is addressable. (SIO-1703 treated an empty
// selection as "no narrowing" and showed the whole fleet; that let an operator
// who had deselected everything still address any account, which is the mistake
// the scoping exists to prevent. Empty now shows nothing, with the reason.)
const scoped = $derived(
	pane.hubs.map((hub) => ({ ...hub, peers: hub.peers.filter((p) => scopeEstates.includes(p.name)) })),
);
const totalSpokes = $derived(pane.hubs.reduce((n, hub) => n + hub.peers.length, 0));
const hiddenByScope = $derived(totalSpokes - scoped.reduce((n, hub) => n + hub.peers.length, 0));
// Distinguishes "nothing selected" from "selection hid everything": the first is
// a prompt to choose an estate, the second means the choice matched no spoke.
const noEstateSelected = $derived(scopeEstates.length === 0);

// SIO-1704: the ops inbox carries one report per estate, sent by `monitor-<estate>`
// (MONITOR_NAME_PREFIX, SIO-1665). Scoping the spokes without scoping the inbox
// left the operator reading findings for accounts they had excluded. A sender that
// is not estate-shaped -- a spoke replying, an operator -- has no estate to match
// and is kept: an estate filter must not silently drop what it cannot classify.
function estateOfSender(senderName: string): string | null {
	return senderName.startsWith("monitor-") ? senderName.slice("monitor-".length) : null;
}
// How many spokes the hub really has, so an emptied list is not reported as an
// unregistered fleet.
function scopedOut(hubKey: string): number {
	return pane.hubs.find((h) => h.hubKey === hubKey)?.peers.length ?? 0;
}
function inScope(senderName: string): boolean {
	const estate = estateOfSender(senderName);
	return estate === null || scopeEstates.includes(estate);
}
// Reachability follows what is SHOWN: a console that cannot address any spoke in
// scope is no more useful than one with no spokes at all.
const reachableSpokes = $derived(scoped.reduce((n, hub) => n + hub.peers.length, 0));
const canAskAll = $derived(reachableSpokes > 0);

const statusDot: Record<string, string> = {
	online: "bg-green-500",
	stale: "bg-yellow-400",
	offline: "bg-gray-300",
};

const envBadge: Record<PiFleetEnvironment, string> = {
	dev: "bg-green-100 text-green-800 border-green-200",
	stg: "bg-yellow-100 text-yellow-800 border-yellow-200",
	prd: "bg-red-100 text-red-800 border-red-200",
};

const entryChip: Record<string, string> = {
	sending: "bg-yellow-100 text-yellow-800 border-yellow-200",
	queued: "bg-yellow-100 text-yellow-800 border-yellow-200",
	delivered: "bg-yellow-100 text-yellow-800 border-yellow-200",
	budget_exhausted: "bg-yellow-100 text-yellow-800 border-yellow-200",
	complete: "bg-green-100 text-green-800 border-green-200",
	error: "bg-red-100 text-red-800 border-red-200",
	timeout: "bg-red-100 text-red-800 border-red-200",
	failed: "bg-red-100 text-red-800 border-red-200",
	expired: "bg-red-100 text-red-800 border-red-200",
};

const budgetSeconds = $derived(Math.round(pane.totalBudgetMs / 1000));
const canSend = $derived(pane.selected !== null && !busy && prompt.trim() !== "");

// SIO-1666: selection keys off the HUB -- a peer name is only unique within its
// hub, and two hubs may share an environment.
function isSelected(hubKey: string, name: string): boolean {
	return pane.selected?.hubKey === hubKey && pane.selected?.name === name;
}

function toggleSelect(hubKey: string, name: string) {
	onSelect(isSelected(hubKey, name) ? null : { hubKey, name });
}

function submit() {
	if (!canSend) return;
	onSend(prompt.trim());
	prompt = "";
}

function onKeydown(event: KeyboardEvent) {
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		submit();
	}
}
</script>

<div class="h-full flex flex-col">
  <div class="px-4 py-3 border-b border-gray-200 flex items-start justify-between gap-2">
    <div>
      <h2 class="text-sm font-semibold text-tommy-navy">Fleet spokes</h2>
      <p class="text-xs text-gray-500">Live pi agents on the pi-coms hubs. Replies are shown as data.</p>
      <!-- SIO-1662: the fleet console lives here rather than as a second header
           icon. Below the description because it LEAVES this pane: it switches
           agent, where one question reaches several spokes and comes back as one
           attributed answer, instead of the raw single-spoke reply shown here.
           SIO-1702: the label names that destination and the hint says the question
           is asked in the chat, not in this pane's box -- an arrow alone read as
           "this enables the input below", which it never did. -->
      {#if onAskAll}
        <button
          type="button"
          onclick={onAskAll}
          class="mt-2 inline-flex items-center gap-1 rounded-lg border border-tommy-accent-blue px-2.5 py-1 text-xs font-medium text-tommy-accent-blue transition-colors hover:bg-tommy-accent-blue hover:text-white disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-tommy-accent-blue"
          disabled={busy || !canAskAll}
          title={canAskAll ? undefined : "No spoke is reachable on any hub"}
        >
          Open the fleet console &rarr;
        </button>
        <p class="mt-1 text-xs text-gray-400">
          {#if canAskAll}
            Switches agent: ask one question in the chat and every spoke answers.
          {:else}
            Unavailable while no spoke is reachable.
          {/if}
        </p>
      {/if}
    </div>
    <button
      type="button"
      onclick={onRefresh}
      class="text-xs text-tommy-accent-blue hover:underline shrink-0"
    >
      Refresh
    </button>
  </div>

  {#if pane.loadError}
    <div class="px-4 py-2 text-xs text-red-700 bg-red-50 border-b border-red-200">{pane.loadError}</div>
  {/if}

  <!-- SIO-1703: the spoke list and the replies were inside ONE scroll container,
       so reading a long reply scrolled the picker out of view and selecting the
       next spoke meant scrolling back to the top. Two regions now: the picker is
       pinned (capped at 40% so it can never crowd out the replies, and scrolling
       internally when the fleet is large), the replies take the rest. -->
  <div class="shrink-0 max-h-[40%] overflow-y-auto border-b border-gray-200">
    <section class="px-4 py-3">
      {#if pane.hubs.length === 0}
        <p class="text-xs text-gray-500">No spokes are registered on any configured hub.</p>
      {/if}
      {#if noEstateSelected && totalSpokes > 0}
        <p class="text-xs text-gray-500 mb-2">
          No AWS estate selected. Choose one above to address its spoke.
        </p>
      {:else if hiddenByScope > 0}
        <p class="text-xs text-gray-400 mb-2">
          Scoped to the selected AWS estates &mdash; {hiddenByScope} other spoke{hiddenByScope === 1 ? "" : "s"} hidden.
        </p>
      {/if}
      {#each scoped as hub (hub.hubKey)}
        <div class="mb-3 last:mb-0">
          <div class="flex items-center gap-2 mb-1">
            <!-- SIO-1666: the ACCOUNT identifies the hub; the environment is a
                 badge beside it. A bare DEV/PRD badge cannot tell two prd hubs
                 in different domains apart.
                 SIO-1703: `project` is NOT shown. It is a hub-side namespace
                 derived per ENVIRONMENT (pi-coms-prd), so two prd hubs in
                 different accounts both render it -- the operator reads a value
                 that looks identifying and is not, which is the collision
                 SIO-1666 removed from routing. hubKey is the identity; project
                 stays on the wire for logs and the mailbox call. -->
            <span class="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border {envBadge[hub.environment]}">{hub.environment}</span>
            <span class="text-xs font-medium text-tommy-navy truncate">{hub.hubKey}</span>
            <button
              type="button"
              onclick={() => onLoadMailbox(hub.hubKey)}
              disabled={mailboxBusy === hub.hubKey}
              class="ml-auto shrink-0 rounded-lg border border-gray-300 px-2 py-0.5 text-xs font-medium text-tommy-accent-blue transition-colors hover:border-tommy-accent-blue hover:bg-tommy-accent-blue hover:text-white disabled:opacity-50 disabled:hover:border-gray-300 disabled:hover:bg-transparent disabled:hover:text-tommy-accent-blue"
            >
              Inbox {hub.fallbackTarget}
            </button>
          </div>
          {#if hub.error}
            <p class="text-xs text-red-700">{hub.error}</p>
          {:else if hub.peers.length === 0 && scopedOut(hub.hubKey) > 0}
            <!-- SIO-1704: the scope emptied this hub's list; the spokes ARE
                 registered, so saying otherwise would send the operator chasing a
                 fleet problem that does not exist. -->
            <p class="text-xs text-gray-400">No spoke here is in the selected scope.</p>
          {:else if hub.peers.length === 0}
            <p class="text-xs text-gray-400">No spokes are registered on this hub.</p>
          {/if}
          <ul class="space-y-1">
            {#each hub.peers as peer (peer.sessionId)}
              <li>
                <button
                  type="button"
                  onclick={() => toggleSelect(hub.hubKey, peer.name)}
                  aria-pressed={isSelected(hub.hubKey, peer.name)}
                  class="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg border transition-colors {isSelected(hub.hubKey, peer.name) ? 'border-tommy-accent-blue bg-white' : 'border-transparent hover:bg-white/60'}"
                >
                  <!-- The row is a target picker: the spoke name and whether it can
                       answer. `purpose` is agent-authored prose of unbounded length, and
                       rendering it squeezed the name column until account-shaped names
                       wrapped across three lines. It stays on the wire, unrendered. -->
                  <span class="w-2 h-2 rounded-full shrink-0 {statusDot[peer.status] ?? 'bg-gray-300'}"></span>
                  <span class="text-sm text-tommy-navy font-medium truncate">{peer.name}</span>
                  <span class="text-xs text-gray-500 shrink-0 ml-auto">{peer.status}</span>
                </button>
              </li>
            {/each}
          </ul>
          {#if pane.mailboxes[hub.hubKey]}
            {@const mailbox = pane.mailboxes[hub.hubKey]}
            <div class="mt-2 rounded-lg border border-gray-200 bg-white p-2">
              <p class="text-xs font-medium text-tommy-navy mb-1">Inbox {mailbox?.name}</p>
              {#if !mailbox || mailbox.messages.length === 0}
                <p class="text-xs text-gray-400">Empty.</p>
              {:else}
                {@const visible = mailbox.messages.filter((m) => inScope(m.senderName))}
                {#if visible.length === 0}
                  <p class="text-xs text-gray-400">No reports from the selected estates.</p>
                {/if}
                <ul class="space-y-1">
                  {#each visible as message (message.msgId)}
                    <!-- The monitor's report IS the content here, not a preview of
                         something openable: there is no detail view to click into, so a
                         140-char slice just lost the findings. Wrapped in full, and
                         `break-words` keeps an unbroken log-group or ARN from forcing a
                         horizontal scrollbar. Still rendered as data, never executed. -->
                    <li class="text-xs text-gray-700">
                      <span class="font-medium">{message.senderName}</span>
                      <span class="text-gray-400">{message.status}</span>
                      <span class="block whitespace-pre-wrap break-words text-gray-500">{message.prompt}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </section>
  </div>

  <div class="flex-1 overflow-y-auto min-h-0">
    <section class="px-4 py-3 space-y-3">
      {#if pane.entries.length === 0}
        <p class="text-xs text-gray-500">Select a spoke and send it a prompt. The reply appears here, next to the incident analysis.</p>
      {/if}
      {#each pane.entries as entry (entry.id)}
        <article class="rounded-lg border border-gray-200 bg-white p-3">
          <div class="flex items-center gap-2 text-xs">
            <span class="text-[10px] text-gray-500 truncate">{entry.hubKey}</span>
            <span class="font-medium text-tommy-navy">{entry.target}</span>
            <span class="ml-auto px-1.5 py-0.5 rounded border {entryChip[entry.status] ?? 'bg-gray-100 text-gray-600 border-gray-200'}">{entry.status}</span>
          </div>
          <p class="mt-2 text-sm text-gray-700 whitespace-pre-wrap">{entry.prompt}</p>
          {#if !isTerminal(entry.status)}
            <p class="mt-2 text-xs text-gray-500 flex items-center gap-1">
              <Icon name="spinner" class="w-3 h-3" />
              Waiting for {entry.target} (up to {budgetSeconds} s)
            </p>
          {:else}
            {#if entry.error}
              <p class="mt-2 text-xs text-red-700">{entry.error}</p>
            {/if}
            {#if formatReply(entry.response).trim() !== ""}
              <pre class="mt-2 text-xs bg-tommy-offwhite rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">{formatReply(entry.response)}</pre>
            {:else if entry.status === "complete" && !entry.error}
              <!-- SIO-1678: a completed reply with no text is a failed turn, not a
                   quiet success. A current hub stores that as error empty_reply and
                   the error line above shows it; this covers a hub not yet updated. -->
              <p class="mt-2 text-xs text-amber-700">(empty reply from {entry.target}: the spoke completed the turn with no text; treat as not answered)</p>
            {/if}
          {/if}
          {#if entry.sender}
            <p class="mt-2 text-[11px] text-gray-400">
              Reply from {entry.target} via {entry.sender} on hub {entry.hubKey}{entry.msgId ? `, message ${entry.msgId}` : ""}
            </p>
          {/if}
        </article>
      {/each}
    </section>
  </div>

  <div class="border-t border-gray-200 p-3 bg-white">
    <p class="text-xs text-gray-500 mb-1">
      {#if pane.selected}
        To <span class="font-medium text-tommy-navy">{pane.selected.name}</span> ({pane.selected.hubKey})
      {:else if canAskAll}
        <!-- SIO-1702: the box was disabled with no reason given, directly under a
             button that does not feed it. Name both paths so neither is a guess. -->
        Select a spoke above &mdash; or open the fleet console to ask them all at once.
      {:else}
        No spoke is reachable. Fix the hub above, then select a spoke.
      {/if}
    </p>
    <textarea
      bind:value={prompt}
      onkeydown={onKeydown}
      rows="3"
      placeholder="Ask the spoke (Cmd+Enter to send)"
      disabled={pane.selected === null || busy}
      class="w-full text-sm border border-gray-300 rounded-lg p-2 focus:outline-none focus:border-tommy-accent-blue disabled:bg-gray-50"
    ></textarea>
    <div class="flex justify-end mt-2">
      <button
        type="button"
        onclick={submit}
        disabled={!canSend}
        class="px-3 py-1.5 text-sm rounded-lg bg-tommy-navy text-white disabled:opacity-50 flex items-center gap-1"
      >
        <Icon name="send" class="w-4 h-4" />
        Send
      </button>
    </div>
  </div>
</div>
