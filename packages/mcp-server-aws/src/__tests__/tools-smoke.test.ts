// src/__tests__/tools-smoke.test.ts
// One smoke test per tool: each tool's Zod paramsSchema parses valid input and
// rejects obviously invalid input. New families are appended below.
import { describe, expect, test } from "bun:test";
import { describeInstancesSchema } from "../tools/ec2/describe-instances.ts";
import { describeSecurityGroupsSchema } from "../tools/ec2/describe-security-groups.ts";
import { describeVpcsSchema } from "../tools/ec2/describe-vpcs.ts";

describe("ec2 tool param schemas", () => {
	test("describeVpcs accepts empty input", () => {
		expect(describeVpcsSchema.safeParse({}).success).toBe(true);
	});
	test("describeVpcs rejects non-array vpcIds", () => {
		expect(describeVpcsSchema.safeParse({ vpcIds: "vpc-1" }).success).toBe(false);
	});
	test("describeInstances accepts valid input", () => {
		expect(describeInstancesSchema.safeParse({ instanceIds: ["i-abc"] }).success).toBe(true);
	});
	test("describeInstances rejects maxResults below 5", () => {
		expect(describeInstancesSchema.safeParse({ maxResults: 1 }).success).toBe(false);
	});
	test("describeSecurityGroups accepts groupIds", () => {
		expect(describeSecurityGroupsSchema.safeParse({ groupIds: ["sg-1"] }).success).toBe(true);
	});
	test("describeSecurityGroups rejects non-array groupNames", () => {
		expect(describeSecurityGroupsSchema.safeParse({ groupNames: "default" }).success).toBe(false);
	});
});
