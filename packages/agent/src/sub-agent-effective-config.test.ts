// packages/agent/src/sub-agent-effective-config.test.ts
//
// SIO-1241: the config regression that produced the 2026-07-27 report collapse (confidence 0.45,
// gitlab truncated to 44 bytes) was invisible for two days because nothing asserted what a
// specialist ACTUALLY runs. Three changes, none of them a bug on its own:
//
//   SIO-1213 (cd7c628a) bumped the ROOT manifest sonnet-4-6 -> sonnet-5. The seven sub-agent
//     manifests were dead config at the time, so all seven specialists silently followed root.
//   SIO-1235 (aaad8eec) made those manifests live, dropping every specialist sonnet-5 -> haiku-4-5.
//   SIO-1250 (86a47956) installed preModelHook. It is a graph NODE, so a ReAct cycle became THREE
//     super-steps and every sub-agent silently lost a third of its reasoning turns.
//
// Each was reviewed and merged on its own merits. What was missing is a place where the EFFECTIVE
// values are written down, so that moving any of them is a deliberate, visible edit. That is this
// file. It is a ratchet, not a design statement: when it goes red, re-derive and update the pinned
// value on purpose.
//
// Note the second assertion derives the cycle cost from a REAL createReactAgent graph rather than
// importing sub-agent.ts's CYCLE_SUPER_STEPS. Pinning against that constant would be tautological
// -- it is exactly the number SIO-1250 left stale.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadAgent } from "@devops-agent/gitagent-bridge";
import type { BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { resolveRoleModelConfig } from "./llm.ts";
import { AGENT_NAMES, getSubAgentRecursionLimit } from "./sub-agent.ts";

// The good run (DEVOPS-1405, 2026-07-25) had the specialists on sonnet-4-6 by INHERITANCE from a
// root that also read sonnet-4-6. They are now PINNED there while root runs sonnet-5, so the two
// no longer move together -- deliberate, and the reason both are pinned separately below.
const EXPECTED_ROOT_MODEL = "claude-sonnet-5";
const EXPECTED_SPECIALIST_MODEL = "claude-sonnet-4-6";

const orchestrator = loadAgent(join(import.meta.dir, "../../../agents/incident-analyzer"));

describe("effective sub-agent model (SIO-1241 regression guard)", () => {
	test("root manifest is on its pinned model", () => {
		expect(orchestrator.manifest.model?.preferred).toBe(EXPECTED_ROOT_MODEL);
	});

	test.each(Object.entries(AGENT_NAMES))(
		"%s -> %s resolves to the pinned specialist model, from its OWN manifest",
		(_dataSourceId, agentName) => {
			const resolved = resolveRoleModelConfig("subAgent", orchestrator, agentName);

			// The SIO-1213 guard. When the sub-agent manifests were dead config this said
			// "root-manifest", and a one-line root bump moved all seven specialists with it.
			expect(resolved.source, `${agentName} is not resolving from its own manifest`).toBe("sub-agent-manifest");
			expect(resolved.modelConfig?.preferred, `${agentName} is on an unexpected model`).toBe(EXPECTED_SPECIALIST_MODEL);
		},
	);

	// Anchored on the resolver, not on the YAML: reading both through resolveRoleModelConfig is what
	// proves they are independently addressable. If specialists ever legitimately move to the root
	// model, delete this test rather than weakening it -- at that point the coupling is intended.
	test("specialists do not track the root model", () => {
		const specialist = resolveRoleModelConfig("subAgent", orchestrator, "gitlab-agent");
		const root = resolveRoleModelConfig("aggregator", orchestrator);

		expect(root.source).toBe("root-manifest");
		expect(specialist.modelConfig?.preferred).not.toBe(root.modelConfig?.preferred);
	});
});

// A ReAct cycle's cost in LangGraph super-steps, measured off a real graph. Excludes `__start__`,
// which runs once rather than once per cycle.
function measureCycleSuperSteps(): number {
	const llm = new FakeListChatModel({ responses: ["ok"] });
	const noop = tool(async () => "", {
		name: "noop",
		description: "placeholder tool; never invoked",
		schema: z.object({}),
	});

	// Mirrors the shape sub-agent.ts builds. The hook has been installed UNCONDITIONALLY since
	// SIO-1260 -- it used to be spread only when a byte budget was configured, which made the cycle
	// cost depend on an env var.
	const agent = createReactAgent({
		llm,
		tools: [noop],
		preModelHook: (state: { messages: BaseMessage[] }) => ({ llmInputMessages: state.messages }),
	});

	const nodes = Object.keys((agent as unknown as { nodes: Record<string, unknown> }).nodes ?? {});
	return nodes.filter((n) => n !== "__start__").length;
}

// limit / cycle cost. These are the turn counts the limits in RECURSION_LIMIT_BY_DATASOURCE were
// written to express; gitlab's 12 is DEVOPS-1405 parity, the run this whole investigation used as
// its baseline.
const EXPECTED_EFFECTIVE_TURNS: Record<string, number> = {
	elastic: 20,
	aws: 20,
	couchbase: 15,
	gitlab: 12,
	kafka: 12,
	konnect: 12,
	atlassian: 10,
};

describe("effective sub-agent turn budget (SIO-1241 regression guard)", () => {
	test("a ReAct cycle costs three super-steps, measured off a real graph", () => {
		// Adding a node to the sub-agent graph moves this number and drops every turn budget below.
		// That is the SIO-1250 failure mode, and it is why this is measured rather than imported.
		expect(measureCycleSuperSteps()).toBe(3);
	});

	test("the measured cost matches the node set the limits were sized against", () => {
		const llm = new FakeListChatModel({ responses: ["ok"] });
		const noop = tool(async () => "", {
			name: "noop",
			description: "placeholder tool; never invoked",
			schema: z.object({}),
		});
		const withHook = createReactAgent({
			llm,
			tools: [noop],
			preModelHook: (state: { messages: BaseMessage[] }) => ({ llmInputMessages: state.messages }),
		});

		const nodes = Object.keys((withHook as unknown as { nodes: Record<string, unknown> }).nodes ?? {});
		expect(nodes.sort()).toEqual(["__start__", "agent", "pre_model_hook", "tools"]);
	});

	// measureCycleSuperSteps builds a MIRROR of the production graph, so on its own it would happily
	// stay at 3 while sub-agent.ts grew a fourth node -- the precise blind spot that let SIO-1250
	// through. This pins the production call site's node-adding options so the mirror cannot drift
	// from what it mirrors. `messageModifier`/`stateModifier`/`prompt` are NOT nodes and are
	// deliberately not listed.
	test("the production createReactAgent call adds no node this budget has not accounted for", async () => {
		const source = await Bun.file(join(import.meta.dir, "sub-agent.ts")).text();
		const call = source.slice(source.indexOf("createReactAgent({"));
		expect(call, "createReactAgent call not found in sub-agent.ts").not.toBe("");

		// Bounded to the call's own object literal: the next top-level `\n\t\t});` closes it.
		const body = call.slice(0, call.indexOf("\n\t\t});"));

		expect(body).toContain("preModelHook:");
		expect(
			body.includes("postModelHook:"),
			"sub-agent.ts gained a postModelHook -- that is a 4th node, so every turn budget in RECURSION_LIMIT_BY_DATASOURCE now buys a quarter less than it says. Re-derive the limits, then update EXPECTED_EFFECTIVE_TURNS and measureCycleSuperSteps.",
		).toBe(false);
	});

	// Empty env, not process.env: SUBAGENT_RECURSION_LIMIT_* in a developer's .env would otherwise
	// decide the result (see reference_bun_env_leaks_into_config_tests).
	test.each(Object.entries(EXPECTED_EFFECTIVE_TURNS))("%s affords %i LLM turns", (dataSourceId, expectedTurns) => {
		const steps = measureCycleSuperSteps();
		const limit = getSubAgentRecursionLimit(dataSourceId, {});

		expect(Math.floor(limit / steps), `${dataSourceId} turn budget moved`).toBe(expectedTurns);
	});

	test("every datasource with a sub-agent has a pinned turn budget", () => {
		// Stops a newly-added datasource from silently inheriting the default budget unexamined.
		for (const dataSourceId of Object.keys(AGENT_NAMES)) {
			expect(
				EXPECTED_EFFECTIVE_TURNS[dataSourceId],
				`${dataSourceId} has no pinned turn budget in this test`,
			).toBeDefined();
		}
	});
});
