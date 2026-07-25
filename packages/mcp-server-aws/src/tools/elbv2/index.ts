// src/tools/elbv2/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type DescribeListenersParams, describeListeners, describeListenersSchema } from "./describe-listeners.ts";
import {
	type DescribeLoadBalancersParams,
	describeLoadBalancers,
	describeLoadBalancersSchema,
} from "./describe-load-balancers.ts";
import {
	type DescribeTargetGroupsParams,
	describeTargetGroups,
	describeTargetGroupsSchema,
} from "./describe-target-groups.ts";
import {
	type DescribeTargetHealthParams,
	describeTargetHealth,
	describeTargetHealthSchema,
} from "./describe-target-health.ts";

// SIO-1205: ingress-path tracing for the incident network map -- DNS record ->
// ALB/NLB -> listener -> target group -> target health.
export function registerElbv2Tools(server: McpServer, config: AwsConfig): void {
	const loadBalancers = describeLoadBalancers(config);
	server.tool(
		"aws_elbv2_describe_load_balancers",
		"List or describe ALB/NLB load balancers. Returns LoadBalancers[] with LoadBalancerArn, DNSName, Type (application/network), Scheme (internet-facing/internal), VpcId, and State. Match Route53 A/ALIAS/CNAME record targets against DNSName (normalize case and trailing dots) to link DNS to the load balancer. Filter by loadBalancerArns or names.",
		withEstate(config, describeLoadBalancersSchema.shape),
		async (params) => toMcp(await loadBalancers(params as DescribeLoadBalancersParams)),
	);

	const listeners = describeListeners(config);
	server.tool(
		"aws_elbv2_describe_listeners",
		"Describe the listeners of a load balancer (pass loadBalancerArn) or specific listeners (pass listenerArns) -- exactly one of the two. Returns Listeners[] with Port, Protocol, and DefaultActions[]. DefaultActions[].TargetGroupArn is the listener-to-target-group routing link: follow it into aws_elbv2_describe_target_groups / aws_elbv2_describe_target_health.",
		withEstate(config, describeListenersSchema.shape),
		async (params) => toMcp(await listeners(params as DescribeListenersParams)),
	);

	const targetGroups = describeTargetGroups(config);
	server.tool(
		"aws_elbv2_describe_target_groups",
		"List or describe target groups. Returns TargetGroups[] with TargetGroupArn, TargetType (instance/ip/lambda), Protocol, Port, VpcId, HealthCheck config, and LoadBalancerArns. Filter by loadBalancerArn (all target groups of one LB), targetGroupArns, or names.",
		withEstate(config, describeTargetGroupsSchema.shape),
		async (params) => toMcp(await targetGroups(params as DescribeTargetGroupsParams)),
	);

	const targetHealth = describeTargetHealth(config);
	server.tool(
		"aws_elbv2_describe_target_health",
		"Describe the health of a target group's registered targets -- one call per target group. Returns the echoed TargetGroupArn plus TargetHealthDescriptions[] with Target.Id, Target.Port, and TargetHealth.State (healthy/unhealthy/draining/unused) with Reason/Description. Target.Id is an instance id or an IP address -- resolve IPs via aws_ec2_describe_network_interfaces. No pagination on this API.",
		withEstate(config, describeTargetHealthSchema.shape),
		async (params) => toMcp(await targetHealth(params as DescribeTargetHealthParams)),
	);
}
