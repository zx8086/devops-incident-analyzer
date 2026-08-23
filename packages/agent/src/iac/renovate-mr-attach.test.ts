// agent/src/iac/renovate-mr-attach.test.ts
// SIO-1527: watchRenovateMr attaches the discovered MR to the TRIGGER turn's ConfigChange.
// The id must come from the durable in-flight marker on a "check again" turn (a fresh
// requestId would mint a second node); pre-SIO-1527 checkpointed markers lack the field and
// fall back to the current turn's requestId. Mocks follow the SIO-1045 value-snapshot +
// beforeAll/afterAll discipline; tool + dispatch stubs mirror pipeline-watch-parity.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDispatchNs from "@langchain/core/callbacks/dispatch";
import * as realMcpBridgeNs from "../mcp-bridge.ts";
import * as realLaneKnowledgeNs from "./lane-knowledge.ts";
import { watchRenovateMr } from "./nodes.ts";
import type { IacStateType } from "./state.ts";

const realDispatch = { ...realDispatchNs };
const realMcpBridge = { ...realMcpBridgeNs };
const realLaneKnowledge = { ...realLaneKnowledgeNs };

const MR_URL = "https://gitlab.example/x/-/merge_requests/42";

let attachCalls: Array<{ changeId: string; mrUrl: string }> = [];

beforeAll(() => {
	mock.module("@langchain/core/callbacks/dispatch", () => ({
		...realDispatch,
		dispatchCustomEvent: async () => {},
	}));
	const tools = [
		{
			name: "gitlab_list_merge_requests_by_source_branch",
			invoke: async () => JSON.stringify([{ web_url: MR_URL, state: "opened", updated_at: new Date().toISOString() }]),
		},
	];
	mock.module("../mcp-bridge.ts", () => ({
		...realMcpBridge,
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
	mock.module("./lane-knowledge.ts", () => ({
		...realLaneKnowledge,
		attachLaneChangeMr: async (changeId: string, mrUrl: string) => {
			attachCalls.push({ changeId, mrUrl });
		},
	}));
});

afterAll(() => {
	mock.module("@langchain/core/callbacks/dispatch", () => realDispatch);
	mock.module("../mcp-bridge.ts", () => realMcpBridge);
	mock.module("./lane-knowledge.ts", () => realLaneKnowledge);
});

beforeEach(() => {
	attachCalls = [];
});

function stateWith(over: Record<string, unknown>): IacStateType {
	return {
		messages: [],
		requestId: "fresh-req",
		threadId: "thread-1",
		renovateMarker: null,
		renovateTriggerAtIso: "",
		...over,
	} as unknown as IacStateType;
}

describe("watchRenovateMr MR attach (SIO-1527)", () => {
	test("a check-again turn attaches to the TRIGGER turn's ConfigChange id from the marker", async () => {
		const out = await watchRenovateMr(
			stateWith({
				renovateInFlightMarker: {
					deployment: "eu-b2b",
					marker: "renovate-eu-b2b-prometheus",
					line: "prometheus",
					triggerAtIso: "2026-08-20T10:00:00.000Z",
					requestId: "trigger-req",
				},
			}),
		);
		expect(out.renovateMrUrl).toBe(MR_URL);
		expect(attachCalls).toEqual([{ changeId: "trigger-req", mrUrl: MR_URL }]);
	});

	test("a pre-SIO-1527 marker (no requestId) skips the attach entirely", async () => {
		// No other id can match the trigger-time node, so attaching under the current turn's
		// requestId would be a silent wrong-id no-op (and MERGE an orphan MergeRequest node).
		const out = await watchRenovateMr(
			stateWith({
				renovateInFlightMarker: {
					deployment: "eu-b2b",
					marker: "renovate-eu-b2b-prometheus",
					line: "prometheus",
					triggerAtIso: "2026-08-20T10:00:00.000Z",
				},
			}),
		);
		expect(out.renovateMrUrl).toBe(MR_URL); // the MR discovery itself is unaffected
		expect(attachCalls).toEqual([]);
	});
});
