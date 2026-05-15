// src/tools/ec2/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { describeInstances, describeInstancesSchema } from "./describe-instances.ts";
import { describeSecurityGroups, describeSecurityGroupsSchema } from "./describe-security-groups.ts";
import { describeVpcs, describeVpcsSchema } from "./describe-vpcs.ts";

function toMcp(result: unknown): { content: [{ type: "text"; text: string }] } {
	return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

export function registerEc2Tools(server: McpServer, config: AwsConfig): void {
	const vpcs = describeVpcs(config);
	server.tool(
		"aws_ec2_describe_vpcs",
		"List or describe VPCs. Returns Vpcs[] with CidrBlock, State, Tags. Truncates if many VPCs.",
		describeVpcsSchema.shape,
		async (params) => toMcp(await vpcs(params)),
	);

	const instances = describeInstances(config);
	server.tool(
		"aws_ec2_describe_instances",
		"List or describe EC2 instances. Returns Reservations[] each containing Instances[] with state, type, IP, tags.",
		describeInstancesSchema.shape,
		async (params) => toMcp(await instances(params)),
	);

	const secGroups = describeSecurityGroups(config);
	server.tool(
		"aws_ec2_describe_security_groups",
		"List or describe EC2 security groups with ingress/egress rules.",
		describeSecurityGroupsSchema.shape,
		async (params) => toMcp(await secGroups(params)),
	);
}
