// tests/checks-targets-severity.test.ts
//
// SIO-1752. Driven by the real target groups that exposed the fail-open bug --
// live pods answering health checks with the wrong status, served normally
// because the load balancer fails open -- and by a real 5xx health-check
// failure from the ECS corpus, which is the case that must stay critical.
import { describe, expect, test } from "bun:test";
import { assessTargetGroup, MISMATCH_REASON, mismatchCodes } from "../scripts/monitor/checks/targets.ts";
import { ECS_EVENTS_OBSERVED, ELBV2_FAIL_OPEN_MISCONFIGURED } from "./aws-samples.ts";

const mismatch = (code: string) => ({
	reason: MISMATCH_REASON,
	description: `Health checks failed with these codes: [${code}]`,
});
const notAnswering = (reason: string | null) => ({ reason, description: null });

describe("targets severity follows whether targets are working", () => {
	// Every real group here has zero healthy targets and every one is serving.
	test("each real fail-open group answering 3xx/4xx is warn and misconfigured, never critical", () => {
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

	// Answering is not working. A target that answers with a server error is
	// failing, and fail-open sends users to it.
	test("a 5xx mismatch with zero healthy is critical, not a misconfiguration", () => {
		for (const code of ["500", "502", "503", "504"]) {
			expect({ code, ...assessTargetGroup(0, [mismatch(code)]) }).toEqual({
				code,
				severity: "critical",
				misconfigured: false,
			});
		}
	});

	// The production evidence that 5xx health checks happen in this fleet.
	test("the real 503 health-check failure from the ECS corpus rates critical", () => {
		const real = ECS_EVENTS_OBSERVED.find((e) => e.message.includes("codes: [503]"));
		expect(real).toBeDefined();
		const description = (real?.message.match(/Health checks failed with these codes: \[[^\]]*\]/) ?? [""])[0];
		expect(assessTargetGroup(0, [{ reason: MISMATCH_REASON, description }])).toEqual({
			severity: "critical",
			misconfigured: false,
		});
	});

	// One server error among redirects is enough: fail-open reaches it too.
	test("a single 5xx among 3xx/4xx mismatches keeps zero healthy critical", () => {
		expect(assessTargetGroup(0, [mismatch("302"), mismatch("404"), mismatch("503")])).toEqual({
			severity: "critical",
			misconfigured: false,
		});
	});

	test("zero healthy targets that are not answering is critical", () => {
		for (const reason of ["Target.Timeout", "Target.FailedHealthChecks"]) {
			expect({ reason, ...assessTargetGroup(0, [notAnswering(reason)]) }).toEqual({
				reason,
				severity: "critical",
				misconfigured: false,
			});
		}
	});

	// Never downgraded without evidence: an absent reason, or a mismatch whose
	// codes cannot be read, proves nothing about whether the target works.
	test("an absent reason or unreadable codes are treated as not working", () => {
		expect(assessTargetGroup(0, [notAnswering(null)])).toEqual({ severity: "critical", misconfigured: false });
		expect(assessTargetGroup(0, [{ reason: MISMATCH_REASON, description: null }])).toEqual({
			severity: "critical",
			misconfigured: false,
		});
		expect(assessTargetGroup(0, [mismatch("302"), notAnswering(null)])).toEqual({
			severity: "critical",
			misconfigured: false,
		});
	});

	test("with some healthy targets it is warn either way, misconfigured only on a 3xx/4xx mismatch", () => {
		expect(assessTargetGroup(2, [mismatch("302")])).toEqual({ severity: "warn", misconfigured: true });
		expect(assessTargetGroup(2, [mismatch("503")])).toEqual({ severity: "warn", misconfigured: false });
		expect(assessTargetGroup(2, [notAnswering("Target.Timeout")])).toEqual({ severity: "warn", misconfigured: false });
	});

	test("descriptions without a codes list yield no codes rather than garbage", () => {
		expect(mismatchCodes([{ description: "Request timed out" }, { description: null }])).toEqual([]);
	});
});
