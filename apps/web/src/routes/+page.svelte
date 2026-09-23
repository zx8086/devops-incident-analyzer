<script lang="ts">
// apps/web/src/routes/+page.svelte
import { onDestroy, onMount } from "svelte";
import { AGENT_CHOICES, type AgentId, agentChoice, DEFAULT_AGENT_ID, isAgentId } from "$lib/agent-ids";
import AwsEstateSelector from "$lib/components/AwsEstateSelector.svelte";
import ChatInput from "$lib/components/ChatInput.svelte";
import ChatMessage from "$lib/components/ChatMessage.svelte";
import { followAfterScroll } from "$lib/components/chat-follow";
import DataSourceSelector from "$lib/components/DataSourceSelector.svelte";
import DriftReportCard from "$lib/components/DriftReportCard.svelte";
import ElasticDeploymentSelector from "$lib/components/ElasticDeploymentSelector.svelte";
import FleetUpgradeChoiceCard from "$lib/components/FleetUpgradeChoiceCard.svelte";
import GraphTriagePanel from "$lib/components/GraphTriagePanel.svelte";
import Icon from "$lib/components/Icon.svelte";
import LandingZoneTopologyCard from "$lib/components/LandingZoneTopologyCard.svelte";
import LearningMatchCard from "$lib/components/LearningMatchCard.svelte";
import LearningOutcomeCard from "$lib/components/LearningOutcomeCard.svelte";
import LearningProposalCard from "$lib/components/LearningProposalCard.svelte";
import PiFleetPane from "$lib/components/PiFleetPane.svelte";
import PipelineProgressCard from "$lib/components/PipelineProgressCard.svelte";
import PlanReviewCard from "$lib/components/PlanReviewCard.svelte";
import ReconcileChoiceCard from "$lib/components/ReconcileChoiceCard.svelte";
import RenovateTriggerChoiceCard from "$lib/components/RenovateTriggerChoiceCard.svelte";
import StreamingProgress from "$lib/components/StreamingProgress.svelte";
import SyntheticsDriftCard from "$lib/components/SyntheticsDriftCard.svelte";
import SyntheticsPushChoiceCard from "$lib/components/SyntheticsPushChoiceCard.svelte";
import { LANDING_ZONE_BANNER, LANDING_ZONE_EMPTY_STATE, LANDING_ZONE_STARTER_PROMPTS } from "$lib/landing-zone-copy";
import { agentStore } from "$lib/stores/agent.svelte";
import { piFleetStore } from "$lib/stores/pi-fleet.svelte";

let messagesContainer: HTMLDivElement;
let clarifyAnswer = $state("");

// SIO-1572: live graph triage split-screen. Persisted so the pane survives
// reloads; read lazily in onMount (localStorage is absent during SSR).
const GRAPH_PANE_STORAGE_KEY = "graph-triage-pane-open";
let showGraphPane = $state(false);

function toggleGraphPane() {
	showGraphPane = !showGraphPane;
	try {
		localStorage.setItem(GRAPH_PANE_STORAGE_KEY, showGraphPane ? "1" : "0");
	} catch {
		// Storage unavailable (private mode); the toggle still works for the session.
	}
}

// SIO-1572: persist-last-run behavior. While a turn streams (or is paused on an
// interrupt) the live ticker drives the chart; once the turn finalizes, the
// store clears the live maps but buildAssistantMessage snapshotted them onto
// the message -- fall back to the last assistant snapshot (and ITS outcome, so
// an errored turn never renders as a clean finish) until the next turn starts.
const graphRun = $derived.by(() => {
	if (agentStore.isStreaming || agentStore.completedNodes.size > 0) {
		return { completedNodes: agentStore.completedNodes, outcome: undefined };
	}
	// Greptile #679 round 2: only the LATEST turn's assistant messages may supply
	// the snapshot. Scanning past a user message would resurrect an older run's
	// finished chart after a turn that failed before completing any node -- the
	// failed turn's (empty) snapshot and outcome must win instead.
	for (let i = agentStore.messages.length - 1; i >= 0; i--) {
		const msg = agentStore.messages[i];
		if (!msg || msg.role === "user") break;
		if (msg.completedNodes?.size) return { completedNodes: msg.completedNodes, outcome: msg.outcome };
		if (msg.outcome) return { completedNodes: new Map(), outcome: msg.outcome };
	}
	return { completedNodes: agentStore.completedNodes, outcome: undefined };
});

// SIO-1572 (Greptile #679): a turn paused on any HITL gate keeps its completed
// nodes live for the resume leg; without this flag the pane would read the
// pause as a finished run and light END.
const graphPaused = $derived(
	Boolean(
		agentStore.topicShiftPrompt ||
			agentStore.hilLearningMatch ||
			agentStore.hilLearningReview ||
			agentStore.iacClarify ||
			agentStore.iacPlanReview ||
			agentStore.iacReconcileChoice ||
			agentStore.syntheticsPushChoice ||
			agentStore.fleetUpgradeChoice ||
			agentStore.renovateTriggerChoice,
	),
);

// SIO-1659: is any gate card showing? Drives the gate region's border, so an
// empty region draws no stray 1px line. hilLearningOutcome is a result card
// rather than a pause, so it renders in the region without pausing the graph --
// hence this is graphPaused OR that, not a second copy of the list.
const hasGateCard = $derived(graphPaused || Boolean(agentStore.hilLearningOutcome));

// SIO-1655: isIac still gates genuinely IaC-SPECIFIC rendering (drift reports,
// the plan-review card, the message variant) -- those are features of that
// agent, not a two-agent assumption. What is no longer binary is the SWITCH and
// the labels: both come from AGENT_CHOICES, so a third agent needs no edit here.
const isIac = $derived(agentStore.currentAgent === "elastic-iac");
const isLandingZone = $derived(agentStore.currentAgent === "landing-zone-terraform");
const currentChoice = $derived(agentChoice(agentStore.currentAgent));
const agentTitle = $derived(currentChoice.title);
const agentSubtitle = $derived(currentChoice.subtitle);
// SIO-1172: Create ticket is only relevant for agents that support it (allow-listed in agentStore).
const ticketProviders = $derived(agentStore.supportsTicketCreation ? agentStore.availableTicketProviders : []);

// SIO-901: when a drift report is showing and the run has finished, the trailing assistant message
// is the "Drift reconcile summary" (MR links). Render it BELOW the drift card (the consolidation
// block) instead of above it, so the conversation reads drift detail -> MR outcomes top-to-bottom.
// Match only the terminal drift-summary text from teardownIac/formatDriftSummary (agent nodes.ts)
// so an unrelated assistant reply in a later turn is never relocated. -1 = nothing to relocate.
const driftSummaryIndex = $derived.by(() => {
	if (!(isIac && agentStore.iacDriftReport && !agentStore.isStreaming && agentStore.messages.length > 0)) return -1;
	const idx = agentStore.messages.length - 1;
	const last = agentStore.messages[idx];
	if (last?.role !== "assistant") return -1;
	const text = last.content.trimStart();
	const isDriftSummary =
		text.startsWith("Drift reconcile summary for ") ||
		text.startsWith("No drift detected for ") ||
		text.startsWith("Drift-check could not run for ");
	return isDriftSummary ? idx : -1;
});

// SIO-902: same relocation for the synthetics flow -- render the terminal synthetics summary
// (from formatSyntheticsSummary) BELOW the synthetics card so the order reads detail -> outcome.
const syntheticsSummaryIndex = $derived.by(() => {
	if (!(isIac && agentStore.syntheticsDriftReport && !agentStore.isStreaming && agentStore.messages.length > 0))
		return -1;
	const idx = agentStore.messages.length - 1;
	const last = agentStore.messages[idx];
	if (last?.role !== "assistant") return -1;
	const text = last.content.trimStart();
	const isSyntheticsSummary =
		text.startsWith("No synthetics drift for ") ||
		text.startsWith("Pushed ") ||
		text.startsWith("Push declined.") ||
		text.startsWith("Synthetics push ") ||
		text.startsWith("Synthetics drift-check for ") ||
		text.startsWith("Nothing to push ") ||
		text.startsWith("Changed (") ||
		text.startsWith("Missing in Kibana (") ||
		text.startsWith("Extra in Kibana (");
	return isSyntheticsSummary ? idx : -1;
});

// SIO-941: the fleet-upgrade Pipeline log is a snapshot of the live ticker captured on the
// fleet_upgrade_apply_result event; it belongs ABOVE the result message (chronological: the
// pipeline ran, then the turn completed). fleetUpgradeResult is reset each sendMessage, so it
// only describes the latest turn, whose result is the trailing assistant message. -1 = nothing.
const fleetLogIndex = $derived.by(() => {
	if (agentStore.isStreaming) return -1;
	if (!agentStore.fleetUpgradeResult?.progressLog?.length) return -1;
	if (agentStore.messages.length === 0) return -1;
	const idx = agentStore.messages.length - 1;
	return agentStore.messages[idx]?.role === "assistant" ? idx : -1;
});

// SIO-991: the GitOps MR Pipeline log is now pinned per-message (msg.iacPipelineLog), captured in
// buildAssistantMessage, and rendered inline in the message loop -- so it survives later turns. The
// old global gitopsLogIndex (last-message-only) was wiped by the next sendMessage. The fleet log
// (fleetLogIndex) still rides the global fleetUpgradeResult.progressLog (separate path).

// SIO-1655: which agents this deployment can run is a SERVER question (the fleet
// console needs its flag and a configured hub), so the list comes from
// /api/agents. Falls back to the two always-available agents if the probe fails,
// so a transient error never strands the operator on one agent.
// SIO-1657: the modes the header control cycles. The fallback is the two
// always-available agents; the fleet console is contextual, never a mode.
let modeIds = $state<AgentId[]>(AGENT_CHOICES.filter((c) => c.id !== "pi-fleet-console").map((c) => c.id));
// SIO-1665: the agents that offer the live graph triage pane, from the registry's
// hasTriageGraph flag. The fallback is the two always-available modes, so an
// unreachable /api/agents changes nothing (the console is unreachable then too).
let triageIds = $state<AgentId[]>(AGENT_CHOICES.filter((c) => c.id !== "pi-fleet-console").map((c) => c.id));

async function loadSelectableAgents() {
	try {
		const res = await fetch("/api/agents");
		if (!res.ok) return;
		const body = (await res.json()) as {
			agents?: Array<{ id: string; surface?: string; hasTriageGraph?: boolean }>;
		};
		const agents = (body.agents ?? []).filter((a) => isAgentId(a.id));
		const ids = agents.filter((a) => a.surface === "mode").map((a) => a.id as AgentId);
		if (ids.length > 0) modeIds = ids;
		// A row without the flag (older server) keeps the pane offered.
		triageIds = agents.filter((a) => a.hasTriageGraph !== false).map((a) => a.id as AgentId);
	} catch {
		// Keep the fallback list.
	}
}

// SIO-1657: the fleet console asks live account spokes about an incident, so it
// is offered only while analyzing one -- not from the IaC config maker.
// SIO-1662: one fleet affordance, in one place. The fleet is relevant while
// analyzing an incident, not while making an Elastic Cloud config change, so the
// pane toggle follows the agent as well as the hub -- it used to render in the
// IaC agent too, which is the inconsistency this removes.
//
// The fleet console counts as fleet context: the pane stays available there, so
// the "Ask all spokes" entry the operator just used does not vanish behind them
// and the spoke list is still visible next to the console's answer.
const fleetOffered = $derived(
	piFleetStore.configured &&
		(agentStore.currentAgent === "incident-analyzer" || agentStore.currentAgent === "pi-fleet-console"),
);
// SIO-1665: the live graph triage pane follows the agent, so on the fleet
// console it drew a two-node graph beside the fleet pane that already shows the
// spoke replies. Same rule as fleetOffered: the header toggle and the mount share
// this one gate, or switching agents leaves an open pane with no control to
// close it. showGraphPane itself is untouched, so the pane returns in its
// previous state when the operator cycles back.
const triageOffered = $derived(triageIds.includes(agentStore.currentAgent));
// The console is NOT in the cycle, so switching to it would otherwise be a
// one-way trip; while it is current the control returns to the default agent.
const onContextualAgent = $derived(!modeIds.includes(agentStore.currentAgent));

// SIO-1812: the header button row is ONE family -- the two pane toggles and clear. They
// were three visual languages: two solid tommy-accent-blue blocks and a bare uncontained
// icon, all on the navy header. Per SIO-1810's rule a binary state gets a binary cue, so
// active/inactive differ by FILL and icon opacity, never by hue: a white overlay reads as
// "pressed" on navy without the accent's weight. Clear keeps the same shape and reserves
// red for its hover, since destructive is about the action, not a third toggle state.
// Shared string = shared family: change one branch here and change all of them.
const HEADER_BUTTON = "min-w-[44px] min-h-[44px] p-2 rounded-lg transition-colors border-2 border-transparent";
const HEADER_BUTTON_ON = "bg-white/15 text-white";
const HEADER_BUTTON_OFF = "text-white/60 hover:text-white hover:bg-white/10";

// Cycles the header's modes, in registry order.
// SIO-1811: switching agents starts a fresh conversation (switchAgent calls
// clearChat), so the fleet pane is cleared with it for the same reason the clear
// button does -- entries belong to the turn that produced them. switchAgent
// no-ops while streaming and on a same-agent click, so mirror both guards here
// rather than clearing the pane on a switch that never happened.
function cycleAgent() {
	const ids = modeIds;
	if (ids.length === 0) return;
	// From a contextual agent (the fleet console) the control is a way back.
	const fallback = ids.includes(DEFAULT_AGENT_ID) ? DEFAULT_AGENT_ID : (ids[0] as AgentId);
	const target = onContextualAgent ? fallback : ids[(ids.indexOf(agentStore.currentAgent) + 1) % ids.length];
	if (!target || target === agentStore.currentAgent || agentStore.isStreaming) return;
	agentStore.switchAgent(target);
	piFleetStore.clear();
}

function submitClarify() {
	const answer = clarifyAnswer.trim();
	if (!answer) return;
	clarifyAnswer = "";
	agentStore.submitIacClarify(answer);
}

onMount(() => {
	// SIO-1572: restore the graph pane's open/closed state.
	try {
		showGraphPane = localStorage.getItem(GRAPH_PANE_STORAGE_KEY) === "1";
	} catch {
		// Storage unavailable; default stays closed.
	}

	// SIO-1655: which agents this deployment offers.
	void loadSelectableAgents();

	// SIO-1650: the pi-fleet pane is hidden until /api/pi/agents reports a configured hub.
	piFleetStore.restoreOpen();
	void piFleetStore.load();

	let es: EventSource | undefined;
	(async () => {
		await agentStore.loadDataSources();
		es = new EventSource("/api/events");
		es.addEventListener("mcp_replaced", (e) => {
			console.log("[mcp_replaced]", JSON.parse((e as MessageEvent).data));
		});
	})();

	// SIO-956: a session = one conversation, ended when the user starts a new one
	// (Clear / switch agent / new conversation -> store teardownSession) or on a
	// real page unload. Only `pagehide` (genuine tab-close / navigation / app
	// close) ends it here. NO `visibilitychange` listener: tab-switch / minimize /
	// screen-lock is not the end of a conversation, and firing teardown then ended
	// sessions mid-turn (dropping live-memory writes, SESSION_ALREADY_ENDED storm).
	const endOnUnload = () => agentStore.endCurrentSession();
	window.addEventListener("pagehide", endOnUnload);

	return () => {
		es?.close();
		window.removeEventListener("pagehide", endOnUnload);
	};
});

onDestroy(() => {
	agentStore.stopHealthPolling();
});

// Keep the newest content in view until the reader scrolls up. The rule (and why the
// "within 100px of the end" test it replaces stopped following mid-turn) is in chat-follow.ts.
let followingChat = true;
let lastChatTop = 0;

function scrollChatToEnd() {
	if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function onChatScroll() {
	followingChat = followAfterScroll(followingChat, lastChatTop, messagesContainer);
	lastChatTop = messagesContainer.scrollTop;
}

// Sending is the reader asking to see the new turn, wherever they had scrolled to.
$effect(() => {
	if (agentStore.isStreaming) {
		followingChat = true;
		scrollChatToEnd();
	}
});

// Driven by the content's SIZE, not by a list of store fields: tokens, the progress rows,
// findings cards, action cards and follow-ups all grow the column, and the old effect
// tracked only two of them. The container is observed too because the HITL gate region
// beneath it takes height away from the viewport.
$effect(() => {
	const content = messagesContainer?.firstElementChild;
	if (!content) return;
	const observer = new ResizeObserver(() => {
		if (followingChat) scrollChatToEnd();
	});
	observer.observe(content);
	observer.observe(messagesContainer);
	return () => observer.disconnect();
});

function handleSend(content: string) {
	const hasHistory = agentStore.messages.length > 0;
	if (hasHistory) {
		agentStore.sendMessage(content, { isFollowUp: true });
	} else {
		agentStore.sendMessage(content);
	}
}

function handleSuggestionClick(suggestion: string) {
	agentStore.sendMessage(suggestion, {
		isFollowUp: true,
		dataSourceContext: agentStore.lastDataSourceContext,
	});
}
</script>

<!-- SIO-1572: h-screen (was min-h-screen) so the split row is viewport-bound and
     both the chat column and the graph pane scroll internally; min-h-screen let a
     tall graph SVG push the chat input below the fold. -->
<div class="h-screen bg-white flex flex-col">
  <header class="bg-tommy-navy text-white px-6 py-4 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <button
        type="button"
        onclick={cycleAgent}
        disabled={agentStore.isStreaming}
        title={onContextualAgent ? "Back to Incident Analyzer" : `Switch mode (${agentTitle})`}
        aria-label={onContextualAgent
          ? "Back to the Incident Analyzer"
          : `Switch mode (current: ${agentTitle})`}
        class="w-7 h-7 rounded-lg flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed {agentStore.currentAgent === DEFAULT_AGENT_ID ? 'bg-tommy-navy hover:bg-tommy-accent-blue' : 'bg-tommy-accent-blue ring-2 ring-white/70'}"
      >
        <Icon name="bot" class="w-4 h-4 text-white" />
      </button>
      <div>
        <h1 class="text-sm font-semibold leading-tight">{agentTitle}</h1>
        <p class="text-xs text-white/60">{agentSubtitle}</p>
      </div>
    </div>
    <div class="flex items-center gap-4">
      <div class="flex items-center gap-1.5">
        <div class="w-2 h-2 rounded-full bg-green-500"></div>
        <span class="text-xs text-white/60">Connected</span>
      </div>
      <!-- SIO-1572: split the screen vertically with the live graph triage pane.
           SIO-1665: offered only for agents whose graph is worth triaging. -->
      {#if triageOffered}
        <button
          type="button"
          onclick={toggleGraphPane}
          title="Live graph triage"
          aria-label="Toggle live graph triage pane"
          aria-pressed={showGraphPane}
          class="{HEADER_BUTTON} {showGraphPane ? HEADER_BUTTON_ON : HEADER_BUTTON_OFF}"
        >
          <Icon name="graph" class="w-5 h-5" />
        </button>
      {/if}
      <!-- SIO-1662: the separate "switch to the fleet console" button is gone. It
           was a second robot icon next to the mode control's own, and it
           duplicated an affordance the fleet pane below already provides -- the
           operator reaches the fleet through one control, not two.
           SIO-1650/SIO-1657: the pane is offered only where the fleet means
           something, i.e. while analyzing an incident, and only when a pi-coms
           hub is configured to serve it. -->
      {#if fleetOffered}
        <button
          type="button"
          onclick={() => piFleetStore.toggle()}
          title="Fleet spokes"
          aria-label="Toggle the fleet spokes pane"
          aria-pressed={piFleetStore.open}
          class="{HEADER_BUTTON} {piFleetStore.open ? HEADER_BUTTON_ON : HEADER_BUTTON_OFF}"
        >
          <!-- SIO-1706: these are pi agents, so the toggle carries the Pi mark
               rather than a generic chat bubble. This button IS the fleet console:
               it opens the pane whose own box addresses the spokes. -->
          <Icon name="pi" class="w-5 h-5" />
        </button>
      {/if}
      <!-- SIO-1811: clear the board, not just the chat column. The fleet pane's
           replies belong to the turn that produced them, so leaving them beside a
           cleared conversation reads as a reply to the next question. The page
           owns both stores, so it clears both rather than coupling them. -->
      <button
        type="button"
        onclick={() => {
          agentStore.clearChat();
          piFleetStore.clear();
        }}
        title="Clear the conversation"
        aria-label="Clear the conversation and the fleet pane"
        class="{HEADER_BUTTON} text-white/60 hover:bg-red-500 hover:text-white"
      >
        <Icon name="clear" class="w-5 h-5" />
      </button>
    </div>
  </header>

  {#if isIac}
    <div class="bg-gray-50 border-b border-gray-200 px-6 py-2 text-xs text-tommy-navy/80">
      Elastic Cloud IaC maker. For config changes I propose a diff and open a GitLab MR for your review &mdash; CI computes the plan and you merge; I never apply those. A Fleet agent <strong>binary</strong> upgrade has no config file, so on your explicit approval it runs an imperative bulk_upgrade via CI (a live change you can track here).
    </div>
  {:else if isLandingZone}
    <div class="bg-gray-50 border-b border-gray-200 px-6 py-2 text-xs text-tommy-navy/80">
      {LANDING_ZONE_BANNER}
    </div>
  {:else}
    <DataSourceSelector dataSources={agentStore.availableDataSources} connected={agentStore.connectedDataSources} states={agentStore.stateDataSources} bind:selected={agentStore.selectedDataSources} />

    {#if agentStore.selectedDataSources.includes("elastic")}
      <ElasticDeploymentSelector deployments={agentStore.availableElasticDeployments} bind:selected={agentStore.selectedElasticDeployments} />
    {/if}

    {#if agentStore.selectedDataSources.includes("aws")}
      <AwsEstateSelector estates={agentStore.availableAwsEstates} bind:selected={agentStore.selectedAwsEstates} />
    {/if}
  {/if}

  <!-- SIO-1572: split row -- chat (left, flexible) | live graph triage pane (right). -->
  <div class="flex-1 flex overflow-hidden min-h-0">
  <!-- SIO-1659: the chat column is a flex column -- scrolling messages on top,
       the HITL gate region beneath. The gate cards used to live OUTSIDE the
       split row, so they spanned the whole page width and ran underneath the
       triage and fleet panes. Nesting them here bounds them to the chat
       column, so a card grows downward and never covers a pane. -->
  <!-- SIO-1812: min-w floor, from xl (1280px) up only. The prompt bar now lives in this
       column, so with both panes open the column was the thing that gave: at 1440px it
       fell to 288px and the prompt was unusable. The panes are w-2/5 capped at max-w-xl so
       they have slack to yield; the column, holding the conversation AND the input, does
       not -- panes shrink first.
       The floors are gated on xl because they total ~1062px with both panes open, and the
       row neither wraps nor scrolls: applied unconditionally they clipped the trailing
       pane's controls off-screen on a narrower viewport (Greptile, PR #843). Below xl
       everything falls back to min-w-0 and shrinks as it did before this ticket. -->
  <div class="flex-1 flex flex-col min-w-0 xl:min-w-[420px] min-h-0 bg-white">
  <div bind:this={messagesContainer} onscroll={onChatScroll} class="flex-1 overflow-y-auto min-h-0">
    <div class="max-w-4xl mx-auto py-4">
      {#if agentStore.messages.length === 0 && !agentStore.isStreaming}
        <div class="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
          <div class="w-16 h-16 bg-tommy-offwhite rounded-2xl flex items-center justify-center mb-4">
            <Icon name="bot" class="w-8 h-8 text-tommy-navy" />
          </div>
          <h2 class="text-lg font-semibold text-tommy-navy mb-1">How can I help?</h2>
          {#if isIac}
            <p class="text-sm text-gray-500 max-w-md">
              Describe an Elastic Cloud change in plain English (e.g. "upgrade ap-cld to 9.4.2").
              I edit the config, open a GitLab MR for your review, and CI computes the plan on the MR.
            </p>
          {:else if isLandingZone}
            <p class="text-sm text-gray-500 max-w-xl">{LANDING_ZONE_EMPTY_STATE}</p>
            <div class="mt-6 grid w-full max-w-3xl grid-cols-1 gap-2 px-4 sm:grid-cols-2">
              {#each LANDING_ZONE_STARTER_PROMPTS as starter (starter.id)}
                <button
                  type="button"
                  onclick={() => handleSend(starter.prompt)}
                  class="min-h-[44px] rounded-lg border border-gray-200 bg-white px-3 py-2 text-left transition-colors hover:border-tommy-accent-blue hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tommy-accent-blue"
                >
                  <span class="block text-xs font-semibold text-tommy-navy">{starter.label}</span>
                  <span class="mt-0.5 block text-xs leading-5 text-gray-500">{starter.prompt}</span>
                </button>
              {/each}
            </div>
          {:else}
            <p class="text-sm text-gray-500 max-w-md">
              I can analyze incidents across Elasticsearch, Kafka, Couchbase Capella, and Kong Konnect.
              Describe an incident or ask about service health.
            </p>
          {/if}
        </div>
      {/if}

      {#each agentStore.messages as msg, i (msg.id)}
        <!-- SIO-901/902: skip the trailing drift + synthetics summaries here; each is re-rendered
             below its card. SIO-1145: the exclusion now also prevents a duplicate render from
             offering a second "Add as comment" affordance (separate commentPosted state per
             instance would let the same answer be posted twice). -->
        {#if i !== driftSummaryIndex && i !== syntheticsSummaryIndex}
          <!-- SIO-941: render the collapsed pipeline log ABOVE the fleet-upgrade result message so
               the timeline reads chronologically (pipeline ran -> then completed). -->
          {#if i === fleetLogIndex}
            <PipelineProgressCard variant="collapsed" lines={agentStore.fleetUpgradeResult?.progressLog ?? []} />
          {/if}
          <!-- SIO-982: GitOps MR pipeline log, persisted from the live ticker on `done`.
               SIO-991: now pinned PER-MESSAGE (msg.iacPipelineLog) so it survives later turns
               (e.g. a follow-up "check my MR"), instead of the single global field that the next
               sendMessage cleared. -->
          {#if msg.iacPipelineLog?.length}
            <PipelineProgressCard variant="collapsed" lines={msg.iacPipelineLog} />
          {/if}
          <ChatMessage
            message={msg}
            agent={agentStore.currentAgent}
            index={i}
            isLast={i === agentStore.messages.length - 1}
            isStreaming={false}
            onSuggestionClick={handleSuggestionClick}
            onFeedback={(idx, score) => agentStore.setFeedback(idx, score)}
            pendingActions={i === agentStore.messages.length - 1 ? agentStore.pendingActions : []}
            actionResults={i === agentStore.messages.length - 1 ? agentStore.actionResults : []}
            piResultInPane={piFleetStore.configured}
            onActionApprove={(action) => agentStore.executeAction(action, msg.content)}
            onActionDismiss={(id) => agentStore.dismissAction(id)}
            ticketProviders={ticketProviders}
            threadTicket={agentStore.threadTicket}
            canCommentOnThreadTicket={agentStore.threadTicket !== null && i > agentStore.threadTicketCreatedAtIndex}
            onTicketCreated={(ticket) => agentStore.setThreadTicket(msg.id, ticket)}
          />
          {#if msg.landingZoneTopology}
            <LandingZoneTopologyCard event={msg.landingZoneTopology} />
          {/if}
        {/if}
      {/each}

      {#if agentStore.isStreaming}
        {#if agentStore.activeNodes.size > 0 || agentStore.completedNodes.size > 0}
          <div class="px-4">
            <StreamingProgress
              variant={isIac ? "iac" : isLandingZone ? "landing-zone" : "incident"}
              activeNodes={agentStore.activeNodes}
              completedNodes={agentStore.completedNodes}
              subAgentProgress={agentStore.subAgentProgress}
            />
          </div>
        {/if}

        {#if agentStore.iacPipelineProgress.length > 0}
          <!-- SIO-928: live pipeline progress as an avatar + card, not bare floating mono text. -->
          <PipelineProgressCard variant="live" lines={agentStore.iacPipelineProgress} />
        {/if}

        {#if agentStore.currentContent}
          <ChatMessage
            message={{ id: "streaming", role: "assistant", content: agentStore.currentContent }}
            agent={agentStore.currentAgent}
            index={agentStore.messages.length}
            isLast={true}
            isStreaming={true}
          />
        {:else}
          <div class="py-2 px-4">
            <div class="flex gap-3 items-start">
              <div class="w-7 h-7 bg-tommy-offwhite rounded-full flex items-center justify-center shrink-0">
                <Icon name="bot" class="w-3.5 h-3.5 text-tommy-navy" />
              </div>
              <div class="bg-gray-50 rounded-lg px-3 py-2 border border-gray-200">
                <div class="flex space-x-1">
                  <div class="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse-dot"></div>
                  <div class="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse-dot" style="animation-delay: 0.2s"></div>
                  <div class="w-1.5 h-1.5 bg-gray-400 rounded-full animate-pulse-dot" style="animation-delay: 0.4s"></div>
                </div>
              </div>
            </div>
          </div>
        {/if}

        {#if agentStore.landingZoneTopology}
          <LandingZoneTopologyCard event={agentStore.landingZoneTopology} />
        {/if}
      {/if}

      <!-- SIO-882: drift overview. Persists across the interrupt pauses (outside the isStreaming
           gate) so it stays visible while the user works through the per-stack choices.
           SIO-901: the reconcile summary (MR links) now renders as a block BELOW this card. -->
      {#if agentStore.iacDriftReport}
        <DriftReportCard
          report={agentStore.iacDriftReport}
          recheckDisabled={agentStore.isStreaming}
          onRecheck={() => agentStore.sendMessage(`check ${agentStore.iacDriftReport?.deployment} for drift`)}
        />
        <!-- SIO-901: the trailing "Drift reconcile summary" message, relocated under the card. -->
        {#if driftSummaryIndex >= 0}
          {@const summaryMsg = agentStore.messages[driftSummaryIndex]}
          {#if summaryMsg}
            <ChatMessage
              message={summaryMsg}
              agent={agentStore.currentAgent}
              index={driftSummaryIndex}
              isLast={true}
              isStreaming={false}
              onSuggestionClick={handleSuggestionClick}
              onFeedback={(idx, score) => agentStore.setFeedback(idx, score)}
              pendingActions={agentStore.pendingActions}
              actionResults={agentStore.actionResults}
              piResultInPane={piFleetStore.configured}
              onActionApprove={(action) => agentStore.executeAction(action, summaryMsg.content)}
              onActionDismiss={(id) => agentStore.dismissAction(id)}
              ticketProviders={ticketProviders}
              threadTicket={agentStore.threadTicket}
              canCommentOnThreadTicket={agentStore.threadTicket !== null && driftSummaryIndex > agentStore.threadTicketCreatedAtIndex}
              onTicketCreated={(ticket) => agentStore.setThreadTicket(summaryMsg.id, ticket)}
            />
          {/if}
        {/if}
      {/if}

      <!-- SIO-902: synthetics drift card (whole-deployment monitor diff). The push outcome,
           once available, renders inline; the terminal summary relocates below the card. -->
      {#if agentStore.syntheticsDriftReport}
        <SyntheticsDriftCard
          report={agentStore.syntheticsDriftReport}
          result={agentStore.syntheticsPushResult}
          recheckDisabled={agentStore.isStreaming}
          onRecheck={() =>
            agentStore.sendMessage(`check synthetics drift for ${agentStore.syntheticsDriftReport?.deployment}`)}
        />
        {#if syntheticsSummaryIndex >= 0}
          {@const synthSummaryMsg = agentStore.messages[syntheticsSummaryIndex]}
          {#if synthSummaryMsg}
            <ChatMessage
              message={synthSummaryMsg}
              agent={agentStore.currentAgent}
              index={syntheticsSummaryIndex}
              isLast={true}
              isStreaming={false}
              onSuggestionClick={handleSuggestionClick}
              onFeedback={(idx, score) => agentStore.setFeedback(idx, score)}
              pendingActions={agentStore.pendingActions}
              actionResults={agentStore.actionResults}
              piResultInPane={piFleetStore.configured}
              onActionApprove={(action) => agentStore.executeAction(action, synthSummaryMsg.content)}
              onActionDismiss={(id) => agentStore.dismissAction(id)}
              ticketProviders={ticketProviders}
              threadTicket={agentStore.threadTicket}
              canCommentOnThreadTicket={agentStore.threadTicket !== null && syntheticsSummaryIndex > agentStore.threadTicketCreatedAtIndex}
              onTicketCreated={(ticket) => agentStore.setThreadTicket(synthSummaryMsg.id, ticket)}
            />
          {/if}
        {/if}
      {/if}

    </div>
  </div>

  <!-- SIO-1658/1659: a tall gate card (a plan review carrying the knowledge-graph
       and prior-learnings sections) must not push the messages out of the column,
       so the region is capped and scrolls internally. It sits INSIDE the chat
       column, so its width is the chat width and the panes are never covered. -->
  <div class="max-h-[55vh] shrink-0 overflow-y-auto {hasGateCard ? 'border-t border-gray-200' : ''}">
  {#if agentStore.topicShiftPrompt}
    <!-- SIO-751: topic-shift HITL banner. The graph is paused on detectTopicShift
         until the user picks continue or fresh. -->
    <div class="border-t border-amber-300 bg-amber-50 px-4 py-3" role="dialog" aria-labelledby="topic-shift-heading">
      <div class="max-w-4xl mx-auto">
        <h3 id="topic-shift-heading" class="text-sm font-semibold text-amber-900">
          New topic detected
        </h3>
        <p class="text-sm text-amber-800 mt-1">
          {agentStore.topicShiftPrompt.message}
        </p>
        <div class="mt-2 flex flex-wrap gap-2 text-xs text-amber-900">
          <span class="font-semibold">Prior services:</span>
          <span>{agentStore.topicShiftPrompt.oldServices.join(", ") || "(none)"}</span>
          <span class="font-semibold ml-3">New services:</span>
          <span>{agentStore.topicShiftPrompt.newServices.join(", ") || "(none)"}</span>
        </div>
        <div class="mt-3 flex gap-2">
          <button
            type="button"
            onclick={() => agentStore.resolveTopicShift("continue")}
            disabled={agentStore.isStreaming}
            class="px-3 py-1.5 text-sm font-medium bg-tommy-navy text-white rounded-md hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Continue prior investigation
          </button>
          <button
            type="button"
            onclick={() => agentStore.resolveTopicShift("fresh")}
            disabled={agentStore.isStreaming}
            class="px-3 py-1.5 text-sm font-medium bg-white text-tommy-navy border border-tommy-navy rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Start fresh
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if agentStore.hilLearningMatch}
    <!-- SIO-1126: HIL learning match gate -- pick the stored investigation the ticket
         corresponds to (or none). The graph is paused on learnMatchGate. -->
    <LearningMatchCard
      prompt={agentStore.hilLearningMatch}
      disabled={agentStore.isStreaming}
      onPick={(incidentId) => agentStore.resolveHilMatch(incidentId)}
    />
  {/if}

  {#if agentStore.hilLearningReview}
    <!-- SIO-1126: HIL learning review gate -- per-item approve/reject of the distilled
         proposal. The graph is paused on learnReviewGate. -->
    <LearningProposalCard
      prompt={agentStore.hilLearningReview}
      disabled={agentStore.isStreaming}
      onApply={(decisions, edits) => agentStore.resolveHilReview(decisions, edits)}
    />
  {/if}

  {#if agentStore.hilLearningOutcome}
    <!-- SIO-1146: terminal outcome card after apply. Mutually exclusive with the
         gate cards by construction (the reducer nulls them on hil_learning_applied). -->
    <LearningOutcomeCard
      outcome={agentStore.hilLearningOutcome}
      onDone={() => agentStore.dismissHilLearningOutcome()}
    />
  {/if}

  {#if agentStore.iacClarify}
    <!-- elastic-iac clarify gate: the planner needs one direct answer to proceed. -->
    <div class="border-t border-gray-200 bg-gray-50 px-4 py-3" role="dialog" aria-labelledby="iac-clarify-heading">
      <div class="max-w-4xl mx-auto">
        <h3 id="iac-clarify-heading" class="text-sm font-semibold text-tommy-navy">One quick question</h3>
        <p class="text-sm text-tommy-navy/80 mt-1">{agentStore.iacClarify.question}</p>
        <form class="mt-2 flex gap-2" onsubmit={(e) => { e.preventDefault(); submitClarify(); }}>
          <input
            type="text"
            bind:value={clarifyAnswer}
            disabled={agentStore.isStreaming}
            placeholder="Your answer"
            class="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:border-tommy-accent-blue disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={agentStore.isStreaming || !clarifyAnswer.trim()}
            class="px-3 py-1.5 text-sm font-medium bg-tommy-navy text-white rounded-md hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  {/if}

  {#if agentStore.iacPlanReview}
    <PlanReviewCard
      prompt={agentStore.iacPlanReview}
      disabled={agentStore.isStreaming}
      onApprove={() => agentStore.resolveIacPlanReview("approved")}
      onReject={() => agentStore.resolveIacPlanReview("rejected")}
    />
  {/if}

  {#if agentStore.iacReconcileChoice}
    <!-- SIO-882: per-stack reconcile gate (sequential; one stack at a time). -->
    <ReconcileChoiceCard
      prompt={agentStore.iacReconcileChoice}
      disabled={agentStore.isStreaming}
      onChoose={(d) => agentStore.resolveReconcileChoice(d)}
    />
  {/if}

  {#if agentStore.syntheticsPushChoice}
    <!-- SIO-902: single synthetics push approve/decline gate. -->
    <SyntheticsPushChoiceCard
      prompt={agentStore.syntheticsPushChoice}
      disabled={agentStore.isStreaming}
      onApprove={() => agentStore.approveSyntheticsPush(true)}
      onDecline={() => agentStore.approveSyntheticsPush(false)}
    />
  {/if}

  {#if agentStore.fleetUpgradeChoice}
    <!-- SIO-913 / SIO-922: single fleet-upgrade apply approve/decline gate. -->
    <FleetUpgradeChoiceCard
      prompt={agentStore.fleetUpgradeChoice}
      disabled={agentStore.isStreaming}
      onApprove={() => agentStore.approveFleetUpgrade(true)}
      onDecline={() => agentStore.approveFleetUpgrade(false)}
    />
  {/if}

  {#if agentStore.renovateTriggerChoice}
    <!-- SIO-XXXX: single renovate-integration-update trigger approve/decline gate. -->
    <RenovateTriggerChoiceCard
      prompt={agentStore.renovateTriggerChoice}
      disabled={agentStore.isStreaming}
      onApprove={() => agentStore.approveRenovateTrigger(true)}
      onDecline={() => agentStore.approveRenovateTrigger(false)}
    />
  {/if}
  </div>

  <!-- SIO-1812: the prompt bar belongs to the CHAT COLUMN, not the page. It used to sit
       below the whole split row, so it ran the full width under the panes: the panes
       stopped short of the viewport bottom, and the bar's own max-w-4xl centred on the
       page while the messages above it centred on the column -- two different axes, which
       is what read as misaligned. Inside the column it shares one axis with the messages
       and the panes run the full height beside it. -->
  <div class="border-t border-gray-200 bg-white shrink-0">
    <ChatInput
      onSend={handleSend}
      onStop={() => agentStore.cancelStream()}
      isStreaming={agentStore.isStreaming}
      bind:attachments={agentStore.pendingAttachments}
    />
  </div>
  </div>

  <!-- SIO-1665: triageOffered, not just showGraphPane -- same gate as the toggle. -->
  {#if triageOffered && showGraphPane}
    <div class="w-2/5 max-w-xl min-w-0 xl:min-w-[320px] border-l border-gray-200 bg-white overflow-hidden">
      <GraphTriagePanel
        agent={agentStore.currentAgent}
        activeNodes={agentStore.activeNodes}
        completedNodes={graphRun.completedNodes}
        isStreaming={agentStore.isStreaming}
        paused={graphPaused}
        outcome={graphRun.outcome}
      />
    </div>
  {/if}
  <!-- SIO-1650: live spokes pane (right), addressed directly, replies as data. -->
  <!-- SIO-1662: fleetOffered, not just `configured` -- the pane's own render gate
       has to match its toggle's, or switching to the IaC agent leaves the pane on
       screen with no control to close it. -->
  {#if fleetOffered && piFleetStore.open}
    <div class="w-2/5 max-w-xl min-w-0 xl:min-w-[320px] border-l border-gray-200 bg-white overflow-hidden">
      <!-- SIO-1703: scoping an investigation to one estate scopes the spokes too.
           Addressing an account outside the investigation is almost always a
           mistake, and the estate selector is the operator's statement of scope. -->
      <PiFleetPane
        pane={piFleetStore.state}
        busy={piFleetStore.busy}
        mailboxBusy={piFleetStore.mailboxBusy}
        onSend={(prompt, visible) => piFleetStore.send(prompt, visible)}
        onRefresh={() => piFleetStore.load()}
        onSelect={(selection) => piFleetStore.select(selection)}
        onLoadMailbox={(hubKey, estates) => piFleetStore.loadMailbox(hubKey, estates)}
        scopeEstates={agentStore.selectedAwsEstates}
      />
    </div>
  {/if}
  </div>

</div>
