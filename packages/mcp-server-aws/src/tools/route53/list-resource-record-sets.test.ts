// src/tools/route53/list-resource-record-sets.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { ListResourceRecordSetsCommand, Route53Client } from "@aws-sdk/client-route-53";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsConfig } from "../../config/schemas.ts";
import { _resetClientsForTests } from "../../services/client-factory.ts";
import type { ToolError } from "../types.ts";
import {
	listResourceRecordSets,
	listResourceRecordSetsSchema,
	summarizeRecordSets,
} from "./list-resource-record-sets.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	estates: {
		prod: {
			assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
			externalId: "aws-mcp-readonly-2026",
		},
	},
};

afterEach(() => _resetClientsForTests());

describe("listResourceRecordSetsSchema", () => {
	test("requires hostedZoneId", () => {
		expect(listResourceRecordSetsSchema.safeParse({}).success).toBe(false);
		expect(listResourceRecordSetsSchema.safeParse({ hostedZoneId: "Z123" }).success).toBe(true);
	});

	test("accepts the positional continuation inputs and the limit alias", () => {
		expect(
			listResourceRecordSetsSchema.safeParse({
				hostedZoneId: "Z123",
				startRecordName: "api.example.com.",
				startRecordType: "A",
				limit: 100,
			}).success,
		).toBe(true);
	});

	// SIO-1205: pagination here is positional (NextRecordName/NextRecordType), not a token --
	// the schema must NOT offer a cursor alias. Zod strips the unknown key.
	test("has no cursor alias (unknown key is stripped)", () => {
		const parsed = listResourceRecordSetsSchema.parse({ hostedZoneId: "Z123", cursor: "tok" }) as Record<
			string,
			unknown
		>;
		expect(parsed.cursor).toBeUndefined();
	});
});

describe("listResourceRecordSets handler", () => {
	// The dependency guard lives in the handler (not a schema .refine) because only
	// the schema's .shape survives registration.
	test("startRecordType without startRecordName -> bad-input _error, no SDK call", async () => {
		const r53Mock = mockClient(Route53Client);
		r53Mock.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [], IsTruncated: false, MaxItems: 300 });

		const handler = listResourceRecordSets(config);
		const result = (await handler({ estate: "prod", hostedZoneId: "Z123", startRecordType: "A" })) as {
			_error: ToolError;
		};
		expect(result._error.kind).toBe("bad-input");
		expect(result._error.awsErrorMessage).toContain("startRecordType requires startRecordName");
		expect(r53Mock.commandCalls(ListResourceRecordSetsCommand)).toHaveLength(0);
	});

	test("forwards hostedZoneId, positional continuation, and limit->MaxItems to the SDK", async () => {
		const r53Mock = mockClient(Route53Client);
		r53Mock.on(ListResourceRecordSetsCommand).resolves({ ResourceRecordSets: [], IsTruncated: false, MaxItems: 300 });

		const handler = listResourceRecordSets(config);
		await handler({
			estate: "prod",
			hostedZoneId: "Z123",
			startRecordName: "api.example.com.",
			startRecordType: "A",
			limit: 100,
		});
		const call = r53Mock.commandCalls(ListResourceRecordSetsCommand)[0];
		expect(call?.args[0].input.HostedZoneId).toBe("Z123");
		expect(call?.args[0].input.StartRecordName).toBe("api.example.com.");
		expect(call?.args[0].input.StartRecordType).toBe("A");
		expect(call?.args[0].input.MaxItems).toBe(100);
	});

	test("returns ResourceRecordSets[] with alias targets intact", async () => {
		const r53Mock = mockClient(Route53Client);
		r53Mock.on(ListResourceRecordSetsCommand).resolves({
			ResourceRecordSets: [
				{
					Name: "api.example.com.",
					Type: "A",
					AliasTarget: {
						HostedZoneId: "Z35SXDOTRQ7X7K",
						DNSName: "web-123.eu-central-1.elb.amazonaws.com.",
						EvaluateTargetHealth: false,
					},
				},
			],
			IsTruncated: false,
			MaxItems: 300,
		});

		const handler = listResourceRecordSets(config);
		const result = (await handler({ estate: "prod", hostedZoneId: "Z123" })) as {
			ResourceRecordSets: { AliasTarget?: { DNSName: string } }[];
		};
		expect(result.ResourceRecordSets[0]?.AliasTarget?.DNSName).toBe("web-123.eu-central-1.elb.amazonaws.com.");
	});
});

describe("summarizeRecordSets", () => {
	test("projects Name, Type, alias DNSName, and the first record value", () => {
		const summary = summarizeRecordSets({
			ResourceRecordSets: [
				{
					Name: "api.example.com.",
					Type: "A",
					AliasTarget: {
						HostedZoneId: "Z35SXDOTRQ7X7K",
						DNSName: "web-123.eu-central-1.elb.amazonaws.com.",
						EvaluateTargetHealth: false,
					},
				},
				{
					Name: "cname.example.com.",
					Type: "CNAME",
					TTL: 300,
					ResourceRecords: [{ Value: "target.example.net" }, { Value: "ignored-second.example.net" }],
				},
			],
			IsTruncated: false,
			MaxItems: 300,
		});
		expect(summary).toEqual([
			{
				Name: "api.example.com.",
				Type: "A",
				AliasDNSName: "web-123.eu-central-1.elb.amazonaws.com.",
				FirstValue: undefined,
			},
			{ Name: "cname.example.com.", Type: "CNAME", AliasDNSName: undefined, FirstValue: "target.example.net" },
		]);
	});

	test("missing ResourceRecordSets -> empty array", () => {
		expect(summarizeRecordSets({ ResourceRecordSets: undefined, IsTruncated: false, MaxItems: 300 })).toEqual([]);
	});
});
