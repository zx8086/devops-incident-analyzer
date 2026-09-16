// tests/checks-phase3.test.ts
//
// SIO-1750, driven by production output captured before the IAM was requested.
import { describe, expect, test } from "bun:test";
import { classifyVolume } from "../scripts/monitor/checks/drift.ts";
import { severityForNodegroup } from "../scripts/monitor/checks/nodegroups.ts";
import { severityForAdvisorStatus } from "../scripts/monitor/checks/quotas.ts";
import {
	BACKUP_JOBS_OBSERVED,
	EBS_VOLUME_STATUSES_OBSERVED,
	EKS_CLUSTER_HAS_HEALTH_FIELD,
	EKS_NODEGROUP_HEALTHY,
	SYNTHETICS_CANARIES_OBSERVED,
	TRUSTED_ADVISOR_SERVICE_LIMIT_CHECKS,
	TRUSTED_ADVISOR_STATUSES_OBSERVED,
} from "./aws-samples.ts";

describe("EKS nodegroup severity", () => {
	// The real healthy nodegroup, which must stay silent.
	test("the real ACTIVE nodegroup with an empty issues list raises nothing", () => {
		expect(severityForNodegroup(EKS_NODEGROUP_HEALTHY.status, EKS_NODEGROUP_HEALTHY.health.issues.length)).toBeNull();
	});

	test("a failed or degraded status is critical whatever the issue count", () => {
		for (const status of ["DEGRADED", "CREATE_FAILED", "DELETE_FAILED"]) {
			expect({ status, sev: severityForNodegroup(status, 0) }).toEqual({ status, sev: "critical" });
		}
	});

	// EKS diagnosing a problem while the group still serves: worth knowing, not
	// worth paging.
	test("issues without a failed status are warn", () => {
		expect(severityForNodegroup("ACTIVE", 2)).toBe("warn");
	});

	test("transitional states with no issues stay silent", () => {
		for (const status of ["CREATING", "UPDATING", "DELETING", "ACTIVE"]) {
			expect({ status, sev: severityForNodegroup(status, 0) }).toEqual({ status, sev: null });
		}
	});

	test("the check reads the nodegroup because the cluster carries no health", () => {
		expect(EKS_CLUSTER_HAS_HEALTH_FIELD).toBe(false);
	});
});

describe("Trusted Advisor service limits", () => {
	test("AWS's own verdict is the discriminator: error is critical, warning is warn", () => {
		expect(severityForAdvisorStatus("error")).toBe("critical");
		expect(severityForAdvisorStatus("warning")).toBe("warn");
	});

	// Every status the fleet actually returns must classify as nothing.
	test("every observed status raises nothing", () => {
		for (const status of TRUSTED_ADVISOR_STATUSES_OBSERVED) {
			expect({ status, sev: severityForAdvisorStatus(status) }).toEqual({ status, sev: null });
		}
	});

	test("not_available is not a failure", () => {
		expect(severityForAdvisorStatus("not_available")).toBeNull();
	});

	// The reason this replaced the Service Quotas design: one call, 52 answers.
	test("one call covers every service-limit check", () => {
		expect(TRUSTED_ADVISOR_SERVICE_LIMIT_CHECKS).toBeGreaterThan(50);
	});
});

describe("what was measured and deliberately not built", () => {
	test("EBS volumes are all ok, so the healthy shape must stay silent", () => {
		expect(EBS_VOLUME_STATUSES_OBSERVED).toEqual(["ok"]);
		for (const status of EBS_VOLUME_STATUSES_OBSERVED) {
			expect({ status, sev: classifyVolume(status, 0) }).toEqual({ status, sev: null });
		}
	});

	test("an impaired volume is warn; a pending AWS action on a healthy one is info", () => {
		expect(classifyVolume("impaired", 0)).toBe("warn");
		expect(classifyVolume("insufficient-data", 0)).toBe("warn");
		expect(classifyVolume("ok", 1)).toBe("info");
	});

	// Recorded so the estate-watch wishlist is not re-proposed from the spec.
	test("Backup and Synthetics were not granted because nothing uses them", () => {
		expect(BACKUP_JOBS_OBSERVED).toBe(0);
		expect(SYNTHETICS_CANARIES_OBSERVED).toBe(0);
	});
});
