<script lang="ts">
// apps/web/src/lib/components/FleetInboxCard.svelte
// SIO-1652: the fleet inbox digest rendered as data next to the report. Excerpts
// are untrusted text from spokes and operators: shown inert, never interpreted.
import type { FleetInboxDigest, FleetInboxEntry } from "@devops-agent/shared";

let { digest }: { digest: FleetInboxDigest } = $props();

const envBadge: Record<string, string> = {
	dev: "bg-green-100 text-green-800 border-green-200",
	stg: "bg-yellow-100 text-yellow-800 border-yellow-200",
	prd: "bg-red-100 text-red-800 border-red-200",
};

const severityChip: Record<string, string> = {
	critical: "bg-red-100 text-red-800 border-red-200",
	warn: "bg-yellow-100 text-yellow-800 border-yellow-200",
	info: "bg-gray-100 text-gray-600 border-gray-200",
};

const kindLabel: Record<FleetInboxEntry["kind"], string> = {
	"monitor-report": "monitor report",
	conversation: "conversation",
	other: "message",
};

function senderLine(entry: FleetInboxEntry): string {
	return entry.target ? `${entry.sender} to ${entry.target}` : entry.sender;
}

function when(iso: string): string {
	return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}
</script>

<div class="mt-3 rounded-lg border border-gray-200 bg-white p-4">
  <div class="flex items-center justify-between gap-2 mb-1">
    <h3 class="text-sm font-semibold text-tommy-navy">Fleet inbox</h3>
    <span class="text-xs text-gray-500">{when(digest.windowFrom)} to {when(digest.windowTo)}</span>
  </div>
  <p class="text-xs text-gray-500 mb-3">Live pi-coms hub notes for the assessed estates, shown as data. Not evidence.</p>

  {#each digest.estates as estate (estate.estate)}
    <section class="mb-3 last:mb-0">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border {envBadge[estate.environment] ?? 'bg-gray-100 text-gray-600 border-gray-200'}">{estate.environment}</span>
        <span class="font-medium text-tommy-navy">{estate.estate}</span>
        <span class="text-gray-400">inboxes: {estate.inboxes.join(", ")}</span>
        <span class="ml-auto text-gray-500">{estate.counts.total} message(s): {estate.counts.monitorReports} monitor report(s), {estate.counts.conversations} conversation(s); critical {estate.counts.critical}, warn {estate.counts.warn}</span>
      </div>
      {#if estate.error}
        <p class="mt-1 text-xs text-red-700">{estate.error}</p>
      {/if}
      {#if estate.alarmNames.length > 0}
        <p class="mt-1 text-xs text-gray-600 flex flex-wrap items-center gap-1">
          <span>Alarms:</span>
          {#each estate.alarmNames as name (name)}
            <span class="px-1.5 py-0.5 rounded border bg-tommy-offwhite border-gray-200 text-tommy-navy">{name}</span>
          {/each}
        </p>
      {/if}
      {#if estate.entries.length === 0 && !estate.error}
        <p class="mt-1 text-xs text-gray-400">No messages in the window.</p>
      {/if}
      <ul>
        {#each estate.entries as entry (entry.msgId)}
          <li class="border-t border-gray-100 py-2 text-xs">
            <div class="flex flex-wrap items-center gap-2">
              <span class="px-1.5 py-0.5 rounded border bg-gray-100 text-gray-600 border-gray-200">{kindLabel[entry.kind]}</span>
              {#if entry.severity}
                <span class="px-1.5 py-0.5 rounded border {severityChip[entry.severity]}">{entry.severity}</span>
              {/if}
              <span class="text-gray-500">{senderLine(entry)}</span>
              {#if entry.findingCount !== null}
                <span class="text-gray-400">{entry.findingCount} finding(s)</span>
              {/if}
              <span class="ml-auto text-gray-400">{when(entry.createdAt)}</span>
            </div>
            <p class="mt-1 text-gray-700 whitespace-pre-wrap break-words">{entry.excerpt}</p>
          </li>
        {/each}
      </ul>
    </section>
  {/each}
</div>
