// src/tools/ec2/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type DescribeInstancesParams, describeInstances, describeInstancesSchema } from "./describe-instances.ts";
import {
	type DescribeNetworkInterfacesParams,
	describeNetworkInterfaces,
	describeNetworkInterfacesSchema,
} from "./describe-network-interfaces.ts";
import {
	type DescribeSecurityGroupsParams,
	describeSecurityGroups,
	describeSecurityGroupsSchema,
} from "./describe-security-groups.ts";
import {
	type DescribeVpcEndpointsParams,
	describeVpcEndpoints,
	describeVpcEndpointsSchema,
} from "./describe-vpc-endpoints.ts";
import { type DescribeVpcsParams, describeVpcs, describeVpcsSchema } from "./describe-vpcs.ts";

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

	// SIO-1057: resolve a VPC endpoint (vpce-...) to its backing ENI IDs, to confirm whether a
	// stale PrivateLink target IP is still a registered endpoint interface.
	const vpcEndpoints = describeVpcEndpoints(config);
	server.tool(
		"aws_ec2_describe_vpc_endpoints",
		"List or describe VPC endpoints. Returns VpcEndpoints[] with ServiceName, State, and NetworkInterfaceIds (the backing ENIs). Filter by vpcEndpointIds or filters (e.g. vpc-id).",
		withEstate(config, describeVpcEndpointsSchema.shape),
		async (params) => toMcp(await vpcEndpoints(params as DescribeVpcEndpointsParams)),
	);

	// SIO-1057: resolve an ENI (eni-...) to its PrivateIpAddress(es), or find an ENI by private IP
	// via filters: [{ Name: "private-ip-address", Values: ["10.34.50.147"] }].
	const networkInterfaces = describeNetworkInterfaces(config);
	server.tool(
		"aws_ec2_describe_network_interfaces",
		"List or describe elastic network interfaces (ENIs). Returns NetworkInterfaces[] with PrivateIpAddress, PrivateIpAddresses[], Status, and Attachment. Filter by networkInterfaceIds or filters (e.g. private-ip-address, vpc-id).",
		withEstate(config, describeNetworkInterfacesSchema.shape),
		async (params) => toMcp(await networkInterfaces(params as DescribeNetworkInterfacesParams)),
	);
}
