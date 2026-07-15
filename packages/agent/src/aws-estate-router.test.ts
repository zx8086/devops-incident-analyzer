// packages/agent/src/aws-estate-router.test.ts
// SIO-836: UI estate selection takes precedence over the LLM classifier.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
// SIO-1114: the real wrapper (not the mocked bridge) so the regression test drives
// the actual estate-scope guard exemption for aws_list_estates.
import { wrapAwsToolsWithEstate } from "./aws-tool-estate-wrapper.ts";

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

// SIO-854: the router reconciles its AWS_ESTATES against the server's
// aws_list_estates. Mock the bridge so we control the server-reported set and
// capture the WARN emitted on divergence.
let serverEstateIds: string[] = ["prod", "staging", "dev"];
let listEstatesInvokeCalls = 0;
let listEstatesThrows = false;
let listEstatesPresent = true;
// SIO-1114: when true, the stub aws_list_estates is passed through the REAL
// wrapAwsToolsWithEstate (as production does) so the regression test exercises the
// actual estate-scope guard/exemption instead of a bare unwrapped tool.
let wrapListEstates = false;

mock.module("./mcp-bridge.ts", () => ({
	getToolsForDataSource: (dataSourceId: string) => {
		if (dataSourceId !== "aws" || !listEstatesPresent) return [];
		const stub: Partial<StructuredToolInterface> = {
			name: "aws_list_estates",
			async invoke() {
				listEstatesInvokeCalls += 1;
				if (listEstatesThrows) throw new Error("server unreachable");
				return JSON.stringify({
					estates: serverEstateIds.map((id) => ({ id, region: "eu-west-1" })),
					health: {},
				});
			},
		};
		if (!wrapListEstates) return [stub as unknown as StructuredToolInterface];
		return wrapAwsToolsWithEstate([stub as unknown as StructuredToolInterface]);
	},
}));

const capturedWarns: Array<{ meta: Record<string, unknown> | undefined; msg: string }> = [];

import {
	_resetEstateCacheForTests,
	_resetEstateReconcileForTests,
	_setAwsEstateRouterLoggerForTesting,
	awsEstateRouter,
} from "./aws-estate-router.ts";
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

describe("awsEstateRouter estate drift detection (SIO-854)", () => {
	beforeEach(() => {
		invokeCalls = 0;
		llmResponseJson = '{"kind":"ambiguous"}';
		serverEstateIds = ["prod", "staging", "dev"];
		listEstatesInvokeCalls = 0;
		listEstatesThrows = false;
		listEstatesPresent = true;
		wrapListEstates = false; // SIO-1114: default to the unwrapped stub
		capturedWarns.length = 0;
		process.env.AWS_ESTATES = JSON.stringify({
			prod: { assumedRoleArn: "arn:aws:iam::1:role/r", externalId: "e" },
			staging: { assumedRoleArn: "arn:aws:iam::2:role/r", externalId: "e" },
			dev: { assumedRoleArn: "arn:aws:iam::3:role/r", externalId: "e" },
		});
		_resetEstateCacheForTests();
		_resetEstateReconcileForTests();
		_setAwsEstateRouterLoggerForTesting({
			info: () => {},
			warn: (meta: unknown, msg?: unknown) => {
				if (typeof meta === "string") capturedWarns.push({ meta: undefined, msg: meta });
				else capturedWarns.push({ meta: meta as Record<string, unknown>, msg: typeof msg === "string" ? msg : "" });
			},
		});
	});

	afterEach(() => {
		if (ORIG_ESTATES === undefined) delete process.env.AWS_ESTATES;
		else process.env.AWS_ESTATES = ORIG_ESTATES;
		_resetEstateCacheForTests();
		_resetEstateReconcileForTests();
		_setAwsEstateRouterLoggerForTesting(null);
	});

	const driftMsg = "AWS estate config drift between agent and server";

	test("no warn when agent and server estate lists match", async () => {
		const result = await awsEstateRouter(makeState({ uiAwsEstates: ["prod"] }));
		expect(result.awsTargetEstates).toEqual(["prod"]);
		expect(capturedWarns.find((w) => w.msg === driftMsg)).toBeUndefined();
	});

	test("warns and drops an estate the agent has but the server does not", async () => {
		// Server is missing "dev" -> agent's dev is server-unknown.
		serverEstateIds = ["prod", "staging"];
		const result = await awsEstateRouter(makeState({ uiAwsEstates: [] }));
		// classifier is ambiguous -> all KNOWN-TO-SERVER estates, dev dropped
		expect(result.awsTargetEstates).toEqual(["prod", "staging"]);
		const warn = capturedWarns.find((w) => w.msg === driftMsg);
		expect(warn).toBeDefined();
		expect(warn?.meta?.onlyInAgent).toEqual(["dev"]);
		expect(warn?.meta?.onlyInServer).toEqual([]);
	});

	test("warns when the server has an estate the agent lacks", async () => {
		serverEstateIds = ["prod", "staging", "dev", "sandbox"];
		await awsEstateRouter(makeState({ uiAwsEstates: ["prod"] }));
		const warn = capturedWarns.find((w) => w.msg === driftMsg);
		expect(warn).toBeDefined();
		expect(warn?.meta?.onlyInAgent).toEqual([]);
		expect(warn?.meta?.onlyInServer).toEqual(["sandbox"]);
	});

	test("reconciliation runs once across multiple dispatches", async () => {
		await awsEstateRouter(makeState({ uiAwsEstates: ["prod"] }));
		await awsEstateRouter(makeState({ uiAwsEstates: ["staging"] }));
		expect(listEstatesInvokeCalls).toBe(1);
	});

	test("non-fatal when aws_list_estates throws: falls back to configured estates", async () => {
		listEstatesThrows = true;
		const result = await awsEstateRouter(makeState({ uiAwsEstates: ["prod"] }));
		expect(result.awsTargetEstates).toEqual(["prod"]);
		// no drift warn, but the failure is surfaced
		expect(capturedWarns.find((w) => w.msg === driftMsg)).toBeUndefined();
	});

	test("non-fatal when the tool is absent: falls back to configured estates", async () => {
		listEstatesPresent = false;
		const result = await awsEstateRouter(makeState({ uiAwsEstates: ["dev"] }));
		expect(result.awsTargetEstates).toEqual(["dev"]);
	});

	// SIO-1114 regression: production wraps aws_list_estates with the real
	// wrapAwsToolsWithEstate. Before the exemption, invoking it with no withAwsEstate
	// scope threw ("outside withAwsEstate scope"), the router swallowed it, and drift
	// reconciliation silently no-op'd. With the exemption it runs, so the drift WARN
	// fires on divergence. This FAILS before the fix (no warn, falls back), passes after.
	test("reconciliation runs through the REAL wrapper with no scope active (SIO-1114)", async () => {
		wrapListEstates = true;
		serverEstateIds = ["prod", "staging"]; // server missing "dev" -> drift
		const result = await awsEstateRouter(makeState({ uiAwsEstates: [] }));
		expect(listEstatesInvokeCalls).toBe(1); // the wrapped tool actually ran
		expect(result.awsTargetEstates).toEqual(["prod", "staging"]); // dev reconciled out
		const warn = capturedWarns.find((w) => w.msg === driftMsg);
		expect(warn).toBeDefined();
		expect(warn?.meta?.onlyInAgent).toEqual(["dev"]);
	});
});
