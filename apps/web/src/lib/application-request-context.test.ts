// apps/web/src/lib/application-request-context.test.ts

import { describe, expect, test } from "bun:test";
import { contextualRequestFields } from "./application-request-context.ts";

const foreignContext = {
	dataSources: ["aws", "elastic"],
	targetDeployments: ["elastic-production"],
	uiAwsEstates: ["incident-estate"],
	isFollowUp: true as const,
	dataSourceContext: { type: "EXPLICIT" as const, dataSources: ["aws"], scope: "subset" as const },
};

describe("contextualRequestFields", () => {
	test("removes foreign application context from Landing Zone requests", () => {
		expect(contextualRequestFields("landing-zone-terraform", foreignContext)).toEqual({});
	});

	test("preserves the existing Incident Analyzer request context", () => {
		expect(contextualRequestFields("incident-analyzer", foreignContext)).toEqual(foreignContext);
	});

	test("preserves the existing Elastic IaC request context", () => {
		expect(contextualRequestFields("elastic-iac", foreignContext)).toEqual(foreignContext);
	});
});
