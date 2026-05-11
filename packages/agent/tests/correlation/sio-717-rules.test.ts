// packages/agent/tests/correlation/sio-717-rules.test.ts
//
// SIO-717: three new correlation rules for the kafka sub-agent:
//   1. ksqldb-unresponsive-task           — fires on UNRESPONSIVE+statusCount in prose
//   2. connect-service-unavailable        — fires on 5xx from a connect_* tool
//   3. infra-service-degraded-needs-synthetic-cross-check — fires on any
//      Confluent service 5xx with a recognisable *.shared-services.eu.pvh.cloud
//      hostname; demands an Elastic synthetic cross-check.
//
// These rules feed the existing enforce-correlations engine; tests here verify
// the trigger predicates fire on the expected inputs and stay silent otherwise.

import { describe, expect, test } from "bun:test";
import type { ToolError } from "@devops-agent/shared";
import { correlationRules } from "../../src/correlation/rules";
import { baseState, withKafkaProseResult } from "./test-helpers";

const findRule = (name: string) => {
	const rule = correlationRules.find((r) => r.name === name);
	if (!rule) throw new Error(`rule not found: ${name}`);
	return rule;
};

const ksqlDB503Error = (toolName: string, hostname = "ksql.dev.shared-services.eu.pvh.cloud"): ToolError => ({
	toolName,
	category: "transient",
	retryable: true,
	message: `MCP error -32603: ksqlDB error 503: <html><body>503 Service Temporarily Unavailable</body></html> (target=${hostname})`,
});

const connect503Error = (toolName: string, hostname = "connect.prd.shared-services.eu.pvh.cloud"): ToolError => ({
	toolName,
	category: "transient",
	retryable: true,
	message: `MCP error -32603: Kafka Connect error 503: 503 Service Temporarily Unavailable (target=${hostname})`,
});

const schemaRegistry503Error = (
	toolName: string,
	hostname = "schemaregistry.prd.shared-services.eu.pvh.cloud",
): ToolError => ({
	toolName,
	category: "transient",
	retryable: true,
	message: `MCP error -32603: Schema Registry error 503: nginx (target=${hostname})`,
});

const transientNon5xxError = (toolName: string): ToolError => ({
	toolName,
	category: "transient",
	retryable: true,
	message: "MCP error -32603: socket hang up",
});

// ---------------------------------------------------------------------------
// Rule 1: ksqldb-unresponsive-task
// ---------------------------------------------------------------------------

describe("ksqldb-unresponsive-task", () => {
	const rule = findRule("ksqldb-unresponsive-task");

	test("fires when kafka prose contains UNRESPONSIVE and statusCount", () => {
		const prose =
			'All 29 ksqlDB persistent queries report statusCount: {"RUNNING": 1, "UNRESPONSIVE": 1} - one cluster host is unresponsive';
		const state = withKafkaProseResult(baseState(), prose);
		const match = rule.trigger(state);
		expect(match).not.toBeNull();
		expect((match?.context as { signal: string }).signal).toBe("ksqldb-unresponsive");
	});

	test("does not fire when only UNRESPONSIVE appears without statusCount", () => {
		const state = withKafkaProseResult(baseState(), "The host became UNRESPONSIVE briefly but recovered");
		expect(rule.trigger(state)).toBeNull();
	});

	test("does not fire when only statusCount appears without UNRESPONSIVE", () => {
		const state = withKafkaProseResult(baseState(), 'All queries report statusCount: {"RUNNING": 2}');
		expect(rule.trigger(state)).toBeNull();
	});

	test("does not fire when there is no kafka result", () => {
		expect(rule.trigger(baseState())).toBeNull();
	});

	test("requires elastic-agent for the correlation", () => {
		expect(rule.requiredAgent).toBe("elastic-agent");
	});
});

// ---------------------------------------------------------------------------
// Rule 2: connect-service-unavailable
// ---------------------------------------------------------------------------

describe("connect-service-unavailable", () => {
	const rule = findRule("connect-service-unavailable");

	test("fires when a connect_* tool returns a 5xx", () => {
		const state = withKafkaProseResult(baseState(), "kafka connect unreachable", [
			connect503Error("connect_list_connectors"),
		]);
		const match = rule.trigger(state);
		expect(match).not.toBeNull();
		const ctx = match?.context as { tools: string[]; hostname: string | null };
		expect(ctx.tools).toEqual(["connect_list_connectors"]);
		expect(ctx.hostname).toBe("connect.prd.shared-services.eu.pvh.cloud");
	});

	test("does not fire when only ksql_* tools are erroring", () => {
		const state = withKafkaProseResult(baseState(), "ksqldb down", [ksqlDB503Error("ksql_get_server_info")]);
		expect(rule.trigger(state)).toBeNull();
	});

	test("does not fire on non-5xx transient connect errors", () => {
		const state = withKafkaProseResult(baseState(), "transient", [transientNon5xxError("connect_list_connectors")]);
		expect(rule.trigger(state)).toBeNull();
	});

	test("does not fire when toolErrors is empty", () => {
		const state = withKafkaProseResult(baseState(), "all good");
		expect(rule.trigger(state)).toBeNull();
	});

	test("requires elastic-agent for the correlation", () => {
		expect(rule.requiredAgent).toBe("elastic-agent");
	});
});

// ---------------------------------------------------------------------------
// Rule 3: infra-service-degraded-needs-synthetic-cross-check
// ---------------------------------------------------------------------------

describe("infra-service-degraded-needs-synthetic-cross-check", () => {
	const rule = findRule("infra-service-degraded-needs-synthetic-cross-check");

	test("fires on ksqlDB 5xx with shared-services.eu.pvh.cloud hostname", () => {
		const state = withKafkaProseResult(baseState(), "ksqldb 503", [
			ksqlDB503Error("ksql_get_server_info", "ksql.dev.shared-services.eu.pvh.cloud"),
		]);
		const match = rule.trigger(state);
		expect(match).not.toBeNull();
		const ctx = match?.context as { hostnames: string[]; signal: string };
		expect(ctx.hostnames).toEqual(["ksql.dev.shared-services.eu.pvh.cloud"]);
		expect(ctx.signal).toBe("confluent-5xx-needs-synthetic-crosscheck");
	});

	test("collects multiple distinct hostnames when several services 5xx together (the c72 scenario)", () => {
		const state = withKafkaProseResult(baseState(), "all confluent 503", [
			ksqlDB503Error("ksql_get_server_info", "ksql.dev.shared-services.eu.pvh.cloud"),
			connect503Error("connect_list_connectors", "connect.dev.shared-services.eu.pvh.cloud"),
			schemaRegistry503Error("kafka_list_schemas", "schemaregistry.dev.shared-services.eu.pvh.cloud"),
		]);
		const match = rule.trigger(state);
		expect(match).not.toBeNull();
		const ctx = match?.context as { hostnames: string[] };
		expect(ctx.hostnames.sort()).toEqual([
			"connect.dev.shared-services.eu.pvh.cloud",
			"ksql.dev.shared-services.eu.pvh.cloud",
			"schemaregistry.dev.shared-services.eu.pvh.cloud",
		]);
	});

	test("dedups when the same hostname appears in multiple tool errors", () => {
		const state = withKafkaProseResult(baseState(), "ksql double", [
			ksqlDB503Error("ksql_get_server_info", "ksql.prd.shared-services.eu.pvh.cloud"),
			ksqlDB503Error("ksql_list_queries", "ksql.prd.shared-services.eu.pvh.cloud"),
		]);
		const match = rule.trigger(state);
		expect(match).not.toBeNull();
		const ctx = match?.context as { hostnames: string[] };
		expect(ctx.hostnames).toEqual(["ksql.prd.shared-services.eu.pvh.cloud"]);
	});

	test("does not fire when 5xx body contains no recognisable Confluent hostname", () => {
		const orphanError: ToolError = {
			toolName: "ksql_get_server_info",
			category: "transient",
			retryable: true,
			message: "MCP error -32603: ksqlDB error 503: <html>503</html>",
		};
		const state = withKafkaProseResult(baseState(), "orphan 503", [orphanError]);
		expect(rule.trigger(state)).toBeNull();
	});

	test("does not fire on non-5xx errors even from Confluent tools", () => {
		const state = withKafkaProseResult(baseState(), "transient", [transientNon5xxError("ksql_list_queries")]);
		expect(rule.trigger(state)).toBeNull();
	});

	test("does not fire when there is no kafka result at all", () => {
		expect(rule.trigger(baseState())).toBeNull();
	});

	test("requires elastic-agent so the synthetic cross-check can run", () => {
		expect(rule.requiredAgent).toBe("elastic-agent");
	});
});

// ---------------------------------------------------------------------------
// Rule 4 (SIO-723): inferred-confluent-groups-need-disclaimer
// ---------------------------------------------------------------------------

describe("inferred-confluent-groups-need-disclaimer", () => {
	const rule = findRule("inferred-confluent-groups-need-disclaimer");

	const connectGroupProse =
		"21 Kafka Connect connectors are halted: connect-C_SINK_COUCHBASE_PRICES_DOCUMENTS, connect-C_SINK_COUCHBASE_PRODUCTS_V3, connect-C_SINK_COUCHBASE_VARIANTS_V3";
	const ksqlGroupProse =
		"22 ksqlDB queries halted: _confluent-ksql-default_query_CSAS_S_PRIVATE_SINK_PIM_ARTICLES_V3_36751 (EMPTY)";
	const disclaimerProse =
		" These names are inferred from MSK offset state and current deployment cannot be confirmed while Connect REST is 503.";

	test("fires when connect_* 5xx AND connect-* group is named in prose without a disclaimer", () => {
		const state = withKafkaProseResult(baseState(), connectGroupProse, [connect503Error("connect_list_connectors")]);
		const match = rule.trigger(state);
		expect(match).not.toBeNull();
		const ctx = match?.context as { signal: string; connect: boolean; ksql: boolean };
		expect(ctx.signal).toBe("inferred-groups-without-disclaimer");
		expect(ctx.connect).toBe(true);
		expect(ctx.ksql).toBe(false);
	});

	test("does NOT fire when connect_* 5xx AND connect-* in prose BUT disclaimer is present", () => {
		const state = withKafkaProseResult(baseState(), connectGroupProse + disclaimerProse, [
			connect503Error("connect_list_connectors"),
		]);
		expect(rule.trigger(state)).toBeNull();
	});

	test("does NOT fire when no connect_* 5xx, even if connect-* group is named (no inference being made)", () => {
		const state = withKafkaProseResult(baseState(), connectGroupProse);
		expect(rule.trigger(state)).toBeNull();
	});

	test("fires when ksql_* 5xx AND _confluent-ksql-default_query_* is named in prose without a disclaimer", () => {
		const state = withKafkaProseResult(baseState(), ksqlGroupProse, [ksqlDB503Error("ksql_list_queries")]);
		const match = rule.trigger(state);
		expect(match).not.toBeNull();
		const ctx = match?.context as { ksql: boolean; connect: boolean };
		expect(ctx.ksql).toBe(true);
		expect(ctx.connect).toBe(false);
	});

	test("does NOT fire when ksql_* 5xx AND _confluent-ksql-default_query_* in prose BUT disclaimer is present", () => {
		const state = withKafkaProseResult(baseState(), ksqlGroupProse + disclaimerProse, [
			ksqlDB503Error("ksql_list_queries"),
		]);
		expect(rule.trigger(state)).toBeNull();
	});

	test("does NOT fire when ksql_* 5xx but prose names no inferred groups", () => {
		const state = withKafkaProseResult(baseState(), "ksqlDB cluster unreachable; will retry on recovery.", [
			ksqlDB503Error("ksql_get_server_info"),
		]);
		expect(rule.trigger(state)).toBeNull();
	});

	test("fires once for the c72 scenario where BOTH connect and ksql are 5xx and both group families appear", () => {
		const state = withKafkaProseResult(baseState(), `${connectGroupProse} ${ksqlGroupProse}`, [
			connect503Error("connect_list_connectors"),
			ksqlDB503Error("ksql_list_queries"),
		]);
		const match = rule.trigger(state);
		expect(match).not.toBeNull();
		const ctx = match?.context as { connect: boolean; ksql: boolean };
		expect(ctx.connect).toBe(true);
		expect(ctx.ksql).toBe(true);
	});

	test("any disclaimer keyword satisfies the rule (cannot confirm)", () => {
		const state = withKafkaProseResult(
			baseState(),
			`${connectGroupProse} We cannot confirm these are live deployments.`,
			[connect503Error("connect_list_connectors")],
		);
		expect(rule.trigger(state)).toBeNull();
	});

	test("requires kafka-agent (no other agent can resolve this; the cap is the purpose)", () => {
		expect(rule.requiredAgent).toBe("kafka-agent");
	});

	test("uses skipCoverageCheck: true (mirrors gitlab-deploy-vs-datastore-runtime)", () => {
		expect(rule.skipCoverageCheck).toBe(true);
	});

	test("does not fire when there is no kafka result at all", () => {
		expect(rule.trigger(baseState())).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Integration: rule loadout verifies registration count
// ---------------------------------------------------------------------------

describe("rule registration", () => {
	test("all three SIO-717 rules are registered in correlationRules", () => {
		const names = correlationRules.map((r) => r.name);
		expect(names).toContain("ksqldb-unresponsive-task");
		expect(names).toContain("connect-service-unavailable");
		expect(names).toContain("infra-service-degraded-needs-synthetic-cross-check");
	});

	test("none of the SIO-717 rules use skipCoverageCheck (they all want idempotency)", () => {
		for (const name of [
			"ksqldb-unresponsive-task",
			"connect-service-unavailable",
			"infra-service-degraded-needs-synthetic-cross-check",
		]) {
			const rule = findRule(name);
			expect(rule.skipCoverageCheck).toBeFalsy();
		}
	});

	test("the SIO-723 rule is registered", () => {
		expect(correlationRules.map((r) => r.name)).toContain("inferred-confluent-groups-need-disclaimer");
	});
});
