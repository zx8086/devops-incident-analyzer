// packages/agent/src/landing-zone/knowledge-selector.test.ts

import { describe, expect, test } from "bun:test";
import { selectLandingZoneKnowledge } from "./knowledge-selector.ts";

describe("selectLandingZoneKnowledge", () => {
	const cases = [
		["account vending", "aws-lz-account-creator"],
		["Cloud WAN core network", "aws-lz-network-core"],
		["workload VPC and subnets", "aws-lz-network-workloads"],
		["GitLab project", "dhco-gitlab-terraform"],
		["dedicated runners", "gitlab-k8s-runners-lzv2"],
	] as const;

	for (const [topic, repository] of cases) {
		test(`routes ${topic}`, () => {
			const selection = selectLandingZoneKnowledge("understand", null, [topic]);
			expect(selection.repositories).toEqual([repository]);
			expect(selection.entries).toContain(`repos/${repository}.md`);
			expect(selection.entries).toContain("conventions/evidence-validation.md");
		});
	}

	test("adds shared and Terraform guidance for module review", () => {
		const selection = selectLandingZoneKnowledge("review", "aws-lz-storage", ["review Terraform module"]);
		expect(selection.entries).toContain("repos/aws-lz-storage.md");
		expect(selection.entries).toContain("shared/unpinned-refs.md");
		expect(selection.entries).toContain("terraform/source-catalog.md");
	});

	test("adds backend safety without guessing a repository", () => {
		const selection = selectLandingZoneKnowledge("learn", null, ["backend state locking"]);
		expect(selection.repositories).toEqual([]);
		expect(selection.entries).toContain("conventions/evidence-validation.md");
		expect(selection.entries).toContain("terraform/source-catalog.md");
	});

	test("adds AWS guidance when the topic needs it", () => {
		const selection = selectLandingZoneKnowledge("learn", null, ["AWS IAM best practice"]);
		expect(selection.entries).toContain("aws/source-catalog.md");
	});

	test("preserves an explicitly scoped unknown repository without loading unrelated concepts", () => {
		const selection = selectLandingZoneKnowledge("review", "future-lz-component", ["review configuration"]);
		expect(selection.repositories).toEqual(["future-lz-component"]);
		expect(selection.entries).not.toContain("repos/future-lz-component.md");
		expect(selection.entries).toContain("unresolved-gaps/08-uncovered-domains.md");
		expect(selection.entries.some((entry) => entry.includes("account-creator"))).toBeFalse();
	});
});
