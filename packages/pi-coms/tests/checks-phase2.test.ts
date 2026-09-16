// tests/checks-phase2.test.ts
//
// SIO-1749, driven by production output captured before the code was written
// (tests/aws-samples.ts). No fake clients: the pure decision cores are
// exercised directly.
import { describe, expect, test } from "bun:test";
import { severityForCategories } from "../scripts/monitor/checks/db-events.ts";
import { classifyStackStatus } from "../scripts/monitor/checks/stacks.ts";
import {
	CFN_STACK_STATUSES_OBSERVED,
	ELASTICACHE_EVENT_FIELDS_OBSERVED,
	RDS_EVENT_CATEGORIES_OBSERVED,
	RDS_FILTERED_COUNT_OBSERVED,
	RDS_UNFILTERED_COUNT_OBSERVED,
} from "./aws-samples.ts";

describe("db-events severity, against real RDS categories", () => {
	test("failure and low storage are critical; failover and availability are warn", () => {
		expect(severityForCategories(["failure"])).toBe("critical");
		expect(severityForCategories(["low storage"])).toBe("critical");
		expect(severityForCategories(["failover"])).toBe("warn");
		expect(severityForCategories(["availability"])).toBe("warn");
	});

	test("a mixed event takes the highest severity present", () => {
		expect(severityForCategories(["failover", "failure"])).toBe("critical");
	});

	// The categories the fleet actually produces are backup and deletion, and
	// the server-side filter excludes both. This records why the check reads
	// nothing on a healthy account rather than everything.
	test("the categories production actually emits are not the ones requested", () => {
		for (const observed of RDS_EVENT_CATEGORIES_OBSERVED) {
			expect(["failure", "failover", "low storage", "availability"]).not.toContain(observed);
		}
		expect(RDS_UNFILTERED_COUNT_OBSERVED).toBeGreaterThan(0);
		expect(RDS_FILTERED_COUNT_OBSERVED).toBe(0);
	});

	test("ElastiCache carries no categories, which is why it is not read", () => {
		expect(ELASTICACHE_EVENT_FIELDS_OBSERVED).not.toContain("EventCategories");
	});
});

describe("stack status classification, against real CloudFormation output", () => {
	// The healthy case is the one that must stay silent, and it is every status
	// the fleet actually has.
	test("every status observed across 34 production stacks classifies as nothing", () => {
		for (const status of CFN_STACK_STATUSES_OBSERVED) {
			expect({ status, severity: classifyStackStatus(status) }).toEqual({ status, severity: null });
		}
	});

	test("a failed status is critical", () => {
		for (const status of [
			"CREATE_FAILED",
			"UPDATE_FAILED",
			"DELETE_FAILED",
			"UPDATE_ROLLBACK_FAILED",
			"ROLLBACK_FAILED",
		]) {
			expect({ status, severity: classifyStackStatus(status) }).toEqual({ status, severity: "critical" });
		}
	});

	test("a completed rollback is warn: the stack survived, the deployment did not", () => {
		for (const status of ["ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"]) {
			expect({ status, severity: classifyStackStatus(status) }).toEqual({ status, severity: "warn" });
		}
	});

	test("in-progress states are not failures", () => {
		for (const status of [
			"CREATE_IN_PROGRESS",
			"UPDATE_IN_PROGRESS",
			"UPDATE_ROLLBACK_IN_PROGRESS",
			"REVIEW_IN_PROGRESS",
		]) {
			expect({ status, severity: classifyStackStatus(status) }).toEqual({ status, severity: null });
		}
	});
});
