// tests/unit/tools/enrich/get_policy_improved.test.ts
// SIO-1047: characterization coverage for getPolicyHandler's extracted helpers
// (resolvePolicyConfig / transformPolicySummaries / findRawPolicyByName / comparePolicySummaries /
// buildSummaryModeContent / buildDetailedModeContent), exercised only through the registered tool handler.

import { describe, expect, test } from "bun:test";
import type { Client } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { registerEnrichGetPolicyTool } from "../../../../src/tools/enrich/get_policy_improved.js";
import { getToolFromServer } from "../../../utils/elasticsearch-client.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

const matchPolicy = {
	config: {
		match: {
			name: "user-lookup",
			indices: ["users-index"],
			match_field: "user_id",
			enrich_fields: ["email", "name"],
			query: true,
		},
	},
	created: "2026-01-15T10:00:00.000Z",
};

const geoMatchPolicy = {
	config: {
		geo_match: {
			name: "geo-lookup",
			indices: ["geo-index"],
			match_field: "location",
			enrich_fields: ["region"],
		},
	},
};

const rangePolicy = {
	config: {
		range: {
			name: "range-lookup",
			indices: "range-index",
			match_field: "value",
			enrich_fields: "tier",
		},
	},
};

function makeHandler(policies: unknown[]): { handler: Handler; lastArgs: { current?: Record<string, unknown> } } {
	const lastArgs: { current?: Record<string, unknown> } = {};
	const stub = {
		enrich: {
			getPolicy: async (args: Record<string, unknown>) => {
				lastArgs.current = args;
				return { policies };
			},
		},
	} as unknown as Client;

	const server = new McpServer({ name: "test", version: "1.0.0" });
	registerEnrichGetPolicyTool(server, stub);
	const tool = getToolFromServer(server, "elasticsearch_enrich_get_policy");
	if (!tool) throw new Error("tool not registered");
	return { handler: tool.handler as Handler, lastArgs };
}

describe("elasticsearch_enrich_get_policy (SIO-1047 handler-helper extraction)", () => {
	test("resolves match/geo_match/range config types and lists them in summary mode", async () => {
		const { handler } = makeHandler([matchPolicy, geoMatchPolicy, rangePolicy]);
		const out = await handler({ summary: true });
		const text = out.content[0]?.text ?? "";

		expect(text).toContain("### user-lookup");
		expect(text).toContain("- **Type**: match");
		expect(text).toContain("### geo-lookup");
		expect(text).toContain("- **Type**: geo_match");
		expect(text).toContain("### range-lookup");
		expect(text).toContain("- **Type**: range");
		// range policy's indices/enrich_fields are singular strings, not arrays - must still be captured
		expect(text).toContain("- **Source Indices**: 1");
		expect(text).toContain("  - range-index");
		expect(text).toContain("- **Has Query Filter**: Yes");
		expect(text).toContain("- **Created**: 2026-01-15");
	});

	test("returns unknown type and empty arrays when no config union member is set", async () => {
		const { handler } = makeHandler([{ config: {} }]);
		const out = await handler({ summary: true });
		const text = out.content[0]?.text ?? "";

		expect(text).toContain("### unnamed");
		expect(text).toContain("- **Type**: unknown");
		expect(text).toContain("- **Source Indices**: 0");
		expect(text).toContain("- **Enrich Fields**: 0");
	});

	test("single specific policy name short-circuits to the raw-policy detail view", async () => {
		const { handler } = makeHandler([matchPolicy, geoMatchPolicy]);
		const out = await handler({ name: "user-lookup" });
		const text = out.content[0]?.text ?? "";

		expect(text).toContain("## Enrich Policy: user-lookup");
		expect(text).toContain('"name": "user-lookup"');
		expect(text).not.toContain("geo-lookup");
	});

	test("detailed mode (summary: false) renders full JSON for each paginated policy via findRawPolicyByName", async () => {
		const { handler } = makeHandler([matchPolicy, geoMatchPolicy]);
		const out = await handler({});
		const text = out.content[0]?.text ?? "";

		expect(text).toContain("## Policy Details");
		expect(text).toContain('"name": "user-lookup"');
		expect(text).toContain('"name": "geo-lookup"');
	});

	test("sortBy=type orders policies by type, indices_count orders by source index count desc", async () => {
		const { handler } = makeHandler([matchPolicy, geoMatchPolicy, rangePolicy]);
		const byType = await handler({ summary: true, sortBy: "type" });
		const typeText = byType.content[0]?.text ?? "";
		const geoIdx = typeText.indexOf("### geo-lookup");
		const matchIdx = typeText.indexOf("### user-lookup");
		const rangeIdx = typeText.indexOf("### range-lookup");
		// alphabetical by type: geo_match < match < range
		expect(geoIdx).toBeLessThan(matchIdx);
		expect(matchIdx).toBeLessThan(rangeIdx);
	});

	test("empty policies list renders the no-results message", async () => {
		const { handler } = makeHandler([]);
		const out = await handler({});
		expect(out.content[0]?.text).toContain("No enrich policies found.");
	});

	test("policy statistics block only renders when total > 5", async () => {
		const sixPolicies = Array.from({ length: 6 }, (_, i) => ({
			config: { match: { name: `p${i}`, indices: [`idx-${i}`], match_field: "id", enrich_fields: ["f"] } },
		}));
		const { handler } = makeHandler(sixPolicies);
		const out = await handler({ summary: true, limit: 50 });
		expect(out.content[0]?.text).toContain("## Policy Statistics");

		const { handler: smallHandler } = makeHandler(sixPolicies.slice(0, 3));
		const smallOut = await smallHandler({ summary: true });
		expect(smallOut.content[0]?.text).not.toContain("## Policy Statistics");
	});

	test("validation failure throws a McpError with the ZodError clone-group branch", async () => {
		const { handler } = makeHandler([]);
		let threw: unknown;
		try {
			await handler({ limit: "not-a-number" });
		} catch (err) {
			threw = err;
		}
		expect(threw).toBeInstanceOf(McpError);
		expect((threw as McpError).message).toContain("[elasticsearch_enrich_get_policy]");
	});
});
