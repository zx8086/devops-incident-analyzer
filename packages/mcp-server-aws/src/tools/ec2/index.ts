// src/tools/ec2/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type DescribeFlowLogsParams, describeFlowLogs, describeFlowLogsSchema } from "./describe-flow-logs.ts";
import { type DescribeInstancesParams, describeInstances, describeInstancesSchema } from "./describe-instances.ts";
import {
	type DescribeNatGatewaysParams,
	describeNatGateways,
	describeNatGatewaysSchema,
} from "./describe-nat-gateways.ts";
import {
	type DescribeNetworkAclsParams,
	describeNetworkAcls,
	describeNetworkAclsSchema,
} from "./describe-network-acls.ts";
import {
	type DescribeNetworkInterfacesParams,
	describeNetworkInterfaces,
	describeNetworkInterfacesSchema,
} from "./describe-network-interfaces.ts";
import {
	type DescribeRouteTablesParams,
	describeRouteTables,
	describeRouteTablesSchema,
} from "./describe-route-tables.ts";
import {
	type DescribeSecurityGroupsParams,
	describeSecurityGroups,
	describeSecurityGroupsSchema,
} from "./describe-security-groups.ts";
import {
	type DescribeTransitGatewaysParams,
	describeTransitGateways,
	describeTransitGatewaysSchema,
} from "./describe-transit-gateways.ts";
import {
	type DescribeVpcEndpointsParams,
	describeVpcEndpoints,
	describeVpcEndpointsSchema,
} from "./describe-vpc-endpoints.ts";
import {
	type DescribeVpcPeeringConnectionsParams,
	describeVpcPeeringConnections,
	describeVpcPeeringConnectionsSchema,
} from "./describe-vpc-peering-connections.ts";
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

	// SIO-1120: network-path drill-downs. Answer "does this private subnet egress via a NAT
	// gateway, a transit gateway, or a VPC/gateway endpoint, and is that path healthy?" -- the
	// connectivity question the localcore Kafka-disconnection incident could not resolve.
	const routeTables = describeRouteTables(config);
	server.tool(
		"aws_ec2_describe_route_tables",
		"List or describe route tables. Returns RouteTables[] with Routes[] (DestinationCidrBlock/DestinationPrefixListId + a target: NatGatewayId, TransitGatewayId, GatewayId (igw-/vpce-), VpcPeeringConnectionId, NetworkInterfaceId) and Associations[] mapping SubnetId -> route table. Use to trace a private subnet's egress path. Filter by association.subnet-id or vpc-id.",
		withEstate(config, describeRouteTablesSchema.shape),
		async (params) => toMcp(await routeTables(params as DescribeRouteTablesParams)),
	);

	const natGateways = describeNatGateways(config);
	server.tool(
		"aws_ec2_describe_nat_gateways",
		"List or describe NAT gateways. Returns NatGateways[] with State (available/pending/failed/deleted), SubnetId, VpcId, and NatGatewayAddresses[]. Use to confirm the internet-egress path for a private-subnet task exists and is available. Filter by vpc-id, subnet-id, or state.",
		withEstate(config, describeNatGatewaysSchema.shape),
		async (params) => toMcp(await natGateways(params as DescribeNatGatewaysParams)),
	);

	const networkAcls = describeNetworkAcls(config);
	server.tool(
		"aws_ec2_describe_network_acls",
		"List or describe network ACLs. Returns NetworkAcls[] with Entries[] (RuleNumber, Protocol, PortRange, CidrBlock, Egress, RuleAction allow/deny) and Associations[] (SubnetId). Use to find a subnet-level deny that a security-group check misses (e.g. blocked ephemeral return ports). Filter by association.subnet-id or vpc-id.",
		withEstate(config, describeNetworkAclsSchema.shape),
		async (params) => toMcp(await networkAcls(params as DescribeNetworkAclsParams)),
	);

	const flowLogs = describeFlowLogs(config);
	server.tool(
		"aws_ec2_describe_flow_logs",
		"List or describe VPC flow log CONFIGURATIONS (not the log content). Returns FlowLogs[] with ResourceId (vpc-/subnet-/eni-), FlowLogStatus, DeliverLogsStatus, and LogDestination. Use to confirm flow logging is enabled before concluding 'no packet-level evidence'; then read content from the /vpc/flow-logs/* log group via aws_logs_*. Filter by resource-id or deliver-log-status.",
		withEstate(config, describeFlowLogsSchema.shape),
		async (params) => toMcp(await flowLogs(params as DescribeFlowLogsParams)),
	);

	const transitGateways = describeTransitGateways(config);
	server.tool(
		"aws_ec2_describe_transit_gateways",
		"List or describe transit gateways. Returns TransitGateways[] with State, OwnerId, and Options. Use in hub-and-spoke estates to confirm a tgw-... target referenced by a route table exists and is available. Filter by state or owner-id.",
		withEstate(config, describeTransitGatewaysSchema.shape),
		async (params) => toMcp(await transitGateways(params as DescribeTransitGatewaysParams)),
	);

	const vpcPeeringConnections = describeVpcPeeringConnections(config);
	server.tool(
		"aws_ec2_describe_vpc_peering_connections",
		"List or describe VPC peering connections. Returns VpcPeeringConnections[] with Status.Code (active/pending-acceptance/failed), RequesterVpcInfo and AccepterVpcInfo (VpcId, CidrBlock, OwnerId). Use when a target VPC lives in another account/VPC and a pcx-... path must be confirmed active. Filter by status-code or requester-vpc-info.vpc-id.",
		withEstate(config, describeVpcPeeringConnectionsSchema.shape),
		async (params) => toMcp(await vpcPeeringConnections(params as DescribeVpcPeeringConnectionsParams)),
	);
}
