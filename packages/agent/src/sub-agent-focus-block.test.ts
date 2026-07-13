// packages/agent/src/sub-agent-focus-block.test.ts
//
// SIO-1079: the AWS sub-agent anchored CloudWatch query windows with no "now" reference,
// producing MalformedQueryException. buildFocusBlock now always injects a current-time
// anchor so the LLM can convert ISO/relative windows to correct epoch seconds.

import { describe, expect, test } from "bun:test";
import type { InvestigationFocus, ResolvedIdentifiers } from "@devops-agent/shared";
import { buildFocusBlock } from "./sub-agent-focus-block.ts";

const NOW = "2026-07-12T05:18:00.000Z";

const FOCUS: InvestigationFocus = {
	services: ["order-service"],
	datasources: ["elastic", "couchbase", "aws"],
	summary: "AFS season code lookup failing",
	establishedAtTurn: 1,
};

describe("buildFocusBlock current-time anchor (SIO-1091)", () => {
	test("always includes the current-time line, even with no focus", () => {
		const block = buildFocusBlock(undefined, NOW);
		expect(block).toContain(`Current time: ${NOW}`);
	});

	test("SIO-1091: no longer asserts a year or forbids year-shifting (window is relative now)", () => {
		const block = buildFocusBlock(undefined, NOW).toLowerCase();
		// The absolute-epoch harness is gone; the block must not carry the old imperatives.
		expect(block).not.toContain("the current year is");
		expect(block).not.toContain("epoch");
		expect(block).not.toMatch(/never (shift|adjust|correct|reinterpret)/);
	});

	test("current-time line tracks nowIso (not hardcoded)", () => {
		const block2027 = buildFocusBlock(undefined, "2027-01-02T00:00:00.000Z");
		expect(block2027).toContain("Current time: 2027-01-02T00:00:00.000Z");
	});

	test("includes both the time anchor and the focus when focus is present", () => {
		const focus: InvestigationFocus = {
			services: ["localcore-service"],
			datasources: ["aws"],
			timeWindow: { from: "2026-07-11T22:00:00Z", to: "2026-07-12T00:00:00Z" },
			summary: "SoldTo fetch failures",
			establishedAtTurn: 1,
		};
		const block = buildFocusBlock(focus, NOW);
		expect(block).toContain(`Current time: ${NOW}`);
		expect(block).toContain("INVESTIGATION FOCUS");
		expect(block).toContain("localcore-service");
		expect(block).toContain("2026-07-11T22:00:00Z to 2026-07-12T00:00:00Z");
	});

	test("focus preserved with (none) placeholders when fields are empty", () => {
		const focus: InvestigationFocus = {
			services: [],
			datasources: [],
			summary: "generic",
			establishedAtTurn: 2,
		};
		const block = buildFocusBlock(focus, NOW);
		expect(block).toContain("Anchored services: (none)");
		expect(block).toContain("Anchored time window: (none)");
		expect(block).toContain(`Current time: ${NOW}`);
	});
});

describe("SIO-1084 A4: name-resolution is in scope (softened directive)", () => {
	test("permits enumeration/discovery while forbidding unrelated services", () => {
		const block = buildFocusBlock(FOCUS, NOW).toLowerCase();
		expect(block).toContain("resolving an anchored service's real identifier is in scope");
		expect(block).toContain("enumerate");
		// still forbids unrelated services
		expect(block).toContain("do not investigate unrelated services");
	});
});

describe("SIO-1084 B5: resolved-identifiers injection", () => {
	const RESOLVED: ResolvedIdentifiers = {
		resolvedForTurn: 1,
		resolvedForServices: ["order-service"],
		elastic: { serviceNames: ["pvh-services-orders", "orders"] },
		couchbase: { scopes: { orders: ["orders", "order_lines"], inventory: ["stock"] } },
		aws: { logGroups: ["/ecs/order-service"], ecsServices: ["eu-oit-prd-order-service"] },
	};

	test("renders ONLY the current datasource's block (elastic)", () => {
		const block = buildFocusBlock(FOCUS, NOW, RESOLVED, "elastic");
		expect(block).toContain("RESOLVED IDENTIFIERS");
		expect(block).toContain("pvh-services-orders");
		// does NOT leak couchbase/aws sections into the elastic prompt
		expect(block).not.toContain("scopes -> collections");
		expect(block).not.toContain("/ecs/order-service");
	});

	test("elastic resolved block instructs a broad multi_match, not an error-logs pin", () => {
		const block = buildFocusBlock(
			FOCUS,
			NOW,
			{
				resolvedForTurn: 1,
				resolvedForServices: FOCUS.services,
				elastic: { serviceNames: ["pvh-services-orders", "orders"] },
			},
			"elastic",
		);
		expect(block).toContain("pvh-services-orders");
		expect(block).toContain("logs-*,logs-apm.*");
		expect(block).toContain("multi_match");
		expect(block).toContain("message");
		expect(block).toContain("error.exception.message");
		expect(block).toContain("body.text");
		expect(block).toContain("now-30d");
		// SIO-1090 (CodeRabbit): assert the FULL broad-query contract, not just that the
		// field/index words appear -- a bare word-presence check can pass on unrelated prose.
		expect(block).toContain("multi_match` (`type: phrase`)"); // phrase match, not analyzed match
		expect(block).toContain("track_total_hits: true"); // exact count
		expect(block).toContain("terms` filter"); // one terms filter over all candidate names
		expect(block).toContain("do NOT run per-name permutations"); // no query-per-name
		// The old error-logs-only pin ("Query APM errors in index logs-apm.error-*") must be
		// gone -- the block may still mention logs-apm.error-* inside the negative instruction
		// ("Do NOT pin to logs-apm.error-* only"), so assert on the retired imperative phrasing
		// rather than the bare index-pattern substring.
		expect(block).not.toContain("Query APM errors in index logs-apm.error-*");
	});

	test("couchbase block includes the scope->collection map and collection-only FROM instruction", () => {
		const block = buildFocusBlock(FOCUS, NOW, RESOLVED, "couchbase");
		expect(block).toContain("orders: [orders, order_lines]");
		expect(block).toContain("inventory: [stock]");
		expect(block.toLowerCase()).toContain("collection-only from");
		expect(block).not.toContain("pvh-services-orders");
	});

	test("aws block lists log groups and ecs services", () => {
		const block = buildFocusBlock(FOCUS, NOW, RESOLVED, "aws");
		expect(block).toContain("/ecs/order-service");
		expect(block).toContain("eu-oit-prd-order-service");
	});

	test("suppressed when the stamp does not match the current focus.services", () => {
		const stale: ResolvedIdentifiers = { ...RESOLVED, resolvedForServices: ["payments-service"] };
		const block = buildFocusBlock(FOCUS, NOW, stale, "elastic");
		expect(block).not.toContain("RESOLVED IDENTIFIERS");
	});

	test("stamp match is case-insensitive and order-independent", () => {
		const focusTwo: InvestigationFocus = { ...FOCUS, services: ["Order-Service", "Payments"] };
		const resolvedTwo: ResolvedIdentifiers = {
			...RESOLVED,
			resolvedForServices: ["payments", "order-service"],
		};
		const block = buildFocusBlock(focusTwo, NOW, resolvedTwo, "elastic");
		expect(block).toContain("RESOLVED IDENTIFIERS");
	});

	test("a case-duplicate does NOT falsely match a different-sized set (SIO-1084 finder)", () => {
		// focus=[order-service,payments]; resolved=[orders,ORDERS] -- same length, but
		// genuinely different sets. The set-equality fix must suppress the block.
		const focusTwo: InvestigationFocus = { ...FOCUS, services: ["order-service", "payments"] };
		const resolvedDup: ResolvedIdentifiers = { ...RESOLVED, resolvedForServices: ["orders", "ORDERS"] };
		const block = buildFocusBlock(focusTwo, NOW, resolvedDup, "elastic");
		expect(block).not.toContain("RESOLVED IDENTIFIERS");
	});

	test("no resolved arg == identical to pre-change output (regression guard)", () => {
		expect(buildFocusBlock(FOCUS, NOW)).toBe(buildFocusBlock(FOCUS, NOW, undefined, "elastic"));
	});

	test("a datasource with no resolved entry renders no RESOLVED section", () => {
		const block = buildFocusBlock(FOCUS, NOW, RESOLVED, "gitlab");
		expect(block).not.toContain("RESOLVED IDENTIFIERS");
	});
});
