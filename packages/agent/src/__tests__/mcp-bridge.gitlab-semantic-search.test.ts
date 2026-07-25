// packages/agent/src/__tests__/mcp-bridge.gitlab-semantic-search.test.ts
// SIO-1209: getGitlabSemanticSearchStatus soft-fails to [] on every non-happy
// path (no URL configured, non-OK response, network error, malformed/
// unexpected JSON shape) so /health can never break because of this.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getGitlabSemanticSearchStatus } from "../mcp-bridge.ts";

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_URL = process.env.GITLAB_MCP_URL;

beforeEach(() => {
	process.env.GITLAB_MCP_URL = "http://localhost:9084";
});

afterEach(() => {
	global.fetch = ORIGINAL_FETCH;
	if (ORIGINAL_URL === undefined) delete process.env.GITLAB_MCP_URL;
	else process.env.GITLAB_MCP_URL = ORIGINAL_URL;
});

describe("getGitlabSemanticSearchStatus", () => {
	test("returns [] when GITLAB_MCP_URL is not configured", async () => {
		delete process.env.GITLAB_MCP_URL;
		const result = await getGitlabSemanticSearchStatus();
		expect(result).toEqual([]);
	});

	test("returns the tracked projects on a valid response", async () => {
		global.fetch = mock(async () =>
			Response.json({ notReadyProjects: [{ projectId: "90000001", lastNotReadyAt: "2026-07-25T11:00:00.000Z" }] }),
		) as unknown as typeof fetch;
		const result = await getGitlabSemanticSearchStatus();
		expect(result).toEqual([{ projectId: "90000001", lastNotReadyAt: "2026-07-25T11:00:00.000Z" }]);
	});

	test("returns [] when notReadyProjects is absent", async () => {
		global.fetch = mock(async () => Response.json({})) as unknown as typeof fetch;
		const result = await getGitlabSemanticSearchStatus();
		expect(result).toEqual([]);
	});

	test("returns [] on a non-OK response", async () => {
		global.fetch = mock(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
		const result = await getGitlabSemanticSearchStatus();
		expect(result).toEqual([]);
	});

	test("returns [] on a network error", async () => {
		global.fetch = mock(async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const result = await getGitlabSemanticSearchStatus();
		expect(result).toEqual([]);
	});

	// CodeRabbit (PR #468): the response body was an unchecked cast; a malformed
	// or unexpectedly-shaped payload (wrong types, wrong route hit) must soft-fail
	// to [] via Zod validation rather than silently propagating bad data.
	test("returns [] when the response body fails schema validation", async () => {
		global.fetch = mock(async () =>
			Response.json({ notReadyProjects: [{ projectId: 12345, lastNotReadyAt: "not-a-real-field" }] }),
		) as unknown as typeof fetch;
		const result = await getGitlabSemanticSearchStatus();
		expect(result).toEqual([]);
	});

	test("returns [] when the response body is not JSON at all", async () => {
		global.fetch = mock(async () => new Response("<html>wrong route</html>")) as unknown as typeof fetch;
		const result = await getGitlabSemanticSearchStatus();
		expect(result).toEqual([]);
	});
});
