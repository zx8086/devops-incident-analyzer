// tests/checks-targets-severity.test.ts
//
// SIO-1752. Driven by the real target groups that exposed the bug: live pods
// answering health checks with the wrong status code, served normally because
// the load balancer fails open, which the old rule paged as critical.
import { describe, expect, test } from "bun:test";
import { assessTargetGroup, MISMATCH_REASON, mismatchCodes } from "../scripts/monitor/checks/targets.ts";
import { ELBV2_FAIL_OPEN_MISCONFIGURED } from "./aws-samples.ts";

describe("targets severity follows the reason code", () => {
	// The whole point of the change: every real group here has zero healthy
	// targets, and every one is serving traffic.
	test("each real fail-open group with zero healthy is warn and misconfigured, never critical", () => {
		for (const g of ELBV2_FAIL_OPEN_MISCONFIGURED) {
			expect({ group: g.group, ...assessTargetGroup(0, g.targets) }).toEqual({
				group: g.group,
				severity: "warn",
				misconfigured: true,
			});
		}
	});

	test("the finding can name the status code the check actually got", () => {
		const byGroup = Object.fromEntries(ELBV2_FAIL_OPEN_MISCONFIGURED.map((g) => [g.group, mismatchCodes(g.targets)]));
		expect(byGroup["k8s-monitori-promethe-f053e498da"]).toEqual(["302"]);
		expect(byGroup["k8s-commerce-prdenvli-412a380e5a"]).toEqual(["404"]);
		expect(byGroup["k8s-commerce-prdenvto-fb1169b50f"]).toEqual(["403"]);
	});

	// Fail-open routing to targets that cannot answer is the real outage: 502s.
	test("zero healthy targets that are not answering is critical", () => {
		for (const reason of ["Target.Timeout", "Target.FailedHealthChecks"]) {
			expect({ reason, ...assessTargetGroup(0, [{ reason }]) }).toEqual({
				reason,
				severity: "critical",
				misconfigured: false,
			});
		}
	});

	// One target that cannot answer is enough: fail-open sends it traffic too.
	test("a single non-answering target among mismatches keeps zero healthy critical", () => {
		expect(
			assessTargetGroup(0, [{ reason: MISMATCH_REASON }, { reason: MISMATCH_REASON }, { reason: "Target.Timeout" }]),
		).toEqual({
			severity: "critical",
			misconfigured: false,
		});
	});

	// The rating is never downgraded without evidence the target responded.
	test("an absent reason is treated as not answering", () => {
		expect(assessTargetGroup(0, [{ reason: null }])).toEqual({ severity: "critical", misconfigured: false });
		expect(assessTargetGroup(0, [{ reason: MISMATCH_REASON }, { reason: null }])).toEqual({
			severity: "critical",
			misconfigured: false,
		});
	});

	test("with some healthy targets it is warn either way, flagged misconfigured only on mismatch", () => {
		expect(assessTargetGroup(2, [{ reason: MISMATCH_REASON }])).toEqual({ severity: "warn", misconfigured: true });
		expect(assessTargetGroup(2, [{ reason: "Target.Timeout" }])).toEqual({ severity: "warn", misconfigured: false });
	});

	test("descriptions without a codes list yield no codes rather than garbage", () => {
		expect(mismatchCodes([{ description: "Request timed out" }, { description: null }])).toEqual([]);
	});
});
