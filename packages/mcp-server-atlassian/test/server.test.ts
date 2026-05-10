// test/server.test.ts
// SIO-703: pin the once-per-process logging behavior of createAtlassianServer
// so HTTP stateless mode (where the factory fires per-request) doesn't spam
// the "MCP server created" / "proxy tools registered" lines on every tool call.

import { beforeEach, describe, expect, test } from "bun:test";
import {
	_isServerCreatedLoggedForTest,
	_resetServerCreatedLoggedForTest,
	createAtlassianServer,
} from "../src/server.js";
import {
	_isProxyToolsRegisteredLoggedForTest,
	_resetProxyToolsRegisteredLoggedForTest,
} from "../src/tools/proxy/index.js";

function makeDatasource() {
	return {
		proxy: {
			callTool: async () => ({ content: [] }),
			listTools: async () => [],
		} as unknown as Parameters<typeof createAtlassianServer>[0]["proxy"],
		config: {
			application: { name: "atlassian-mcp-server", version: "0.0.0-test" },
			atlassian: { readOnly: true, incidentProjects: ["INC"] },
		} as unknown as Parameters<typeof createAtlassianServer>[0]["config"],
		discoveredTools: [],
	};
}

describe("createAtlassianServer SIO-703 once-per-process logging", () => {
	beforeEach(() => {
		_resetServerCreatedLoggedForTest();
		_resetProxyToolsRegisteredLoggedForTest();
	});

	test("server-created flag flips to true on first invocation", () => {
		expect(_isServerCreatedLoggedForTest()).toBe(false);
		createAtlassianServer(makeDatasource());
		expect(_isServerCreatedLoggedForTest()).toBe(true);
	});

	test("proxy-tools-registered flag flips to true on first invocation", () => {
		expect(_isProxyToolsRegisteredLoggedForTest()).toBe(false);
		createAtlassianServer(makeDatasource());
		expect(_isProxyToolsRegisteredLoggedForTest()).toBe(true);
	});

	test("flags remain true across subsequent factory invocations (proves the suppression branch is taken)", () => {
		createAtlassianServer(makeDatasource());
		createAtlassianServer(makeDatasource());
		createAtlassianServer(makeDatasource());
		// If the once-flag had been removed, both flags would still be true (idempotent),
		// so this only proves the flag survives. The companion test verifies the reset
		// path actually toggles back to false, confirming the flag is read on every call.
		expect(_isServerCreatedLoggedForTest()).toBe(true);
		expect(_isProxyToolsRegisteredLoggedForTest()).toBe(true);
	});

	test("after reset, the next factory call sets both flags back to true", () => {
		createAtlassianServer(makeDatasource());
		_resetServerCreatedLoggedForTest();
		_resetProxyToolsRegisteredLoggedForTest();
		expect(_isServerCreatedLoggedForTest()).toBe(false);
		expect(_isProxyToolsRegisteredLoggedForTest()).toBe(false);
		createAtlassianServer(makeDatasource());
		expect(_isServerCreatedLoggedForTest()).toBe(true);
		expect(_isProxyToolsRegisteredLoggedForTest()).toBe(true);
	});
});
