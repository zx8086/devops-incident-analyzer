// packages/shared/src/__tests__/agentcore-config.test.ts
// Unit tests for loadProxyConfigFromEnv. Reads <PREFIX>_AGENTCORE_* env vars
// and produces a ProxyConfig object; throws on missing required vars.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadProxyConfigFromEnv } from "../agentcore-proxy.ts";

const VARS_TO_RESTORE = [
	"AWS_AGENTCORE_RUNTIME_ARN",
	"AWS_AGENTCORE_REGION",
	"AWS_AGENTCORE_PROXY_PORT",
	"AWS_AGENTCORE_QUALIFIER",
	"AWS_AGENTCORE_SERVER_NAME",
	"AWS_AGENTCORE_AWS_ACCESS_KEY_ID",
	"AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY",
	"AWS_AGENTCORE_AWS_SESSION_TOKEN",
	"AWS_AGENTCORE_AWS_PROFILE",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
	saved = {};
	for (const v of VARS_TO_RESTORE) {
		saved[v] = process.env[v];
		delete process.env[v];
	}
});

afterEach(() => {
	for (const v of VARS_TO_RESTORE) {
		if (saved[v] === undefined) delete process.env[v];
		else process.env[v] = saved[v];
	}
});

const TEST_ARN = "arn:aws:bedrock-agentcore:eu-central-1:356994971776:runtime/aws_mcp_server-57wIOB35U1";

describe("loadProxyConfigFromEnv", () => {
	test("reads <PREFIX>_AGENTCORE_RUNTIME_ARN correctly", () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_PROXY_PORT = "3001";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";

		const cfg = loadProxyConfigFromEnv("AWS");

		expect(cfg.runtimeArn).toBe(TEST_ARN);
		expect(cfg.region).toBe("eu-central-1");
		expect(cfg.port).toBe(3001);
	});

	test("throws when <PREFIX>_AGENTCORE_RUNTIME_ARN is missing", () => {
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_PROXY_PORT = "3001";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";

		expect(() => loadProxyConfigFromEnv("AWS")).toThrow(/AWS_AGENTCORE_RUNTIME_ARN/);
	});

	test("throws when <PREFIX>_AGENTCORE_REGION is missing", () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_PROXY_PORT = "3001";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";

		expect(() => loadProxyConfigFromEnv("AWS")).toThrow(/AWS_AGENTCORE_REGION/);
	});

	test("throws when <PREFIX>_AGENTCORE_PROXY_PORT is missing", () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";

		expect(() => loadProxyConfigFromEnv("AWS")).toThrow(/AWS_AGENTCORE_PROXY_PORT/);
	});

	test("throws when <PREFIX>_AGENTCORE_PROXY_PORT is non-numeric", () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_PROXY_PORT = "not-a-number";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";

		expect(() => loadProxyConfigFromEnv("AWS")).toThrow(/AWS_AGENTCORE_PROXY_PORT/);
	});

	test("uses defaults for QUALIFIER and SERVER_NAME when not set", () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_PROXY_PORT = "3001";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";

		const cfg = loadProxyConfigFromEnv("AWS");

		expect(cfg.qualifier).toBe("DEFAULT");
		expect(cfg.serverName).toBe("mcp-server");
	});

	test("returns static credentials when <PREFIX>_AGENTCORE_AWS_ACCESS_KEY_ID is set", async () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_PROXY_PORT = "3001";
		process.env.AWS_AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATEST";
		process.env.AWS_AGENTCORE_AWS_SECRET_ACCESS_KEY = "secret";
		process.env.AWS_AGENTCORE_AWS_SESSION_TOKEN = "session-token-value";

		const cfg = loadProxyConfigFromEnv("AWS");

		// Static path: credentials is the object directly, not a function.
		expect(typeof cfg.credentials).toBe("object");
		const creds = cfg.credentials as { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
		expect(creds.accessKeyId).toBe("AKIATEST");
		expect(creds.secretAccessKey).toBe("secret");
		expect(creds.sessionToken).toBe("session-token-value");
	});

	test("returns a credentials function when only AWS_PROFILE is set (lazy AWS-CLI fallback)", () => {
		process.env.AWS_AGENTCORE_RUNTIME_ARN = TEST_ARN;
		process.env.AWS_AGENTCORE_REGION = "eu-central-1";
		process.env.AWS_AGENTCORE_PROXY_PORT = "3001";
		process.env.AWS_AGENTCORE_AWS_PROFILE = "test-profile";

		const cfg = loadProxyConfigFromEnv("AWS");

		// Lazy path: credentials is a function, not an object. Do NOT call the
		// function here -- it shells to `aws configure export-credentials` which
		// requires a real AWS CLI setup. Just assert the shape.
		expect(typeof cfg.credentials).toBe("function");
	});
});
