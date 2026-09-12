<script lang="ts">
// apps/web/src/lib/components/PiFleetPane.svelte
// SIO-1650: live pi-coms spokes next to the incident chat. One prompt goes to
// one spoke on the hub it was listed from. Replies are data: never executed,
// never fed to an LLM.
// SIO-1709: "data" means never MODEL INPUT, not never formatted. The reports are
// markdown, so they render as markdown for the reader; PR #682 is untouched
// because nothing here becomes model input. The html is sanitized in both the
// browser and SSR (isomorphic-dompurify, markdown.ts) -- this pane server-renders
// agent-authored text about production accounts, so a browser-only guard would
// leave untrusted input on an unsanitized path.
import type { PiFleetEnvironment } from "$lib/pi-fleet-types";
import { formatReply, isTerminal, type PiFleetSelection, type PiFleetState } from "$lib/stores/pi-fleet-reducer";
import Icon from "./Icon.svelte";
import MarkdownRenderer from "./MarkdownRenderer.svelte";

let {
	pane,
	busy,
	mailboxBusy,
	onSend,
	onRefresh,
	onSelect,
	onLoadMailbox,
	scopeEstates = [],
}: {
	pane: PiFleetState;
	busy: boolean;
	// SIO-1666: which HUB's inbox is loading, by key.
	mailboxBusy: string | null;
	// SIO-1708: the visible (estate-scoped) spokes travel with the prompt so a
	// no-selection send reaches exactly what the pane is showing.
	onSend: (prompt: string, visible: { hubKey: string; name: string }[]) => void;
	onRefresh: () => void;
	onSelect: (selection: PiFleetSelection | null) => void;
	onLoadMailbox: (hubKey: string, estates: string[]) => void;
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

// SIO-1705: the inbox scope moved to the server (readFleetMailbox), which needs it
// to choose WHICH rows to fetch. The SIO-1704 client-side filter is gone with it --
// hiding rows after the hub had already capped the window was the bug.
// How many spokes the hub really has, so an emptied list is not reported as an
// unregistered fleet.
function scopedOut(hubKey: string): number {
	return pane.hubs.find((h) => h.hubKey === hubKey)?.peers.length ?? 0;
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
// SIO-1708: every spoke the pane is currently SHOWING, in render order. With no
// selection this is the send target set, so "all" always means "all in scope" --
// scoping to eu-oit-prd makes that one spoke the whole fleet, never a back door
// to the accounts the operator excluded.
const visibleTargets = $derived(
	scoped.flatMap((hub) => hub.peers.map((peer) => ({ hubKey: hub.hubKey, name: peer.name }))),
);
// A prompt needs a target: the selected spoke, or -- with none selected -- the
// visible ones. Nothing reachable still means nothing to send to.
const canSend = $derived(!busy && prompt.trim() !== "" && (pane.selected !== null || visibleTargets.length > 0));

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
	onSend(prompt.trim(), visibleTargets);
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
      <!-- SIO-1706: no "open the fleet console" button. The header pi icon toggles
           THIS pane and the box below addresses the spokes -- this pane is the
           console, so a button offering to open one advertised a door that does
           not exist. SIO-1702 made that label more explicit instead of asking
           whether the destination was real. The pi-fleet-console AGENT is still
           reachable from the header agent control, where switching agents lives. -->
    </div>
    <!-- SIO-1712: a bare text link did not read as a control and gave no sign it
         was working. Same bordered small-action style as the Inbox button below,
         and it finally honours the `busy` prop it had been ignoring. -->
    <button
      type="button"
      onclick={onRefresh}
      disabled={busy}
      aria-label="Refresh the fleet spoke list"
      class="shrink-0 flex items-center gap-1 rounded-lg border border-gray-300 px-2 py-1 text-xs font-medium text-tommy-accent-blue transition-colors hover:border-tommy-accent-blue hover:bg-tommy-accent-blue hover:text-white disabled:opacity-50 disabled:hover:border-gray-300 disabled:hover:bg-transparent disabled:hover:text-tommy-accent-blue"
    >
      <Icon name="refresh" class="w-3 h-3 {busy ? 'animate-spin motion-reduce:animate-none' : ''}" />
      {busy ? "Refreshing…" : "Refresh"}
    </button>
  </div>

  {#if pane.loadError}
    <div class="px-4 py-2 text-xs text-red-700 bg-red-50 border-b border-red-200">{pane.loadError}</div>
  {/if}

  <!-- SIO-1703: the spoke list and the replies were inside ONE scroll container,
       so reading a long reply scrolled the picker out of view and selecting the
       next spoke meant scrolling back to the top. Two regions now: the picker is
       pinned (capped so it can never crowd out the replies, and scrolling
       internally when the fleet is large), the replies take the rest.
       SIO-1712: the ops inbox card used to be nested HERE, so a whole daily
       digest rendered through a letterbox while the replies region sat empty
       below it. The card moved to the scroll region below; what is left here is
       rows, which need less.
       SIO-1715: the cap is a REM, not a percentage. A percentage splits a short
       pane badly -- this pane is viewport-bound (see +page.svelte) minus the
       page chrome, and that chrome is tallest exactly when this pane is usable
       (SIO-1704 means an AWS estate is always selected, so its selector row is
       always rendered), so 35% of a small total gave the target list more room
       than the report being read.
       SIO-1717: the ceiling is 20rem, not 11rem. 11rem (176px) was tuned to
       beat the digest at every height and ignored how many spokes there are:
       the real prd fleet is SIX, which needs 278px, so two rows were unreachable
       while the region below sat empty. The picker is `shrink-0` with a max, so
       it takes only what its rows need -- 6 spokes fit inside 20rem with 287px
       still left for the digest on a 565px pane, and only a fleet beyond ~7
       spokes scrolls internally. Sized to the content, capped for the outlier. -->
  <!-- SIO-1718: the picker may SHRINK. It was `shrink-0`, so on a short pane it
       held its full height, starved the digest region to 0px and pushed the
       composer past the pane's `overflow-hidden` edge -- the spokes looked
       truncated and the reply box was gone. Now it yields into whatever the
       digest does not need, scrolling internally instead of clipping. -->
  <div class="min-h-0 shrink max-h-[20rem] overflow-y-auto border-b border-gray-200">
    <section class="px-4 pt-2 pb-3">
      {#if pane.hubs.length === 0}
        <p class="text-xs text-gray-500">No spokes are registered on any configured hub.</p>
      {/if}
      {#if noEstateSelected && totalSpokes > 0}
        <p class="text-xs text-gray-500 mb-2">
          No AWS estate selected. Choose one above to address its spoke.
        </p>
      {:else if hiddenByScope > 0}
        <p class="text-xs text-gray-600 mb-2">
          Scoped to the selected AWS estates &mdash; {hiddenByScope} other spoke{hiddenByScope === 1 ? "" : "s"} hidden.
        </p>
      {/if}
      {#each scoped as hub (hub.hubKey)}
        <div class="mb-3 last:mb-0">
          <!-- SIO-1714: STICKY. SIO-1703 pinned the picker as a capped scroll
               region, which is not the same as pinning what is in it: with six
               spokes the rows overflow the cap, and scrolling to reach the last
               one carried the hub header off the top -- so the operator lost
               both which hub they were looking at and the Inbox button, the two
               things that must never scroll away. The rows still scroll; their
               header does not. Opaque background, or rows show through it. -->
          <div class="sticky top-0 z-10 -mx-4 mb-1 flex items-center gap-2 bg-tommy-cream px-4 py-1">
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
            <!-- SIO-1707: the hub account runs a read-only spoke like every other
                 account, so its name is BOTH this hub and one of the spokes below
                 it -- eu-shared-services-prd appears twice, meaning two different
                 things. Both are correct, so neither is renamed; the row is
                 labelled by ROLE instead. Without it the header differs from a
                 spoke row only by a badge and a missing status dot, which reads
                 as styling rather than as a different kind of thing. -->
            <span class="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border border-gray-300 bg-gray-100 text-gray-600">hub</span>
            <span class="text-xs font-medium text-tommy-navy truncate">{hub.hubKey}</span>
            <button
              type="button"
              onclick={() => onLoadMailbox(hub.hubKey, scopeEstates)}
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
            <p class="text-xs text-gray-600">No spoke here is in the selected scope.</p>
          {:else if hub.peers.length === 0}
            <p class="text-xs text-gray-600">No spokes are registered on this hub.</p>
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
        </div>
      {/each}
    </section>
  </div>

  <!-- SIO-1718: a floor, so the digest can never be squeezed to nothing by a
       long spoke list on a short pane. min-h-0 alone let flex collapse it. -->
  <div class="flex-1 overflow-y-auto min-h-[8rem]">
    <section class="px-4 py-3 space-y-3">
      <!-- SIO-1712: the ops inbox card lives HERE now, not nested under the spoke
           picker. A daily digest is the longest thing this pane ever shows, and
           under the picker's cap it rendered through a letterbox while this
           region sat empty. It shares the scroll budget with the replies it
           belongs beside, and collapses so several loaded mailboxes and a
           running reply can coexist.
           Severity is NOT parsed out of the text: the digest arrives as one
           opaque markdown string (no severity field on the wire), so ranking is
           typographic -- muted metadata, full-contrast body -- and the monitor's
           own markdown carries the emphasis. Still data, never executed. -->
      {#each scoped as hub (hub.hubKey)}
        {#if pane.mailboxes[hub.hubKey]}
          {@const mailbox = pane.mailboxes[hub.hubKey]}
          <details open class="group rounded-lg border border-gray-200 bg-white p-3">
            <summary class="flex items-center gap-2 text-xs cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <span class="text-[10px] text-gray-500 truncate">{hub.hubKey}</span>
              <span class="font-medium text-tommy-navy">Inbox {mailbox?.name}</span>
              <span class="ml-auto shrink-0 text-[10px] text-gray-500">
                {mailbox?.messages.length ?? 0} report{(mailbox?.messages.length ?? 0) === 1 ? "" : "s"}
              </span>
              <Icon name="chevron-down" class="w-3 h-3 text-gray-500 shrink-0 transition-transform group-open:rotate-180" />
            </summary>
            <!-- SIO-1705: the server returns exactly the anchored range (each
                 estate's newest daily digest onward), so there is no client-side
                 filter here. The SIO-1704 filter hid rows AFTER a fixed cap had
                 already decided which rows were fetched, which is the bug. -->
            {#if !mailbox || mailbox.messages.length === 0}
              <p class="mt-2 text-xs text-gray-500">No reports from the selected estates.</p>
            {:else}
              {#if mailbox.missingDigest.length > 0}
                <p class="mt-2 text-xs text-amber-700">
                  No daily digest found for {mailbox.missingDigest.join(", ")} &mdash; showing all
                  messages held for {mailbox.missingDigest.length === 1 ? "it" : "them"}.
                </p>
              {/if}
              {#if mailbox.windowTruncated}
                <p class="mt-2 text-xs text-amber-700">
                  The hub returned a full window, so an older digest may sit beyond it.
                </p>
              {/if}
              <!-- SIO-1714: the daily digest is the report of record the whole
                   range hangs off -- every other row is something that happened
                   SINCE it. Rendering them identically left the eye nothing to
                   land on. The digest keeps the full-weight treatment and says
                   what it is; the follow-ups are indented under a rule, so the
                   ordering reads as "this digest, then what came after".
                   `isDigest` is set server-side by anchorOnDigest (the same pass
                   that slices the range), never re-derived here: an estate with
                   no digest in the window starts mid-range and marks nothing,
                   which position alone could not express. -->
              <ul class="mt-2 space-y-2">
                {#each mailbox.messages as message (message.msgId)}
                  <!-- The monitor's report IS the content here, not a preview of
                       something openable: there is no detail view to click into, so a
                       140-char slice just lost the findings. Wrapped in full, and
                       `break-words` keeps an unbroken log-group or ARN from forcing a
                       horizontal scrollbar. Still rendered as data, never executed. -->
                  <li class={message.isDigest ? "" : "ml-3 border-l border-gray-200 pl-3"}>
                    <div class="flex items-center gap-2 text-[10px]">
                      {#if message.isDigest}
                        <!-- Named, not inferred from the [info]/[warn] prefix: a
                             degraded digest is written [warn] and is the one most
                             worth spotting. -->
                        <!-- SIO-1717: solid accent blue (white on #166C96, 5.80:1),
                             not the previous navy tint. Navy is the card title and
                             the hubKey, so a navy chip merged with the header instead
                             of marking the anchor row; accent blue is also distinct
                             from the red PRD environment pill above. -->
                        <span class="shrink-0 rounded bg-tommy-accent-blue px-1.5 py-0.5 font-semibold uppercase tracking-wide text-white">
                          Daily digest
                        </span>
                      {/if}
                      <span class="truncate {message.isDigest ? 'font-medium text-gray-600' : 'text-gray-500'}">{message.senderName}</span>
                      <span class="shrink-0 text-gray-500">{message.status}</span>
                    </div>
                    <!-- SIO-1709: the monitor writes these as markdown (bold findings,
                         numbered lists), so a literal render showed the asterisks.
                         SIO-1712: a <span class="block"> wrapped block-level markdown
                         output; it is a <div>. Same offwhite surface as a spoke reply
                         body, so a digest and a reply read as one kind of thing --
                         and gray-700 because gray-500 on offwhite is 4.02:1, under
                         the 4.5:1 floor.
                         SIO-1714: the follow-up keeps that same legible gray-700; it
                         is subordinate by POSITION and surface, not by being harder
                         to read. Dimming live findings is the SIO-1704 mistake. -->
                    <div class="mt-1 text-gray-700 overflow-x-auto break-words {message.isDigest ? 'bg-tommy-offwhite rounded p-2' : 'px-0.5'}">
                      <MarkdownRenderer content={message.prompt} />
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </details>
        {/if}
      {/each}
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
              <Icon name="spinner" class="w-3 h-3 animate-spin motion-reduce:animate-none" />
              Waiting for {entry.target} (up to {budgetSeconds} s)
            </p>
          {:else}
            {#if entry.error}
              <p class="mt-2 text-xs text-red-700">{entry.error}</p>
            {/if}
            {#if formatReply(entry.response).trim() !== ""}
              <!-- SIO-1709: a STRING reply is the agent's prose and is markdown; an
                   OBJECT reply is a schema-constrained payload that formatReply
                   JSON-stringifies, and markdown would eat its braces and
                   indentation. The reply type decides, so neither is mangled to
                   suit the other. -->
              {#if typeof entry.response === "string"}
                <div class="mt-2 text-xs bg-tommy-offwhite rounded p-2 overflow-x-auto break-words">
                  <MarkdownRenderer content={entry.response} />
                </div>
              {:else}
                <pre class="mt-2 text-xs bg-tommy-offwhite rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">{formatReply(entry.response)}</pre>
              {/if}
            {:else if entry.status === "complete" && !entry.error}
              <!-- SIO-1678: a completed reply with no text is a failed turn, not a
                   quiet success. A current hub stores that as error empty_reply and
                   the error line above shows it; this covers a hub not yet updated. -->
              <p class="mt-2 text-xs text-amber-700">(empty reply from {entry.target}: the spoke completed the turn with no text; treat as not answered)</p>
            {/if}
          {/if}
          {#if entry.sender}
            <p class="mt-2 text-[11px] text-gray-600">
              Reply from {entry.target} via {entry.sender} on hub {entry.hubKey}{entry.msgId ? `, message ${entry.msgId}` : ""}
            </p>
          {/if}
        </article>
      {/each}
    </section>
  </div>

  <!-- SIO-1714: the composer is a FIXED block, so every pixel it takes comes out
       of the digest. Measured on a 560px pane it held 169px against the digest's
       133px -- the box to ask a question was bigger than the report being read.
       Two rows and tighter padding; the textarea still grows as you type. -->
  <!-- SIO-1718: shrink-0 -- the send box is the pane's primary control and must
       never be the thing that gets squeezed out. -->
  <div class="shrink-0 border-t border-gray-200 px-3 py-2 bg-white">
    <p class="text-xs text-gray-500 mb-1">
      {#if pane.selected}
        To <span class="font-medium text-tommy-navy">{pane.selected.name}</span> ({pane.selected.hubKey})
      {:else if canAskAll}
        <!-- SIO-1708: no selection is not an error state -- it means ask everyone in
             scope. Name the count so a scoped fan-out is never mistaken for the
             whole fleet. -->
        To all {visibleTargets.length} spoke{visibleTargets.length === 1 ? "" : "s"} in scope &mdash; or select one above.
      {:else}
        No spoke is reachable. Fix the hub above, then select a spoke.
      {/if}
    </p>
    <textarea
      bind:value={prompt}
      onkeydown={onKeydown}
      rows="2"
      placeholder={pane.selected ? "Ask the spoke (Cmd+Enter to send)" : "Ask every spoke in scope (Cmd+Enter to send)"}
      disabled={busy || (pane.selected === null && visibleTargets.length === 0)}
      class="w-full text-sm border border-gray-300 rounded-lg p-2 focus:outline-none focus:border-tommy-accent-blue disabled:bg-gray-50"
    ></textarea>
    <div class="flex justify-end mt-1.5">
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
