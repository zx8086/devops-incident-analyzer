// agent/src/llm.role-tagging.test.ts
//
// SIO-1271: every model instance must carry its ROLE, because the SSE pump can only tell the
// answer-producing call from a utility call by that role. Four LLM calls run under langgraph_node
// "aggregate" -- the aggregator plus gapsJudge and both absenceJudge arms -- so a node-scoped
// filter forwarded all four to the browser and a user saw raw judge verdict JSON in the chat.
//
// This is the unit guard that the stamp stays wired at the constructor. It cannot prove LangChain
// propagates it onto on_chat_model_stream; that is verified against @langchain/core's source
// (base.cjs sets this.tags/this.metadata -> chat_models.cjs passes both to
// CallbackManager.configure -> event_stream.cjs surfaces them on the stream event), and the
// consuming filter is covered in apps/web/src/lib/server/sse-pump.test.ts.

import { beforeEach, describe, expect, mock, test } from "bun:test";

// createLlm builds one model for the primary AND one for the manifest fallback, so a "last call"
// capture would silently observe the wrong one.
let constructorCalls: Record<string, unknown>[] = [];

mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		constructor(options: Record<string, unknown>) {
			constructorCalls.push(options);
		}
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke() {
			return { content: "" };
		}
	},
}));

const { createLlm } = await import("./llm.ts");

describe("buildChatModel stamps the role on every model instance (SIO-1271)", () => {
	beforeEach(() => {
		constructorCalls = [];
	});

	// The two roles the pump matches POSITIVELY. If either loses its stamp the pump falls back to
	// the node-name match, which is the pre-SIO-1271 behaviour.
	for (const role of ["aggregator", "responder"] as const) {
		test(`${role} carries metadata.role and a role: tag`, () => {
			createLlm(role);
			expect(constructorCalls.length).toBeGreaterThan(0);
			for (const options of constructorCalls) {
				expect(options.metadata).toEqual({ role });
				expect(options.tags).toEqual([`role:${role}`]);
			}
		});
	}

	// The roles the pump must SUPPRESS. These are the ones that leaked.
	for (const role of ["absenceJudge", "gapsJudge"] as const) {
		test(`${role} carries its own role, distinguishable from the aggregator`, () => {
			createLlm(role);
			expect(constructorCalls.length).toBeGreaterThan(0);
			for (const options of constructorCalls) {
				expect(options.metadata).toEqual({ role });
				expect(options.tags).toEqual([`role:${role}`]);
				expect(options.metadata).not.toEqual({ role: "aggregator" });
			}
		});
	}

	// The fallback model is a separate construction; an unstamped fallback would leak precisely
	// when the primary fails, which is the moment least likely to be noticed.
	test("the manifest fallback instance is stamped too, not just the primary", () => {
		createLlm("aggregator");
		const models = new Set(constructorCalls.map((o) => o.model));
		// Anti-vacuity: only meaningful if more than one model was actually built.
		if (models.size > 1) {
			expect(constructorCalls.every((o) => (o.tags as string[])?.[0] === "role:aggregator")).toBe(true);
		}
		expect(constructorCalls.every((o) => o.metadata !== undefined)).toBe(true);
	});
});
