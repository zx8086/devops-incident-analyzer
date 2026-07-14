// packages/agent/src/eval/bindings-eval.test.ts
//
// SIO-1102: offline validation harness for the W8 telemetry-binding derivation.
// Replays AgentStateType fixtures through deriveConfirmedBindings and reports the
// false-binding rate (identifiers written that should NOT have been) and recall
// (expected identifiers that were written). Runs as a plain `bun test` -- no MCP
// servers, no Bedrock, no LangSmith, unlike the LangSmith final_response eval.
//
// The fixtures below are SYNTHETIC, modelling the confirmation logic's decision
// points. Real archetype fixtures (the four incidents in the plan's Section 7) are
// captured from live traces via the fixture-capture recipe (curl -> LangSmith -> jq)
// and dropped into REAL_FIXTURES; until then the synthetic set exercises the same
// code path deterministically. The pass bar is a MAX false-binding rate so a
// regression that loosens confirmation fails the suite.

import { describe, expect, test } from "bun:test";
import type { DataSourceResult, ToolOutput } from "@devops-agent/shared";
import { deriveConfirmedBindings } from "../record-bindings.ts";
import type { AgentStateType } from "../state.ts";

interface BindingFixture {
	name: string;
	state: AgentStateType;
	// The (datasource, resourceId) pairs that SHOULD be confirmed for this fixture.
	expected: Array<{ datasource: string; resourceId: string }>;
}

// A tool output whose parsed JSON mentions the given identifiers (so identifier-level
// confirmation sees them as "used").
function toolOutput(toolName: string, mentions: string[]): ToolOutput {
	return { toolName, rawJson: { hits: mentions.map((m) => ({ ref: m })) } };
}

function dsResult(over: Partial<DataSourceResult> & { dataSourceId: string }): DataSourceResult {
	return { data: {}, status: "success", toolErrors: [], ...over } as DataSourceResult;
}

function fixtureState(over: {
	resolved: AgentStateType["resolvedIdentifiers"];
	results: DataSourceResult[];
}): AgentStateType {
	return {
		requestId: "eval-req",
		investigationFocus: {
			services: ["orders"],
			datasources: ["elastic", "aws"],
			summary: "eval",
			establishedAtTurn: 1,
		},
		resolvedIdentifiers: over.resolved,
		dataSourceResults: over.results,
	} as unknown as AgentStateType;
}

const SYNTHETIC_FIXTURES: BindingFixture[] = [
	{
		name: "clean confirm: resolved identifier used in a successful tool call",
		state: fixtureState({
			resolved: {
				resolvedForTurn: 1,
				resolvedForServices: ["orders"],
				elastic: { serviceNames: ["orders-api"] },
				aws: { logGroups: ["/ecs/orders-prd"] },
			},
			results: [
				dsResult({ dataSourceId: "elastic", toolOutputs: [toolOutput("elasticsearch_search", ["orders-api"])] }),
				dsResult({ dataSourceId: "aws", toolOutputs: [toolOutput("start_query", ["/ecs/orders-prd"])] }),
			],
		}),
		expected: [
			{ datasource: "elastic", resourceId: "orders-api" },
			{ datasource: "aws", resourceId: "/ecs/orders-prd" },
		],
	},
	{
		name: "false-binding guard: identifier resolved but NEVER used in a tool call",
		state: fixtureState({
			resolved: {
				resolvedForTurn: 1,
				resolvedForServices: ["orders"],
				elastic: { serviceNames: ["orders-api", "orders-ghost"] },
			},
			// only orders-api appears in the tool output; orders-ghost must be dropped
			results: [
				dsResult({ dataSourceId: "elastic", toolOutputs: [toolOutput("elasticsearch_search", ["orders-api"])] }),
			],
		}),
		expected: [{ datasource: "elastic", resourceId: "orders-api" }],
	},
	{
		name: "degrading error drops the whole datasource",
		state: fixtureState({
			resolved: { resolvedForTurn: 1, resolvedForServices: ["orders"], aws: { logGroups: ["/ecs/orders-prd"] } },
			results: [
				dsResult({
					dataSourceId: "aws",
					toolOutputs: [toolOutput("start_query", ["/ecs/orders-prd"])],
					toolErrors: [{ toolName: "start_query", category: "auth", message: "denied", retryable: false }],
				}),
			],
		}),
		expected: [],
	},
	{
		name: "no tool outputs -> datasource-level fallback keeps the binding",
		state: fixtureState({
			resolved: { resolvedForTurn: 1, resolvedForServices: ["orders"], elastic: { serviceNames: ["orders-api"] } },
			results: [dsResult({ dataSourceId: "elastic", toolOutputs: [] })],
		}),
		expected: [{ datasource: "elastic", resourceId: "orders-api" }],
	},
];

// Placeholder for real trace-captured fixtures (empty until captured). When present
// they are scored by the SAME harness with the same pass bar.
const REAL_FIXTURES: BindingFixture[] = [];

const ALL_FIXTURES = [...SYNTHETIC_FIXTURES, ...REAL_FIXTURES];

// The pass bar. A false binding is a written (datasource, resourceId) NOT in the
// fixture's expected set. Stage 3 requires zero on the synthetic set; real fixtures
// may relax this to a small rate once captured.
const MAX_FALSE_BINDING_RATE = 0;

function key(b: { datasource: string; resourceId: string }): string {
	return `${b.datasource}::${b.resourceId}`;
}

describe("SIO-1102 bindings-eval (offline false-binding rate)", () => {
	for (const fx of ALL_FIXTURES) {
		test(fx.name, () => {
			const produced = deriveConfirmedBindings(fx.state).map((r) => ({
				datasource: r.datasource,
				resourceId: r.resourceId,
			}));
			const expectedKeys = new Set(fx.expected.map(key));
			const producedKeys = new Set(produced.map(key));
			// Exact set match: no false bindings, no missed expected bindings.
			expect([...producedKeys].sort()).toEqual([...expectedKeys].sort());
		});
	}

	test("aggregate false-binding rate across all fixtures is within budget", () => {
		let written = 0;
		let falseBindings = 0;
		for (const fx of ALL_FIXTURES) {
			const expectedKeys = new Set(fx.expected.map(key));
			const produced = deriveConfirmedBindings(fx.state).map((r) => ({
				datasource: r.datasource,
				resourceId: r.resourceId,
			}));
			for (const b of produced) {
				written += 1;
				if (!expectedKeys.has(key(b))) falseBindings += 1;
			}
		}
		const rate = written === 0 ? 0 : falseBindings / written;
		// Surfaced for the reviewer even on a pass.
		expect({ written, falseBindings, rate }).toMatchObject({ rate: expect.any(Number) });
		expect(rate).toBeLessThanOrEqual(MAX_FALSE_BINDING_RATE);
	});
});
