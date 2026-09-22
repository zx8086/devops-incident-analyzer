// tests/churn-tags.test.ts
import { describe, expect, test } from "bun:test";
import type { AwsClient } from "../scripts/monitor/checks/alarms.ts";
import {
	buildArn,
	DEFAULT_CHURN_TAG_KEYS,
	lookupChurnOwned,
	parseChurnTagKeys,
} from "../scripts/monitor/checks/churn-tags.ts";

const ACC = "654654584630";
const REGION = "eu-central-1";
const eniArn = (id: string): string => `arn:aws:ec2:${REGION}:${ACC}:network-interface/${id}`;

// Captured verbatim from GetResources against eu-mendix-platform-prd on
// 2026-09-22. The two ENIs that were ASKED FOR but are absent below are real:
// GetResources omits a resource with no tags at all, and it omits a deleted one
// -- eni-03003d12a5aa90195 is a live EKS control-plane interface carrying zero
// tags, eni-096c1737cc1f1b18a had already been destroyed by Karpenter churn.
// That ambiguity is why absence must mean "report it", never "hide it".
const REAL_RESPONSE = {
	ResourceTagMappingList: [
		{
			ResourceARN: eniArn("eni-0fd14d1c3d11b9327"),
			Tags: [
				{ Key: "kubernetes.io/cluster/mendix-platform-eks-prd", Value: "owned" },
				{ Key: "node.k8s.amazonaws.com/instance_id", Value: "i-03ef70cafdad89633" },
				{ Key: "karpenter.sh/discovery", Value: "mendix-platform-eks-prd" },
				{ Key: "eks:eni:owner", Value: "amazon-vpc-cni" },
				{ Key: "cluster.k8s.amazonaws.com/name", Value: "mendix-platform-eks-prd" },
				{ Key: "karpenter.sh/nodepool", Value: "general-purpose" },
				{ Key: "karpenter.k8s.aws/ec2nodeclass", Value: "default" },
				{ Key: "eks:eks-cluster-name", Value: "mendix-platform-eks-prd" },
			],
		},
		{
			ResourceARN: eniArn("eni-0dd4a4f3dfb50f80a"),
			Tags: [
				{ Key: "eks:eni:owner", Value: "amazon-vpc-cni" },
				{ Key: "node.k8s.amazonaws.com/instance_id", Value: "i-03ef70cafdad89633" },
				{ Key: "node.k8s.amazonaws.com/createdAt", Value: "2026-09-19T08:24:14Z" },
				{ Key: "cluster.k8s.amazonaws.com/name", Value: "mendix-platform-eks-prd" },
			],
		},
	],
};

function fakeTagging(response: unknown, onSend?: (n: number) => void): AwsClient {
	let calls = 0;
	return {
		send: async () => {
			calls++;
			onSend?.(calls);
			return response;
		},
	} as unknown as AwsClient;
}

function throwingTagging(message: string): AwsClient {
	return {
		send: async () => {
			throw new Error(message);
		},
	} as unknown as AwsClient;
}

describe("parseChurnTagKeys", () => {
	test("an unset value yields the defaults", () => {
		expect(parseChurnTagKeys(undefined)).toEqual([...DEFAULT_CHURN_TAG_KEYS]);
	});

	test("an explicitly empty value disables classification", () => {
		// The kill-switch. It must NOT fall back to the defaults, or there would be
		// no way to turn the behaviour off without editing code.
		expect(parseChurnTagKeys("")).toEqual([]);
	});

	test("a custom list replaces the defaults and is trimmed", () => {
		expect(parseChurnTagKeys(" a/one , b/two ")).toEqual(["a/one", "b/two"]);
	});

	test("the defaults exclude karpenter.sh/discovery", () => {
		// discovery is a SELECTOR tag placed on long-lived subnets and security
		// groups so Karpenter can find them -- not a mark of something Karpenter
		// created. Including it would hide stable infrastructure.
		expect([...DEFAULT_CHURN_TAG_KEYS]).not.toContain("karpenter.sh/discovery");
	});
});

describe("buildArn", () => {
	test("maps the three EC2 types a Config evaluation can name", () => {
		expect(buildArn(REGION, ACC, "AWS::EC2::NetworkInterface", "eni-1")).toBe(eniArn("eni-1"));
		expect(buildArn(REGION, ACC, "AWS::EC2::Instance", "i-1")).toBe(`arn:aws:ec2:${REGION}:${ACC}:instance/i-1`);
		expect(buildArn(REGION, ACC, "AWS::EC2::Volume", "vol-1")).toBe(`arn:aws:ec2:${REGION}:${ACC}:volume/vol-1`);
	});

	test("an unmappable type yields null so the finding is reported unclassified", () => {
		expect(buildArn(REGION, ACC, "AWS::CloudFormation::Stack", "stack/x")).toBeNull();
		expect(buildArn(REGION, ACC, "AWS::EC2::Subnet", "subnet-1")).toBeNull();
	});
});

describe("lookupChurnOwned", () => {
	const keys = [...DEFAULT_CHURN_TAG_KEYS];

	test("classifies a karpenter-tagged resource as churn", async () => {
		const res = await lookupChurnOwned(fakeTagging(REAL_RESPONSE), [eniArn("eni-0fd14d1c3d11b9327")], keys);
		expect(res.complete).toBe(true);
		expect(res.churnOwned.has("eni-0fd14d1c3d11b9327")).toBe(true);
	});

	test("classifies a VPC-CNI-only ENI as churn", async () => {
		// Over half the noise: the CNI tags the secondary pod ENIs, and those carry
		// no karpenter.sh key at all. Karpenter keys alone would miss them.
		const res = await lookupChurnOwned(fakeTagging(REAL_RESPONSE), [eniArn("eni-0dd4a4f3dfb50f80a")], keys);
		expect(res.churnOwned.has("eni-0dd4a4f3dfb50f80a")).toBe(true);
	});

	test("a resource GetResources omits is NOT churn", async () => {
		// The single most important case: a live untagged AWS-managed ENI and a
		// deleted one are both simply absent from the response. Treating absence as
		// churn would silently hide every NAT/ELB/EKS-control-plane violation.
		const res = await lookupChurnOwned(
			fakeTagging(REAL_RESPONSE),
			[eniArn("eni-03003d12a5aa90195"), eniArn("eni-096c1737cc1f1b18a")],
			keys,
		);
		expect(res.complete).toBe(true);
		expect(res.churnOwned.has("eni-03003d12a5aa90195")).toBe(false);
		expect(res.churnOwned.has("eni-096c1737cc1f1b18a")).toBe(false);
	});

	test("a resource tagged only with unrelated keys is not churn", async () => {
		const res = await lookupChurnOwned(
			fakeTagging({
				ResourceTagMappingList: [{ ResourceARN: eniArn("eni-business"), Tags: [{ Key: "CostCenter", Value: "1234" }] }],
			}),
			[eniArn("eni-business")],
			keys,
		);
		expect(res.churnOwned.has("eni-business")).toBe(false);
	});

	test("fails OPEN on an API error and says why", async () => {
		// A throttle must never suppress a real violation. The tagged failure is
		// what distinguishes "looked and found nothing" from "could not look".
		const res = await lookupChurnOwned(throwingTagging("Rate exceeded"), [eniArn("eni-1")], keys);
		expect(res.complete).toBe(false);
		expect(res.error).toContain("Rate exceeded");
		expect(res.churnOwned.size).toBe(0);
	});

	test("an empty key list short-circuits without calling the API", async () => {
		let called = 0;
		const res = await lookupChurnOwned(
			fakeTagging(REAL_RESPONSE, () => {
				called++;
			}),
			[eniArn("eni-1")],
			[],
		);
		expect(called).toBe(0);
		expect(res.complete).toBe(true);
		expect(res.churnOwned.size).toBe(0);
	});

	test("no ARNs means no API call", async () => {
		let called = 0;
		const res = await lookupChurnOwned(
			fakeTagging(REAL_RESPONSE, () => {
				called++;
			}),
			[],
			keys,
		);
		expect(called).toBe(0);
		expect(res.complete).toBe(true);
	});

	test("batches at the API's 100-ARN limit", async () => {
		// GetResources rejects more than 100 ARNs per call, so 250 must be 3 calls.
		let calls = 0;
		const arns = Array.from({ length: 250 }, (_, i) => eniArn(`eni-${i}`));
		await lookupChurnOwned(
			fakeTagging({ ResourceTagMappingList: [] }, (n) => {
				calls = n;
			}),
			arns,
			keys,
		);
		expect(calls).toBe(3);
	});

	test("a malformed mapping entry is skipped rather than throwing", async () => {
		const res = await lookupChurnOwned(
			fakeTagging({
				ResourceTagMappingList: [
					{ Tags: [{ Key: "karpenter.sh/nodepool", Value: "x" }] },
					{ ResourceARN: eniArn("eni-ok"), Tags: undefined },
					{ ResourceARN: eniArn("eni-good"), Tags: [{ Key: "karpenter.sh/nodepool", Value: "x" }] },
				],
			}),
			[eniArn("eni-ok"), eniArn("eni-good")],
			keys,
		);
		expect(res.complete).toBe(true);
		expect([...res.churnOwned]).toEqual(["eni-good"]);
	});
});
