// packages/shared/src/landing-zone-topology.ts

import { z } from "zod";

const LabelSchema = z.string().trim().min(1).max(512);

export const TopologyDiagramViewSchema = z.enum(["network", "dns", "path"]);
export type TopologyDiagramView = z.infer<typeof TopologyDiagramViewSchema>;

export const TopologyVisualStateSchema = z.enum(["confirmed", "proposed", "drift", "unverified"]);
export type TopologyVisualState = z.infer<typeof TopologyVisualStateSchema>;

export const LandingZoneTopologyNodeKindSchema = z.enum([
	"aws-organization",
	"organizational-unit",
	"aws-account",
	"region",
	"availability-zone",
	"vpc",
	"subnet",
	"route-table",
	"route",
	"internet-gateway",
	"nat-gateway",
	"transit-gateway",
	"core-network",
	"network-attachment",
	"vpc-endpoint",
	"network-acl",
	"hosted-zone",
	"dns-record",
	"load-balancer",
	"resolver-endpoint",
	"resolver-rule",
	"dns-firewall-rule-group",
	"ip-address",
	"cidr-block",
]);
export type LandingZoneTopologyNodeKind = z.infer<typeof LandingZoneTopologyNodeKindSchema>;

export const LandingZoneTopologyNodeSchema = z
	.object({
		id: LabelSchema,
		kind: LandingZoneTopologyNodeKindSchema,
		label: LabelSchema,
		detail: z.string().trim().min(1).max(2_048).optional(),
		visualState: TopologyVisualStateSchema,
		sourceIds: z.array(LabelSchema).max(20),
	})
	.strict();
export type LandingZoneTopologyNode = z.infer<typeof LandingZoneTopologyNodeSchema>;

export const LandingZoneTopologyEdgeSchema = z
	.object({
		id: LabelSchema,
		from: LabelSchema,
		to: LabelSchema,
		kind: LabelSchema,
		label: LabelSchema.optional(),
		visualState: TopologyVisualStateSchema,
		sourceIds: z.array(LabelSchema).max(20),
	})
	.strict();
export type LandingZoneTopologyEdge = z.infer<typeof LandingZoneTopologyEdgeSchema>;

export const LandingZoneTopologySourceSchema = z
	.object({
		id: LabelSchema,
		label: LabelSchema,
		url: z.url().max(2_048).optional(),
		state: z.enum(["desired", "observed", "proposed"]),
	})
	.strict();
export type LandingZoneTopologySource = z.infer<typeof LandingZoneTopologySourceSchema>;

export const LandingZoneTopologyLegendItemSchema = z
	.object({
		state: TopologyVisualStateSchema,
		label: LabelSchema,
		description: z.string().trim().min(1).max(1_024),
	})
	.strict();

export const LandingZoneTopologySchema = z
	.object({
		generatedAt: z.iso.datetime({ offset: true }),
		title: LabelSchema,
		summary: z.string().trim().min(1).max(4_096),
		accountId: LabelSchema.optional(),
		focus: LabelSchema.optional(),
		nodes: z.array(LandingZoneTopologyNodeSchema).max(200),
		edges: z.array(LandingZoneTopologyEdgeSchema).max(400),
		sources: z.array(LandingZoneTopologySourceSchema).max(100),
		legend: z.array(LandingZoneTopologyLegendItemSchema).max(4),
		text: z.array(z.string().max(2_048)).max(400),
		mermaid: z.string().max(100_000),
		truncated: z.boolean(),
	})
	.strict()
	.superRefine((topology, context) => {
		const nodeIds = new Set(topology.nodes.map((node) => node.id));
		for (const [index, edge] of topology.edges.entries()) {
			if (!nodeIds.has(edge.from))
				context.addIssue({ code: "custom", path: ["edges", index, "from"], message: "edge source is missing" });
			if (!nodeIds.has(edge.to))
				context.addIssue({ code: "custom", path: ["edges", index, "to"], message: "edge target is missing" });
		}
	});
export type LandingZoneTopology = z.infer<typeof LandingZoneTopologySchema>;

export const LandingZoneTopologyEventSchema = z
	.object({
		type: z.literal("landing_zone_topology"),
		view: TopologyDiagramViewSchema,
		topology: LandingZoneTopologySchema,
	})
	.strict();
export type LandingZoneTopologyEvent = z.infer<typeof LandingZoneTopologyEventSchema>;
