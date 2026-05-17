// packages/shared/src/transport/__tests__/identity.test.ts
import { describe, expect, test } from "bun:test";
import { buildIdentityCard, canonicalizeUpstream } from "../identity.ts";

describe("canonicalizeUpstream", () => {
	test("same input → same fingerprint", () => {
		const a = canonicalizeUpstream({ host: "x", port: 9080 });
		const b = canonicalizeUpstream({ host: "x", port: 9080 });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{16}$/);
	});

	test("field order independence", () => {
		const a = canonicalizeUpstream({ host: "x", port: 9080 });
		const b = canonicalizeUpstream({ port: 9080, host: "x" });
		expect(a).toBe(b);
	});

	test("credential keys are redacted", () => {
		const withCreds = canonicalizeUpstream({ host: "x", password: "secret-1" });
		const withoutCreds = canonicalizeUpstream({ host: "x", password: "secret-2" });
		expect(withCreds).toBe(withoutCreds);
		const noCredKey = canonicalizeUpstream({ host: "x" });
		expect(withCreds).toBe(noCredKey);
	});

	test("allow-list keys (publicKey, instanceId) are NOT redacted", () => {
		const a = canonicalizeUpstream({ publicKey: "abc" });
		const b = canonicalizeUpstream({ publicKey: "xyz" });
		expect(a).not.toBe(b);
	});

	test("nested arrays of objects redact credentials", () => {
		const a = canonicalizeUpstream({ deployments: [{ name: "prod", apiKey: "key-1" }] });
		const b = canonicalizeUpstream({ deployments: [{ name: "prod", apiKey: "key-2" }] });
		expect(a).toBe(b);
	});

	test("nested non-credential fields are preserved in fingerprint", () => {
		// Regression guard: the previous JSON.stringify(value, topKeys.sort())
		// implementation silently dropped any nested key not present at the top
		// level, including non-credential fields like `host` and `env`. The
		// recursive sortKeysDeep approach must preserve them.
		const prod = canonicalizeUpstream({ deployments: [{ host: "prod.es", env: "prod" }] });
		const staging = canonicalizeUpstream({ deployments: [{ host: "staging.es", env: "staging" }] });
		expect(prod).not.toBe(staging);
	});

	test("deeply nested field order independence", () => {
		// The recursive sort must apply at every depth, not just the top.
		const a = canonicalizeUpstream({ deployments: [{ host: "x", env: "prod" }] });
		const b = canonicalizeUpstream({ deployments: [{ env: "prod", host: "x" }] });
		expect(a).toBe(b);
	});
});

describe("buildIdentityCard", () => {
	test("instanceId rotates on each call", () => {
		const a = buildIdentityCard({ role: "elastic-mcp", version: "0.1.0", mode: "http", upstreamFingerprint: "abc" });
		const b = buildIdentityCard({ role: "elastic-mcp", version: "0.1.0", mode: "http", upstreamFingerprint: "abc" });
		expect(a.instanceId).not.toBe(b.instanceId);
		expect(a.instanceId).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("captures pid and bootedAt", () => {
		const card = buildIdentityCard({ role: "kafka-mcp", version: "0.2.0", mode: "http", upstreamFingerprint: "def" });
		expect(card.pid).toBe(process.pid);
		expect(card.bootedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(card.role).toBe("kafka-mcp");
		expect(card.version).toBe("0.2.0");
	});
});
