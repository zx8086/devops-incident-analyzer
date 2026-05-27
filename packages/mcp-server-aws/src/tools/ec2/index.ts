// src/tools/ec2/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { toMcp } from "../wrap.ts";
import { withEstate } from "../estate-schema.ts";
import { describeInstances, type DescribeInstancesParams, describeInstancesSchema } from "./describe-instances.ts";
import { describeSecurityGroups, type DescribeSecurityGroupsParams, describeSecurityGroupsSchema } from "./describe-security-groups.ts";
import { describeVpcs, type DescribeVpcsParams, describeVpcsSchema } from "./describe-vpcs.ts";

export function registerEc2Tools(server: McpServer, config: AwsConfig): void {
	const vpcs = describeVpcs(config);
	server.tool(
		"aws_ec2_describe_vpcs",
		"List or describe VPCs. Returns Vpcs[] with CidrBlock, State, Tags. Truncates if many VPCs.",
		withEstate(config, describeVpcsSchema.shape),
		async (params) => toMcp(await vpcs(params as DescribeVpcsParams)),
	);

	const instances = describeInstances(config);
	server.tool(
		"aws_ec2_describe_instances",
		"List or describe EC2 instances. Returns Reservations[] each containing Instances[] with state, type, IP, tags.",
		withEstate(config, describeInstancesSchema.shape),
		async (params) => toMcp(await instances(params as DescribeInstancesParams)),
	);

	const secGroups = describeSecurityGroups(config);
	server.tool(
		"aws_ec2_describe_security_groups",
		"List or describe EC2 security groups with ingress/egress rules.",
		withEstate(config, describeSecurityGroupsSchema.shape),
		async (params) => toMcp(await secGroups(params as DescribeSecurityGroupsParams)),
	);
}
