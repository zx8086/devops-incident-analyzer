// src/__tests__/probe-failure-classification.test.ts
import { describe, expect, test } from "bun:test";
import { _describeProbeFailureForTest as describeProbeFailure } from "../mcp-bridge.ts";

// SIO-1478: a probe timeout and a refused connection both used to render as
// "<tier> unreachable: ...". They call for opposite operator responses -- a
// refusal means the process is gone (restart it), a timeout usually means the
// process is alive and BLOCKED (find the slow call). Observed live: a 136s
// GitLab tool call starved elastic-iac-mcp's 1s /identity probe and the server
// was reported down while serving traffic normally either side of it.
describe("describeProbeFailure", () => {
	test("a timeout says the server may be blocked, not gone", () => {
		const err = new Error("The operation was aborted due to timeout");
		err.name = "TimeoutError";
		const out = describeProbeFailure("identity", err);
		expect(out).toContain("timed out");
		expect(out).toContain("blocked");
		expect(out).not.toContain("unreachable");
	});

	test("an AbortError is treated the same as a TimeoutError", () => {
		const err = new Error("aborted");
		err.name = "AbortError";
		expect(describeProbeFailure("health", err)).toContain("timed out");
	});

	test("a refused connection still reads as unreachable", () => {
		const out = describeProbeFailure("health", new Error("connect ECONNREFUSED 127.0.0.1:9086"));
		expect(out).toContain("unreachable");
		expect(out).toContain("ECONNREFUSED");
		expect(out).not.toContain("blocked");
	});

	test("the tier name is preserved so the failing check is identifiable", () => {
		expect(describeProbeFailure("identity", new Error("boom"))).toStartWith("identity ");
		expect(describeProbeFailure("health", new Error("boom"))).toStartWith("health ");
	});

	test("a non-Error rejection does not throw", () => {
		expect(describeProbeFailure("health", "socket closed")).toContain("socket closed");
	});
});
