// src/config.test.ts
import { describe, expect, test } from "bun:test";
import { ClusterDeploymentSchema } from "./config.ts";

describe("ClusterDeploymentSchema auth exclusivity", () => {
	const base = { id: "eu-b2b", url: "https://cld.example:9243" };
	const ok = (d: Record<string, unknown>) => ClusterDeploymentSchema.safeParse(d).success;

	test("accepts apiKey only, username+password, or neither", () => {
		expect(ok({ ...base, apiKey: "k" })).toBe(true);
		expect(ok({ ...base, username: "u", password: "p" })).toBe(true);
		expect(ok({ ...base })).toBe(true);
	});

	test("rejects a lone username or password", () => {
		expect(ok({ ...base, username: "u" })).toBe(false);
		expect(ok({ ...base, password: "p" })).toBe(false);
	});

	test("rejects mixing apiKey with basic auth (resolveCluster would silently ignore it)", () => {
		expect(ok({ ...base, apiKey: "k", username: "u", password: "p" })).toBe(false);
		expect(ok({ ...base, apiKey: "k", username: "u" })).toBe(false);
	});
});
