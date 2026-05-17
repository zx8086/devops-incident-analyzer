// packages/shared/src/transport/__tests__/agentcore-proxy.identity.test.ts
import { describe, expect, test } from "bun:test";
import { type ProxyConfig, startAgentCoreProxy } from "../../agentcore-proxy.ts";
import type { IdentityCard } from "../../transport/identity.ts";

// We test startAgentCoreProxy directly (not createAgentCoreProxyTransport),
// because the wrapper requires env-var loading that complicates fixture setup.
// The wrapper's job is just to call into startAgentCoreProxy -- covered by the
// type-checker once the signature is updated.

const fixtureCard: IdentityCard = {
	instanceId: "11111111-1111-1111-1111-111111111111",
	role: "kafka-proxy",
	version: "1.2.3",
	bootedAt: "2026-05-17T00:00:00.000Z",
	pid: 1234,
	mode: "agentcore-proxy",
	upstreamFingerprint: "deadbeefcafef00d",
};

const fixtureConfig: ProxyConfig = {
	runtimeArn: "arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime/test",
	region: "eu-west-1",
	port: 0, // bun picks an unused port
	qualifier: "DEFAULT",
	serverName: "test-proxy",
	credentials: {
		accessKeyId: "AKIAIOSFODNN7EXAMPLE",
		secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	},
};

describe("agentcore proxy /identity", () => {
	test("GET /identity returns the supplied IdentityCard", async () => {
		const handle = await startAgentCoreProxy(fixtureConfig, fixtureCard);
		try {
			const url = `${handle.url}/identity`;
			const res = await fetch(url);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body).toEqual(fixtureCard);
		} finally {
			await handle.close();
		}
	});

	test("GET /health is unchanged (sibling route still works)", async () => {
		const handle = await startAgentCoreProxy(fixtureConfig, fixtureCard);
		try {
			const res = await fetch(`${handle.url}/health`);
			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.status).toBe("ok");
		} finally {
			await handle.close();
		}
	});
});
