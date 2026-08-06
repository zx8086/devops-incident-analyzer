// packages/agent/src/eval/tool-probe.test.ts
// SIO-1398: the direct-probe classifier. Pure string -> verdict, so these run with no server.

import { describe, expect, test } from "bun:test";
import { classifyProbeResponse, probeFailures, probeUrls } from "./tool-probe.ts";

describe("classifyProbeResponse", () => {
	test("a successful payload is ok", () => {
		expect(classifyProbeResponse('{"result":{"content":[{"type":"text","text":"rows"}]}}').verdict).toBe("ok");
	});

	test("a successful payload containing the word 'required' is still ok", () => {
		// Regression: an earlier classifier regexed /required/i over the whole body and matched
		// the literal string inside a SUCCESSFUL payload (a Couchbase index actually named
		// idx_variant_required_fields_covered), reporting working tools as needs-args.
		const body = '{"result":{"content":[{"type":"text","text":"idx_variant_required_fields_covered"}]}}';
		expect(classifyProbeResponse(body).verdict).toBe("ok");
	});

	test("a schema rejection is needs-args and names the parameter", () => {
		const body =
			'{"result":{"content":[{"type":"text","text":"MCP error -32602: Invalid arguments: [{\\"path\\":[\\"project_id\\"],\\"code\\":\\"invalid_type\\"}]"}],"isError":true}}';
		const r = classifyProbeResponse(body);
		expect(r.verdict).toBe("needs-args");
		expect(r.missingParam).toBe("project_id");
	});

	test("a HANDLER-layer argument error is needs-args, not a tool defect", () => {
		// gitlab_get_merge_request_notes accepts {} at the schema (its params are individually
		// optional because several combinations are valid) and enforces the requirement in the
		// handler. Classifying that as a defect would report a healthy tool as broken.
		const body =
			'{"result":{"content":[{"type":"text","text":"Validation error: Provide either url, or project_id and merge_request_iid"}],"isError":true}}';
		expect(classifyProbeResponse(body).verdict).toBe("needs-args");
	});

	test("a structured tool error keeps its kind", () => {
		const body =
			'{"result":{"content":[{"type":"text","text":"{\\"_error\\":{\\"kind\\":\\"no-index\\"}}"}],"isError":true}}';
		const r = classifyProbeResponse(body);
		expect(r.verdict).toBe("tool-error");
		expect(r.kind).toBe("no-index");
	});

	test("an unregistered tool is unreachable", () => {
		expect(classifyProbeResponse('{"error":{"code":-32601,"message":"Method not found"}}').verdict).toBe("unreachable");
	});
});

describe("probeFailures", () => {
	test("counts only genuine defects -- needs-args and no-server are not failures", () => {
		const report = {
			results: [
				{ toolName: "a", dataSource: "x", verdict: "ok" as const, durationMs: 1 },
				{ toolName: "b", dataSource: "x", verdict: "needs-args" as const, durationMs: 1 },
				{ toolName: "c", dataSource: "x", verdict: "no-server" as const, durationMs: 0 },
				{ toolName: "d", dataSource: "x", verdict: "tool-error" as const, durationMs: 1 },
				{ toolName: "e", dataSource: "x", verdict: "unreachable" as const, durationMs: 1 },
			],
			byDatasource: new Map(),
		};
		expect(probeFailures(report).map((f) => f.toolName)).toEqual(["d", "e"]);
	});
});

describe("probeUrls", () => {
	test("reads the same env vars the agent uses, so probe and eval hit identical servers", () => {
		const urls = probeUrls({ ELASTIC_MCP_URL: "http://localhost:9080", AWS_MCP_URL: "http://localhost:3001" });
		expect(urls.elastic).toBe("http://localhost:9080");
		expect(urls.aws).toBe("http://localhost:3001");
		expect(urls.kafka).toBeUndefined();
	});
});
