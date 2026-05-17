// packages/shared/src/__tests__/bootstrap.identity.test.ts
import { describe, expect, test } from "bun:test";
import { createMcpApplication, type IdentityCard } from "../index.ts";

describe("createMcpApplication identity wiring", () => {
	test("constructs an IdentityCard from role + version + identityFingerprint", async () => {
		let received: IdentityCard | undefined;
		await createMcpApplication<{ host: string }>({
			name: "test-identity",
			logger: { info: () => {}, error: () => {}, warn: () => {} },
			initTracing: () => {},
			telemetry: { enabled: false, serviceName: "test", mode: "console", otlpEndpoint: "" },
			mode: "proxy",
			role: "elastic-mcp",
			version: "9.9.9",
			identityFingerprint: (ds) => `fp-${ds.host}`,
			initDatasource: async () => ({ host: "fixture" }),
			createTransport: async (_factory, _ds, identityCard) => {
				received = identityCard;
				return { closeAll: async () => {} };
			},
		});
		expect(received).toBeDefined();
		expect(received?.role).toBe("elastic-mcp");
		expect(received?.version).toBe("9.9.9");
		expect(received?.upstreamFingerprint).toBe("fp-fixture");
		expect(received?.mode).toBe("agentcore-proxy");
		// Do NOT await app.shutdown() — it calls process.exit(0) in production code.
		// Just let the test return; the bun test runner cleans up.
	});
});
