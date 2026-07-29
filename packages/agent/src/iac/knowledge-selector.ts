// agent/src/iac/knowledge-selector.ts
//
// SIO-1285: elastic-iac's system prompt carried EVERY knowledge entry on EVERY call --
// 498,941 bytes of 568,446 (87.8%) before this ticket. incident-analyzer solved the
// equivalent problem in SIO-640 with a selectRunbooks node; this is the IaC counterpart.
//
// It keys on `intent`, NOT the 19-value `workflow`, because parseIntent PRODUCES the
// workflow (nodes.ts:926 builds the prompt; the value first exists at nodes.ts:1199) --
// it cannot filter on its own output. classifyIacIntent has already run by then and made
// its own LLM call with a hand-written static prompt, so keying on its result costs
// nothing extra: this node makes no model call at all.
import type { KnowledgeSelectionConfig, LoadedAgent } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { getAgentByName } from "../prompt-context.ts";
import { type IacIntent, type IacStateType, INTENT_VALUES } from "./state.ts";

const log = getLogger("agent:iac:knowledge-selector");
const AGENT = "elastic-iac";

// The six categories that survive SIO-1285's removal of _archive/ and health-snapshots/.
// This is the "everything" set -- the fallback for any path that is not confidently narrow.
export const ALL_LIVE_CATEGORIES = ["reference", "playbook", "specs", "issues", "cost-plans", "runbooks"] as const;

// Compile-time exhaustive: adding a 9th intent without a mapping is a type error.
// Used when index.yaml declares no by_intent entry for an intent.
export const DEFAULT_BY_INTENT: Record<IacIntent, readonly string[]> = {
	// The gitops lane feeds parseIntent, which must discriminate among 19 workflows.
	// It keeps the categories that carry workflow discriminators (playbook chapters,
	// change specs, per-cluster issue registers) and drops narrative-only ones.
	gitops: ["reference", "playbook", "specs", "issues"],
	"gitops-amend": ["reference", "playbook", "specs", "issues"],
	// converseIac explains/justifies the agent's OWN prior answer and already carries the
	// full conversation history, so it needs conventions plus the incident narratives it
	// is most often asked about -- not the whole corpus.
	converse: ["reference", "runbooks"],
	// "info" is intentFromText's CATCH-ALL (nodes.ts:573 returns it for anything
	// unrecognised), so it is not a category of request -- it is everything the classifier
	// could not place. Narrowing it would silently starve every novel or misclassified
	// request. It gets the full set, permanently. The knowledge-selector-sync test pins this.
	info: ALL_LIVE_CATEGORIES,
	// These four route to nodes that build no knowledge-bearing prompt at all, so their
	// mapping is inert; keep them at the full set so nothing is starved if that changes.
	drift: ALL_LIVE_CATEGORIES,
	"synthetics-drift": ALL_LIVE_CATEGORIES,
	"fleet-upgrade": ALL_LIVE_CATEGORIES,
	"pipeline-status": ALL_LIVE_CATEGORIES,
};

// Narrow agent.knowledge to the selected categories.
//
// MUST be non-mutating. getAgentByName (prompt-context.ts:33-40) hands out a
// PROCESS-GLOBAL cached LoadedAgent from a module-level Map, so filtering in place would
// poison every later turn and every other thread. Shallow copy + a fresh filtered array,
// exactly like filterAgentRunbooks (orchestrator-prompt-assembly.ts:35-43).
//
// Tri-state contract, matching that sibling:
//   undefined / null -> pass-through, returning the SAME OBJECT IDENTITY
//   []               -> drop all knowledge
//   [names]          -> keep only these categories
export function filterAgentKnowledge(agent: LoadedAgent, categories: string[] | null | undefined): LoadedAgent {
	if (categories === null || categories === undefined) return agent;
	const keep = new Set(categories);
	return { ...agent, knowledge: agent.knowledge.filter((entry) => keep.has(entry.category)) };
}

// Resolve the category list for an intent. Every degenerate path returns the FULL set --
// never a narrow one. Starving the downstream LLM is worse than paying for tokens, and
// under-selection fails SILENTLY (parseIntent picks the wrong workflow and produces a
// well-formed MR for the wrong change). This mirrors narrowCatalogByTriggers' `fallback`
// mode (runbook-selector.ts:322-344), which sends the FULL catalog rather than guess.
export function selectCategories(intent: IacIntent | null, config?: KnowledgeSelectionConfig): string[] {
	// Annotation default, unreachable after classifyIacIntent -- but if it ever is, take
	// everything rather than assume.
	if (intent === null) return [...ALL_LIVE_CATEGORIES];

	const picked = config?.by_intent[intent] ?? DEFAULT_BY_INTENT[intent];
	// index.yaml is data and can drift from the enum despite the sync test guarding it.
	// An unmapped or empty list falls back to the full set, not to nothing.
	if (!picked || picked.length === 0) return [...ALL_LIVE_CATEGORIES];

	return [...new Set([...(config?.floor ?? []), ...picked])];
}

// The node. Deterministic and model-free: it reads the intent classifyIacIntent already
// computed and writes the resulting category list to state, where the four
// buildSystemPrompt call sites read it back.
//
// Returning {} leaves selectedKnowledge at its `null` default, which filterAgentKnowledge
// treats as pass-through -- so every failure mode degrades to today's full prompt rather
// than to a partial one.
export async function selectIacKnowledge(state: IacStateType): Promise<Partial<IacStateType>> {
	try {
		const config = getAgentByName(AGENT).knowledgeSelection;
		if (!config) return {};

		const categories = selectCategories(state.intent, config);
		log.info({ intent: state.intent, categories: categories.join(",") }, "iac knowledge selection");
		return { selectedKnowledge: categories };
	} catch (err) {
		// Deliberately NOT the hard-fail of SIO-640's RunbookSelectionFallbackError. There a
		// missing severity signalled a real normalize bug worth surfacing; here `intent` is
		// total, so throwing would only turn a cost regression into an outage.
		log.warn({ err }, "iac knowledge selection failed; falling back to FULL knowledge");
		return {};
	}
}

// Exported for the sync test: every value the intent enum declares must be mapped.
export const MAPPED_INTENTS: readonly IacIntent[] = INTENT_VALUES;
