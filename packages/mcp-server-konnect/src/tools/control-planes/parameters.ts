import { z } from "zod";
import { CommonSchemas } from "../../utils/validation.js";

export const listControlPlanesParameters = () =>
	z.object({
		pageSize: z.number().int().min(1).max(1000).default(10).describe("Number of control planes per page"),
		pageNumber: z.number().int().min(1).optional().describe("Page number to retrieve"),
		filterName: z.string().optional().describe("Filter control planes by name (partial match)"),
		filterClusterType: z.string().optional().describe("Filter by cluster type (e.g., 'CLUSTER_TYPE_HYBRID')"),
		filterCloudGateway: z.boolean().optional().describe("Filter by cloud gateway availability"),
		labels: z.string().optional().describe("Filter by labels (comma-separated key:value pairs)"),
		sort: z.string().optional().describe("Sort order for results"),
	});

export const getControlPlaneParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
	});

export const listControlPlaneGroupMembershipsParameters = () =>
	z.object({
		groupId: CommonSchemas.uuid.describe("Control plane group ID (the ID of the control plane that acts as the group)"),
		pageSize: z.number().int().min(1).max(1000).default(10).describe("Number of members to return per page"),
		pageAfter: z.string().optional().describe("Cursor for pagination after a specific item"),
	});

export const checkControlPlaneGroupMembershipParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe(
			"Control plane ID to check (can be obtained from list-control-planes tool)",
		),
	});

export const createControlPlaneParameters = () =>
	z.object({
		name: z.string().min(1).describe("Control plane name"),
		description: z.string().optional().describe("Control plane description"),
		clusterType: z
			.enum(["CLUSTER_TYPE_HYBRID", "CLUSTER_TYPE_K8S_INGRESS_CONTROLLER", "CLUSTER_TYPE_CONTROL_PLANE"])
			.default("CLUSTER_TYPE_HYBRID")
			.describe("Cluster type for the control plane"),
		cloudGateway: z.boolean().default(false).describe("Enable cloud gateway for this control plane"),
		authType: z
			.enum(["pki", "pinned_certs"])
			.default("pinned_certs")
			.describe("Authentication type for data plane nodes"),
		proxyUrls: z.array(z.string()).optional().describe("Custom proxy URLs for the control plane"),
		labels: z.record(z.string(), z.string()).optional().describe("Labels to associate with the control plane"),
	});

export const updateControlPlaneParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
		name: z.string().optional().describe("New control plane name"),
		description: z.string().optional().describe("New control plane description"),
		labels: z.record(z.string(), z.string()).optional().describe("New labels for the control plane"),
	});

export const deleteControlPlaneParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
	});

export const listDataPlaneNodesParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
		pageSize: z.number().int().min(1).max(1000).default(10).describe("Number of data plane nodes per page"),
		pageNumber: z.number().int().min(1).optional().describe("Page number to retrieve"),
		filterStatus: z
			.enum(["connected", "disconnected", "partially_connected"])
			.optional()
			.describe("Filter nodes by connection status"),
		filterHostname: z.string().optional().describe("Filter nodes by hostname (partial match)"),
	});

export const getDataPlaneNodeParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
		nodeId: CommonSchemas.uuid.describe("Data plane node ID"),
	});

export const createDataPlaneTokenParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
		name: z.string().describe("Name for the data plane token"),
		expiresAt: z.string().optional().describe("Token expiration time (ISO 8601 format)"),
	});

export const revokeDataPlaneTokenParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
		tokenId: CommonSchemas.uuid.describe("Data plane token ID to revoke"),
	});

export const listDataPlaneTokensParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
		pageSize: z.number().int().min(1).max(1000).default(10).describe("Number of tokens per page"),
		pageNumber: z.number().int().min(1).optional().describe("Page number to retrieve"),
	});

export const getControlPlaneConfigParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
	});

export const updateControlPlaneConfigParameters = () =>
	z.object({
		controlPlaneId: CommonSchemas.uuid.describe("Control Plane ID (obtainable from list-control-planes tool)"),
		proxyUrl: z.string().optional().describe("Proxy URL for the control plane"),
		telemetryUrl: z.string().optional().describe("Telemetry endpoint URL"),
		authType: z.enum(["pki", "pinned_certs"]).optional().describe("Authentication type for data plane connections"),
		cloudGateway: z.boolean().optional().describe("Enable/disable cloud gateway"),
		analyticsEnabled: z.boolean().optional().describe("Enable/disable analytics collection"),
	});
