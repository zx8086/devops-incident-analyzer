// agent/src/pi-fleet/graph.ts
//
// SIO-1655 (Phase 2c): the fleet console graph. A createReactAgent over the five
// hub tools, wrapped in a teardown that always releases hub registrations --
// including on the failure path, so a crashed turn never leaves the console
// registered on a hub until the stale-card reaper collects it.
//
// The persona is agents/pi-fleet-console/, deliberately NOT agents/pi-fleet/:
// that one is exported to fleet hosts and run by Pi with a different tool
// vocabulary, and its manifest says it is never executed in-process. See
// SIO-1655's recorded decision.

import { createCheckpointer } from "@devops-agent/checkpointer";
import { buildSubAgentSystemPrompt } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { END, START, StateGraph } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { isPiComsConfigured, resolvePiComsConfig } from "../action-tools/pi-verifier.ts";
import { initializeLangSmith } from "../langsmith.ts";
import { createLlm } from "../llm.ts";
import { getAgentByName } from "../prompt-context.ts";
import { PiFleetState, type PiFleetStateType } from "./state.ts";
import { buildFleetTools, type FleetToolDeps, releaseClients } from "./tools.ts";

const logger = getLogger("agent:piFleet:graph");

export const PI_FLEET_AGENT_NAME = "pi-fleet-console";

// SIO-1655: default OFF until live-verified against a hub with registered
// spokes (the CLOSURE_LEARNING_ENABLED / PI_HANDOFF_ENABLED idiom).
export function isPiFleetGraphEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.PI_FLEET_GRAPH_ENABLED;
	return v === "true" || v === "1";
}

export interface BuildPiFleetGraphOptions {
	checkpointerType?: "memory" | "sqlite";
	// Test seam: a scripted fetch and clock, exactly as the verifier deps work.
	toolDeps?: Pick<FleetToolDeps, "fetchImpl" | "now">;
	env?: NodeJS.ProcessEnv;
}

export async function buildPiFleetGraph(options: BuildPiFleetGraphOptions = {}) {
	await initializeLangSmith();
	const env = options.env ?? process.env;
	if (!isPiComsConfigured(env)) {
		throw new Error("pi-coms hub is not configured; the fleet console graph cannot be built");
	}
	const config = resolvePiComsConfig(env);

	// One dep bag per compiled graph, holding the per-environment client map for
	// the turn. releaseClients() empties it in teardown.
	const toolDeps: FleetToolDeps = {
		config,
		fetchImpl: options.toolDeps?.fetchImpl,
		now: options.toolDeps?.now,
		clients: new Map(),
	};
	const tools = buildFleetTools(toolDeps);

	// The persona's SOUL/RULES/DUTIES are the system prompt, assembled by the same
	// bridge helper the sub-agents use, so the console's rules (untrusted replies,
	// no cross-environment access, mandatory attribution) reach the model through
	// the standard path rather than a hand-rolled string.
	const systemPrompt = buildSubAgentSystemPrompt(getAgentByName(PI_FLEET_AGENT_NAME));

	const reactAgent = createReactAgent({
		llm: createLlm("orchestrator", PI_FLEET_AGENT_NAME),
		tools,
		messageModifier: systemPrompt,
	});

	async function converseFleet(state: PiFleetStateType) {
		const result = await reactAgent.invoke({ messages: state.messages });
		return { messages: result.messages, registered: true };
	}

	// Always runs, on both the success and failure paths, so a hub registration
	// can never outlive the turn that opened it.
	async function teardownFleet() {
		await releaseClients(toolDeps);
		return { registered: false };
	}

	const graph = new StateGraph(PiFleetState)
		.addNode("converseFleet", converseFleet)
		.addNode("teardownFleet", teardownFleet)
		.addEdge(START, "converseFleet")
		.addEdge("converseFleet", "teardownFleet")
		.addEdge("teardownFleet", END);

	logger.info({ tools: tools.length, hubs: Object.keys(config.hubs) }, "pi-fleet console graph built");

	return graph.compile({ checkpointer: createCheckpointer(options.checkpointerType ?? "memory") });
}
