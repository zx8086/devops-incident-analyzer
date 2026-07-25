// src/tools/route53/list-hosted-zones.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { ListHostedZonesCommand, Route53Client } from "@aws-sdk/client-route-53";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsConfig } from "../../config/schemas.ts";
import { _resetClientsForTests } from "../../services/client-factory.ts";
import { listHostedZones, listHostedZonesSchema } from "./list-hosted-zones.ts";

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

describe("listHostedZonesSchema", () => {
	test("accepts empty input", () => {
		expect(listHostedZonesSchema.safeParse({}).success).toBe(true);
	});

	test("accepts the SIO-838 limit and cursor aliases", () => {
		expect(listHostedZonesSchema.safeParse({ limit: 50, cursor: "tok" }).success).toBe(true);
	});

	test("limit alias inherits the MaxItems 1-100 bounds", () => {
		expect(listHostedZonesSchema.safeParse({ limit: 0 }).success).toBe(false);
		expect(listHostedZonesSchema.safeParse({ limit: 101 }).success).toBe(false);
	});
});

describe("listHostedZones alias wiring", () => {
	test("cursor->Marker and limit->MaxItems reach the SDK command", async () => {
		const r53Mock = mockClient(Route53Client);
		r53Mock
			.on(ListHostedZonesCommand)
			.resolves({ HostedZones: [], Marker: undefined, IsTruncated: false, MaxItems: 100 });

		const handler = listHostedZones(config);
		await handler({ estate: "prod", cursor: "tok-1", limit: 25 });
		const call = r53Mock.commandCalls(ListHostedZonesCommand)[0];
		expect(call?.args[0].input.Marker).toBe("tok-1");
		expect(call?.args[0].input.MaxItems).toBe(25);
	});

	test("SDK-named marker/maxItems win over the aliases", async () => {
		const r53Mock = mockClient(Route53Client);
		r53Mock
			.on(ListHostedZonesCommand)
			.resolves({ HostedZones: [], Marker: undefined, IsTruncated: false, MaxItems: 100 });

		const handler = listHostedZones(config);
		await handler({ estate: "prod", marker: "sdk-tok", cursor: "alias-tok", maxItems: 10, limit: 99 });
		const call = r53Mock.commandCalls(ListHostedZonesCommand)[0];
		expect(call?.args[0].input.Marker).toBe("sdk-tok");
		expect(call?.args[0].input.MaxItems).toBe(10);
	});
});
