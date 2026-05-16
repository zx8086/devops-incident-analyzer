// packages/agent/src/correlation/engine.test.ts
import { describe, expect, test } from "bun:test";
import { agentToDataSourceId } from "./engine.ts";

describe("agentToDataSourceId", () => {
	test("elastic-agent maps to elastic", () => {
		expect(agentToDataSourceId("elastic-agent")).toBe("elastic");
	});

	test("kafka-agent maps to kafka", () => {
		expect(agentToDataSourceId("kafka-agent")).toBe("kafka");
	});

	// SIO-763: the bug we're fixing — capella-agent's datasource id is "couchbase", not "capella"
	test("capella-agent maps to couchbase", () => {
		expect(agentToDataSourceId("capella-agent")).toBe("couchbase");
	});

	test("konnect-agent maps to konnect", () => {
		expect(agentToDataSourceId("konnect-agent")).toBe("konnect");
	});

	test("gitlab-agent maps to gitlab", () => {
		expect(agentToDataSourceId("gitlab-agent")).toBe("gitlab");
	});

	test("atlassian-agent maps to atlassian", () => {
		expect(agentToDataSourceId("atlassian-agent")).toBe("atlassian");
	});

	test("aws-agent maps to aws", () => {
		expect(agentToDataSourceId("aws-agent")).toBe("aws");
	});

	test("unknown agent falls back to -agent suffix strip", () => {
		expect(agentToDataSourceId("future-agent")).toBe("future");
	});
});
