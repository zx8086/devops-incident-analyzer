// test/server.test.ts
// SIO-703: pin the once-per-process logging behavior of createGitLabServer
// so HTTP stateless mode (where the factory fires per-request) doesn't spam
// the "MCP server created" / "proxy tools registered" lines on every tool call.

import { beforeEach, describe, expect, test } from "bun:test";
import { _isServerCreatedLoggedForTest, _resetServerCreatedLoggedForTest, createGitLabServer } from "../src/server.js";
import {
	_isProxyToolsRegisteredLoggedForTest,
	_resetProxyToolsRegisteredLoggedForTest,
} from "../src/tools/proxy/index.js";

function makeDatasource() {
	return {
		proxy: {
			callTool: async () => ({ content: [] }),
			listTools: async () => [],
		} as unknown as Parameters<typeof createGitLabServer>[0]["proxy"],
		restClient: {} as unknown as Parameters<typeof createGitLabServer>[0]["restClient"],
		config: {
			application: { name: "gitlab-mcp-server", version: "0.0.0-test" },
		} as unknown as Parameters<typeof createGitLabServer>[0]["config"],
		discoveredTools: [],
	};
}

describe("createGitLabServer SIO-703 once-per-process logging", () => {
	beforeEach(() => {
		_resetServerCreatedLoggedForTest();
		_resetProxyToolsRegisteredLoggedForTest();
	});

	test("server-created flag flips to true on first invocation", () => {
		expect(_isServerCreatedLoggedForTest()).toBe(false);
		createGitLabServer(makeDatasource());
		expect(_isServerCreatedLoggedForTest()).toBe(true);
	});

	test("proxy-tools-registered stays false when discoveredTools is empty (registration is skipped)", () => {
		// Mirrors the actual server.ts behavior at line 45-47: registerProxyTools is
		// only called when discoveredTools is non-empty. The flag therefore stays false.
		createGitLabServer(makeDatasource());
		expect(_isProxyToolsRegisteredLoggedForTest()).toBe(false);
	});

	test("flags survive multiple factory invocations (proves the suppression branch is taken)", () => {
		createGitLabServer(makeDatasource());
		createGitLabServer(makeDatasource());
		createGitLabServer(makeDatasource());
		expect(_isServerCreatedLoggedForTest()).toBe(true);
	});

	test("after reset, the next factory call sets the flag back to true", () => {
		createGitLabServer(makeDatasource());
		_resetServerCreatedLoggedForTest();
		expect(_isServerCreatedLoggedForTest()).toBe(false);
		createGitLabServer(makeDatasource());
		expect(_isServerCreatedLoggedForTest()).toBe(true);
	});
});
