// packages/agent/src/aws-estate-router.test.ts
// SIO-836: UI estate selection takes precedence over the LLM classifier.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";

// Spy on the LLM so we can assert it is NOT called when the UI provides a selection.
// createLlm wraps ChatBedrockConverse from @langchain/aws; mocking it here keeps the
// router's createLlm("awsEstateRouter") path inert and observable.
let invokeCalls = 0;
let llmResponseJson = '{"kind":"ambiguous"}';

mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke() {
			invokeCalls += 1;
			return { content: llmResponseJson };
		}
	},
}));

import { _resetEstateCacheForTests, awsEstateRouter } from "./aws-estate-router.ts";
import type { AgentStateType } from "./state.ts";

const ORIG_ESTATES = process.env.AWS_ESTATES;

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [new HumanMessage("look at our clusters")],
		targetDataSources: ["aws"],
		extractedEntities: { dataSources: [] },
		uiAwsEstates: [],
		awsTargetEstates: [],
		...overrides,
	} as AgentStateType;
}

describe("awsEstateRouter UI precedence (SIO-836)", () => {
	beforeEach(() => {
		invokeCalls = 0;
		llmResponseJson = '{"kind":"ambiguous"}';
		process.env.AWS_ESTATES = JSON.stringify({
			prod: { assumedRoleArn: "arn:aws:iam::1:role/r", externalId: "e" },
			staging: { assumedRoleArn: "arn:aws:iam::2:role/r", externalId: "e" },
			dev: { assumedRoleArn: "arn:aws:iam::3:role/r", externalId: "e" },
		});
		_resetEstateCacheForTests();
	});

	afterEach(() => {
		if (ORIG_ESTATES === undefined) delete process.env.AWS_ESTATES;
		else process.env.AWS_ESTATES = ORIG_ESTATES;
		_resetEstateCacheForTests();
	});

	test("UI selection wins and the LLM classifier is not called", async () => {
		const result = await awsEstateRouter(makeState({ uiAwsEstates: ["prod"] }));
		expect(result.awsTargetEstates).toEqual(["prod"]);
		expect(invokeCalls).toBe(0);
	});

	test("UI selection is filtered to known estates (stale ids dropped)", async () => {
		const result = await awsEstateRouter(makeState({ uiAwsEstates: ["prod", "gone"] }));
		expect(result.awsTargetEstates).toEqual(["prod"]);
		expect(invokeCalls).toBe(0);
	});

	test("all-unknown UI selection falls through to the LLM classifier", async () => {
		const result = await awsEstateRouter(makeState({ uiAwsEstates: ["bogus"] }));
		// ambiguous classifier -> all configured estates
		expect(result.awsTargetEstates).toEqual(["prod", "staging", "dev"]);
		expect(invokeCalls).toBe(1);
	});

	test("empty UI selection runs the classifier as before", async () => {
		llmResponseJson = '{"kind":"explicit","estates":["staging"]}';
		const result = await awsEstateRouter(makeState({ uiAwsEstates: [] }));
		expect(result.awsTargetEstates).toEqual(["staging"]);
		expect(invokeCalls).toBe(1);
	});

	test("AWS not in scope short-circuits before any estate logic", async () => {
		const result = await awsEstateRouter(makeState({ targetDataSources: [], uiAwsEstates: ["prod"] }));
		expect(result.awsTargetEstates).toEqual([]);
		expect(invokeCalls).toBe(0);
	});
});
