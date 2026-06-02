// agent/src/iac/resolve-deployment.test.ts
import { describe, expect, test } from "bun:test";
import { parseDeploymentId } from "./nodes.ts";

// callTool returns "[status] {json}"; parseDeploymentId strips the status prefix,
// then matches a human cluster name to its Elastic Cloud deployment id.
const LIST = `[200] ${JSON.stringify({
	deployments: [
		{ id: "abc123", name: "eu-b2b" },
		{ id: "def456", name: "eu-cld" },
	],
})}`;

describe("parseDeploymentId", () => {
	test("resolves an exact name match to its id", () => {
		expect(parseDeploymentId(LIST, "eu-b2b")).toBe("abc123");
		expect(parseDeploymentId(LIST, "eu-cld")).toBe("def456");
	});

	test("falls back to a case-insensitive match", () => {
		expect(parseDeploymentId(LIST, "EU-B2B")).toBe("abc123");
	});

	test("prefers an exact match over a case-insensitive one", () => {
		const mixed = `[200] ${JSON.stringify({
			deployments: [
				{ id: "lower", name: "prod" },
				{ id: "exact", name: "PROD" },
			],
		})}`;
		expect(parseDeploymentId(mixed, "PROD")).toBe("exact");
	});

	test("returns empty string when the name is not found", () => {
		expect(parseDeploymentId(LIST, "us-cld")).toBe("");
	});

	test("returns empty string for an empty cluster name", () => {
		expect(parseDeploymentId(LIST, "")).toBe("");
	});

	test("returns empty string on a malformed body (no json, bad json)", () => {
		expect(parseDeploymentId("[404] not found", "eu-b2b")).toBe("");
		expect(parseDeploymentId("[200] {not json", "eu-b2b")).toBe("");
	});
});
