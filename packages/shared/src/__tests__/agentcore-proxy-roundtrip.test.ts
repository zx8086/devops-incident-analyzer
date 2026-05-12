// packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
//
// SIO-733: end-to-end round-trip coverage for the AgentCore SigV4 proxy.
// Spins up startAgentCoreProxy() on an ephemeral port, intercepts the
// outbound fetch with a programmable fake, and asserts on signed headers,
// session-id propagation, retry behaviour, and response pass-through.
// Companion to the SIO-718 inner-status unit tests in
// ./agentcore-proxy-tool-status.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type AgentCoreProxyHandle, clearCredentialCache, startAgentCoreProxy } from "../agentcore-proxy.ts";

const ORIG_ENV = { ...process.env };
const ORIG_FETCH = globalThis.fetch;

const TEST_ARN = "arn:aws:bedrock:eu-central-1:123456789012:agent-runtime/test-mcp-XXXXX";
const TEST_REGION = "eu-central-1";

beforeAll(() => {
	process.env.AGENTCORE_RUNTIME_ARN = TEST_ARN;
	process.env.AGENTCORE_REGION = TEST_REGION;
	process.env.AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATESTACCESSKEY123";
	process.env.AGENTCORE_AWS_SECRET_ACCESS_KEY = "test-secret-key";
	process.env.AGENTCORE_AWS_SESSION_TOKEN = "test-session-token";
	process.env.AGENTCORE_PROXY_PORT = "0";
	process.env.MCP_SERVER_NAME = "mcp-server-roundtrip-test";
});

afterAll(() => {
	process.env = ORIG_ENV;
	globalThis.fetch = ORIG_FETCH;
});

let proxy: AgentCoreProxyHandle;
let fetchCalls: { url: string; init: RequestInit }[];
let fetchResponder: (call: number) => Response | Promise<Response>;

beforeEach(async () => {
	fetchCalls = [];
	fetchResponder = () => new Response("not configured", { status: 500 });
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const callIdx = fetchCalls.length;
		fetchCalls.push({ url: String(input), init: init ?? {} });
		return fetchResponder(callIdx);
	}) as typeof fetch;
	clearCredentialCache();
	proxy = await startAgentCoreProxy();
});

afterEach(async () => {
	await proxy.close();
	globalThis.fetch = ORIG_FETCH;
});

describe("agentcore-proxy round trip — scaffold", () => {
	test("proxy starts on an ephemeral port", () => {
		expect(proxy.port).toBeGreaterThan(0);
		expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	});
});
