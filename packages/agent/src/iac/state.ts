// agent/src/iac/state.ts
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

// Parsed natural-language IaC request (e.g. "downsize eu-b2b warm to 8 GB").
export interface IacRequest {
	workflow: "tier-resize" | "ilm-rollout" | "other";
	cluster?: string;
	tier?: string;
	resource?: string;
	newSizeGb?: number;
	newMaxGb?: number;
	policyName?: string;
	reason?: string;
	// Prod requires the user to name the prod cluster explicitly (RULES.md).
	isProd: boolean;
	// When set, the planner needs a direct answer from the human before proceeding.
	clarification?: string;
}

// Snapshot of live cluster state read before drafting (topology + ILM + health).
export interface IacClusterState {
	cluster: string;
	summary: string;
	// True when the target tier currently has a managed ILM/.alerts setup; used by
	// the hot-downsize guard (RULES.md conditional).
	alertsManaged: boolean;
	currentSizeGb?: number;
	raw?: unknown;
}

// The reviewed change surfaced to the human at the planReview interrupt.
export interface IacPlanReview {
	cluster: string;
	branch: string;
	title: string;
	diff: string;
	plan: string;
	risks: string[];
	precheckPassed: boolean;
}

const last = <T>(_current: T, update: T): T => update;

// Dedicated IaC graph state. Kept separate from AgentState so the maker workflow
// never carries the 50-field incident pipeline state (and vice versa). The HITL
// primitives (interrupt/Command/getPendingInterrupt) operate on the checkpointer
// thread, not the state shape, so they are reused unchanged.
export const IacState = Annotation.Root({
	...MessagesAnnotation.spec,
	requestId: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-870: read-vs-write routing. "info" answers from Elastic Cloud reads and
	// stops; "gitops" enters the maker/HITL/MR pipeline. Set by classifyIacIntent.
	intent: Annotation<"info" | "gitops" | null>({ reducer: last, default: () => null }),
	iacRequest: Annotation<IacRequest | null>({ reducer: last, default: () => null }),
	clusterState: Annotation<IacClusterState | null>({ reducer: last, default: () => null }),
	branch: Annotation<string>({ reducer: last, default: () => "" }),
	proposedDiff: Annotation<string>({ reducer: last, default: () => "" }),
	terraformPlan: Annotation<string>({ reducer: last, default: () => "" }),
	risks: Annotation<string[]>({ reducer: last, default: () => [] }),
	precheckPassed: Annotation<boolean>({ reducer: last, default: () => false }),
	planReview: Annotation<IacPlanReview | null>({ reducer: last, default: () => null }),
	reviewDecision: Annotation<"approved" | "rejected" | null>({ reducer: last, default: () => null }),
	mrUrl: Annotation<string>({ reducer: last, default: () => "" }),
	// false when the unified mcp-server-elastic-iac is not connected; surfaced to the UI.
	connected: Annotation<boolean>({ reducer: last, default: () => true }),
	// terminal blocked reason from the guard (e.g. prod not named, .alerts unmanaged).
	blockedReason: Annotation<string>({ reducer: last, default: () => "" }),
});

export type IacStateType = typeof IacState.State;
