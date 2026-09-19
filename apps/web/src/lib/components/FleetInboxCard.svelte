<script lang="ts">
// apps/web/src/lib/components/FleetInboxCard.svelte
// SIO-1652: the fleet inbox digest rendered as data next to the report. Excerpts
// are untrusted text from spokes and operators: shown inert, never interpreted.
import type { FleetInboxDigest, FleetInboxEntry, FleetInboxEstate } from "@devops-agent/shared";

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

// SIO-1825: the monitor's three kinds read differently. A daily digest is a 24 h
// rollup that ships whatever happens (and is the monitor's dead-man signal); an
// incident report is a fresh finding. Labelling both "monitor report" would hide
// that difference from the operator reading the card.
const kindLabel: Record<FleetInboxEntry["kind"], string> = {
	"monitor-report": "incident report",
	"daily-digest": "daily digest",
	"suppression-review": "suppression review",
	conversation: "conversation",
	other: "message",
};

// SIO-1815: when the digest is scoped, the reports naming a focus service are the card;
// the rest of the account's inbox is one click away rather than in the way.
const scoped = $derived(digest.focusServices.length > 0);

// SIO-1825: " (1 incident report, 2 daily digests)". Empty when the estate has only
// one kind, so the common single-kind case reads exactly as it did before.
function kindBreakdown(counts: FleetInboxEstate["counts"]): string {
	const parts = [
		counts.incidentReports > 0 ? `${counts.incidentReports} incident report(s)` : "",
		counts.dailyDigests > 0 ? `${counts.dailyDigests} daily digest(s)` : "",
		counts.suppressionReviews > 0 ? `${counts.suppressionReviews} suppression review(s)` : "",
	].filter((p) => p !== "");
	return parts.length > 1 ? ` (${parts.join(", ")})` : "";
}

function senderLine(entry: FleetInboxEntry): string {
	return entry.target ? `${entry.sender} to ${entry.target}` : entry.sender;
}

function when(iso: string): string {
	return iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
}
</script>

{#snippet reportRow(entry: FleetInboxEntry)}
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
    {#if entry.findings.length > 0}
      <p class="mt-1 flex flex-wrap gap-1">
        {#each entry.findings as finding, i (i)}
          <span class="px-1.5 py-0.5 rounded border break-all {finding.focus ? 'bg-tommy-navy border-tommy-navy text-white' : 'bg-white border-gray-200 text-gray-600'}">{finding.family}: {finding.resource}</span>
        {/each}
        {#if entry.findingCount !== null && entry.findingCount > entry.findings.length}
          <span class="px-1.5 py-0.5 rounded border bg-white border-gray-200 text-gray-400">+{entry.findingCount - entry.findings.length} more</span>
        {/if}
      </p>
    {/if}
    <p class="mt-1 text-gray-700 whitespace-pre-wrap break-words">{entry.excerpt}</p>
  </li>
{/snippet}

<div class="mt-3 rounded-lg border border-gray-200 bg-white p-4">
  <div class="flex items-center justify-between gap-2 mb-1">
    <h3 class="text-sm font-semibold text-tommy-navy">Fleet inbox</h3>
    <span class="text-xs text-gray-500">{when(digest.windowFrom)} to {when(digest.windowTo)}</span>
  </div>
  <p class="text-xs text-gray-500 mb-3">Account monitor reports from the pi-coms hubs for the assessed estates, shown as data. Not evidence.</p>
  {#if scoped}
    <p class="text-xs text-gray-600 mb-3 flex flex-wrap items-center gap-1">
      <span>Scoped to:</span>
      {#each digest.focusServices as service (service)}
        <span class="px-1.5 py-0.5 rounded border bg-tommy-navy border-tommy-navy text-white">{service}</span>
      {/each}
    </p>
  {/if}

  {#each digest.estates as estate (estate.estate)}
    <!-- SIO-1825 (Greptile, PR #854): a digest and a suppression review carry no findings,
         so `focus` is always false for them. Keying the lead on focus alone therefore buried
         every daily dead-man signal -- DEGRADED and PAUSED included -- in the collapsed
         "other services" section on EVERY scoped run, which is the normal case. They are
         account-level by nature, not about one service, so they lead alongside the focus
         reports; only incident reports about OTHER services collapse. -->
    {@const accountLevel = (e: FleetInboxEntry) => e.kind === "daily-digest" || e.kind === "suppression-review"}
    {@const lead = scoped ? estate.entries.filter((e) => e.focus || accountLevel(e)) : estate.entries}
    {@const rest = scoped ? estate.entries.filter((e) => !e.focus && !accountLevel(e)) : []}
    <section class="mb-3 last:mb-0">
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border {envBadge[estate.environment] ?? 'bg-gray-100 text-gray-600 border-gray-200'}">{estate.environment}</span>
        <span class="font-medium text-tommy-navy">{estate.estate}</span>
        <span class="text-gray-400">inboxes: {estate.inboxes.join(", ")}</span>
        <span class="ml-auto text-gray-500">{estate.counts.total} monitor message(s){kindBreakdown(estate.counts)}{scoped ? `, ${estate.counts.focus} naming a focus service` : ""}; critical {estate.counts.critical}, warn {estate.counts.warn}</span>
      </div>
      {#if estate.error}
        <p class="mt-1 text-xs text-red-700">{estate.error}</p>
      {/if}
      {#if estate.families.length > 0}
        <p class="mt-1 text-xs text-gray-600 flex flex-wrap items-center gap-1">
          <span>Categories:</span>
          {#each estate.families as family (family.family)}
            <span class="px-1.5 py-0.5 rounded border {family.focus > 0 ? 'bg-tommy-navy border-tommy-navy text-white' : 'bg-tommy-offwhite border-gray-200 text-tommy-navy'}">{family.family} {family.count}{family.focus > 0 ? ` (${family.focus} focus)` : ""}</span>
          {/each}
        </p>
      {/if}
      {#if estate.alarmNames.length > 0}
        <p class="mt-1 text-xs text-gray-600 flex flex-wrap items-center gap-1">
          <span>Alarms:</span>
          {#each estate.alarmNames as name (name)}
            <span class="px-1.5 py-0.5 rounded border bg-tommy-offwhite border-gray-200 text-tommy-navy">{name}</span>
          {/each}
        </p>
      {/if}
      {#if estate.entries.length < estate.counts.total}
        <p class="mt-1 text-xs text-gray-500">Showing {estate.entries.length} of {estate.counts.total} messages (focus first, then incident reports, then newest). Counts and categories cover all of them.</p>
      {/if}
      {#if estate.entries.length === 0 && !estate.error}
        <p class="mt-1 text-xs text-gray-400">No monitor messages in the window.</p>
      {/if}
      {#if scoped && lead.length === 0 && estate.entries.length > 0}
        <p class="mt-1 text-xs text-gray-400">No monitor report in the window names a focus service.</p>
      {/if}
      <ul>
        {#each lead as entry (entry.msgId)}
          {@render reportRow(entry)}
        {/each}
      </ul>
      {#if rest.length > 0}
        <details class="mt-1 text-xs">
          <summary class="cursor-pointer text-gray-500">{rest.length} report(s) about other services in this account</summary>
          <ul>
            {#each rest as entry (entry.msgId)}
              {@render reportRow(entry)}
            {/each}
          </ul>
        </details>
      {/if}
    </section>
  {/each}
</div>
