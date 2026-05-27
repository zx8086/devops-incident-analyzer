// src/__tests__/estate-validator.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsConfig } from "../config/schemas.ts";
import { _resetEstateHealthForTests, getEstateHealth, validateEstates } from "../services/estate-validator.ts";

// aws-sdk-client-mock + STSClient cross a smithy@4.13/4.14 boundary in this
// workspace; the runtime mock works fine, only the type signature collides.
// Cast through unknown to keep biome's noExplicitAny rule happy.
const stsMock = mockClient(STSClient as unknown as Parameters<typeof mockClient>[0]);

afterEach(() => {
	stsMock.reset();
	_resetEstateHealthForTests();
});

function makeConfig(estateCount: number): AwsConfig {
	const estates: AwsConfig["estates"] = {};
	for (let i = 0; i < estateCount; i++) {
		const id = ["dev", "staging", "prod"][i] ?? `extra${i}`;
		estates[id] = {
			assumedRoleArn: `arn:aws:iam::${`${i}`.repeat(12)}:role/DevOpsAgentReadOnly`.replace(/0{12}/, "123456789012"),
			externalId: `id-${id}`,
		};
	}
	return { region: "eu-central-1", estates };
}

describe("validateEstates", () => {
	test("all estates OK returns all-ok results with assumedArn", async () => {
		stsMock.on(GetCallerIdentityCommand as never).resolves({
			Arn: "arn:aws:sts::123456789012:assumed-role/DevOpsAgentReadOnly/aws-mcp-server",
		} as never);

		const results = await validateEstates(makeConfig(3));
		expect(results).toHaveLength(3);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(results.every((r) => r.assumedArn?.includes("DevOpsAgentReadOnly"))).toBe(true);
	});

	test("mixed success surfaces each estate independently", async () => {
		// SDK-mock matches all clients; rejecting once-then-resolving is the cleanest
		// way to simulate "one estate fails". Order isn't strictly deterministic in
		// parallel, so assert on the aggregate: 1 failed, 2 ok.
		stsMock
			.on(GetCallerIdentityCommand as never)
			.rejectsOnce(new Error("AccessDenied: trust policy mismatch"))
			.resolves({ Arn: "arn:aws:sts::123456789012:assumed-role/DevOpsAgentReadOnly/aws-mcp-server" } as never);

		const results = await validateEstates(makeConfig(3));
		const failed = results.filter((r) => !r.ok);
		const ok = results.filter((r) => r.ok);
		expect(failed).toHaveLength(1);
		expect(ok).toHaveLength(2);
		expect(failed[0]?.error).toContain("AccessDenied");
	});

	test("all estates failing returns all-failed with errors", async () => {
		stsMock.on(GetCallerIdentityCommand as never).rejects(new Error("ExpiredToken: creds expired"));

		const results = await validateEstates(makeConfig(2));
		expect(results.every((r) => !r.ok)).toBe(true);
		expect(results.every((r) => r.error?.includes("ExpiredToken"))).toBe(true);
	});

	test("single estate works (boundary case)", async () => {
		stsMock.on(GetCallerIdentityCommand as never).resolves({
			Arn: "arn:aws:sts::123456789012:assumed-role/DevOpsAgentReadOnly/aws-mcp-server",
		} as never);

		const results = await validateEstates(makeConfig(1));
		expect(results).toHaveLength(1);
		expect(results[0]?.ok).toBe(true);
	});

	test("durationMs is populated for both success and failure", async () => {
		stsMock.on(GetCallerIdentityCommand as never).rejects(new Error("X"));

		const results = await validateEstates(makeConfig(1));
		expect(typeof results[0]?.durationMs).toBe("number");
		expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("validatedAt is an ISO timestamp on every result", async () => {
		stsMock.on(GetCallerIdentityCommand as never).resolves({
			Arn: "arn:aws:sts::123456789012:assumed-role/DevOpsAgentReadOnly/aws-mcp-server",
		} as never);

		const results = await validateEstates(makeConfig(2));
		for (const r of results) {
			expect(r.validatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		}
	});
});

describe("getEstateHealth (process-lifetime cache)", () => {
	test("returns empty array before any validateEstates call", () => {
		expect(getEstateHealth()).toEqual([]);
	});

	test("returns the latest validateEstates results", async () => {
		stsMock.on(GetCallerIdentityCommand as never).resolves({
			Arn: "arn:aws:sts::123456789012:assumed-role/DevOpsAgentReadOnly/aws-mcp-server",
		} as never);

		await validateEstates(makeConfig(2));
		const health = getEstateHealth();
		expect(health).toHaveLength(2);
		expect(health.every((r) => r.ok)).toBe(true);
	});

	test("a second validateEstates call overwrites the cache", async () => {
		stsMock.on(GetCallerIdentityCommand as never).resolves({
			Arn: "arn:aws:sts::123456789012:assumed-role/DevOpsAgentReadOnly/aws-mcp-server",
		} as never);

		await validateEstates(makeConfig(3));
		expect(getEstateHealth()).toHaveLength(3);

		stsMock.reset();
		stsMock.on(GetCallerIdentityCommand as never).rejects(new Error("X"));

		await validateEstates(makeConfig(1));
		const health = getEstateHealth();
		expect(health).toHaveLength(1);
		expect(health[0]?.ok).toBe(false);
	});
});
