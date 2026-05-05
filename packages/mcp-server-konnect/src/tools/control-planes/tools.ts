import type { z } from "zod";
import type { ToolHandler } from "../registry.js";
import * as controlPlanesOps from "./operations.js";
import * as parameters from "./parameters.js";
import * as prompts from "./prompts.js";

export type ControlPlanesTool = {
	method: string;
	name: string;
	description: string;
	parameters: z.ZodObject;
	category: string;
	handler: ToolHandler;
};

export const controlPlanesTools = (): ControlPlanesTool[] => [
	{
		method: "list_control_planes",
		name: "List Control Planes",
		description: prompts.listControlPlanesPrompt(),
		parameters: parameters.listControlPlanesParameters(),
		category: "control_planes",
		handler: async (args, { api }) =>
			controlPlanesOps.listControlPlanes(
				api,
				args.pageSize,
				args.pageNumber,
				args.filterName,
				args.filterClusterType,
				args.filterCloudGateway,
				args.labels,
				args.sort,
			),
	},
	{
		method: "get_control_plane",
		name: "Get Control Plane",
		description: prompts.getControlPlanePrompt(),
		parameters: parameters.getControlPlaneParameters(),
		category: "control_planes",
		handler: async (args, { api }) => controlPlanesOps.getControlPlane(api, args.controlPlaneId),
	},
	{
		method: "list_control_plane_group_memberships",
		name: "List Control Plane Group Memberships",
		description: prompts.listControlPlaneGroupMembershipsPrompt(),
		parameters: parameters.listControlPlaneGroupMembershipsParameters(),
		category: "control_planes",
		handler: async (args, { api }) =>
			controlPlanesOps.listControlPlaneGroupMemberships(api, args.groupId, args.pageSize, args.pageAfter),
	},
	{
		method: "check_control_plane_group_membership",
		name: "Check Control Plane Group Membership",
		description: prompts.checkControlPlaneGroupMembershipPrompt(),
		parameters: parameters.checkControlPlaneGroupMembershipParameters(),
		category: "control_planes",
		handler: async (args, { api }) => controlPlanesOps.checkControlPlaneGroupMembership(api, args.controlPlaneId),
	},

	{
		method: "create_control_plane",
		name: "Create Control Plane",
		description: prompts.createControlPlanePrompt(),
		parameters: parameters.createControlPlaneParameters(),
		category: "control_planes",
		handler: async (args, { api }) =>
			controlPlanesOps.createControlPlane(api, {
				name: args.name,
				description: args.description,
				clusterType: args.clusterType,
				cloudGateway: args.cloudGateway,
				authType: args.authType,
				proxyUrls: args.proxyUrls,
				labels: args.labels,
			}),
	},
	{
		method: "update_control_plane",
		name: "Update Control Plane",
		description: prompts.updateControlPlanePrompt(),
		parameters: parameters.updateControlPlaneParameters(),
		category: "control_planes",
		handler: async (args, { api }) =>
			controlPlanesOps.updateControlPlane(api, args.controlPlaneId, {
				name: args.name,
				description: args.description,
				labels: args.labels,
			}),
	},
	{
		method: "delete_control_plane",
		name: "Delete Control Plane",
		description: prompts.deleteControlPlanePrompt(),
		parameters: parameters.deleteControlPlaneParameters(),
		category: "control_planes",
		handler: async (args, { api }) => controlPlanesOps.deleteControlPlane(api, args.controlPlaneId),
	},

	{
		method: "list_data_plane_nodes",
		name: "List Data Plane Nodes",
		description: prompts.listDataPlaneNodesPrompt(),
		parameters: parameters.listDataPlaneNodesParameters(),
		category: "control_planes",
		handler: async (args, { api }) =>
			controlPlanesOps.listDataPlaneNodes(
				api,
				args.controlPlaneId,
				args.pageSize,
				args.pageNumber,
				args.filterStatus,
				args.filterHostname,
			),
	},
	{
		method: "get_data_plane_node",
		name: "Get Data Plane Node",
		description: prompts.getDataPlaneNodePrompt(),
		parameters: parameters.getDataPlaneNodeParameters(),
		category: "control_planes",
		handler: async (args, { api }) => controlPlanesOps.getDataPlaneNode(api, args.controlPlaneId, args.nodeId),
	},

	{
		method: "create_data_plane_token",
		name: "Create Data Plane Token",
		description: prompts.createDataPlaneTokenPrompt(),
		parameters: parameters.createDataPlaneTokenParameters(),
		category: "control_planes",
		handler: async (args, { api }) =>
			controlPlanesOps.createDataPlaneToken(api, args.controlPlaneId, args.name, args.expiresAt),
	},
	{
		method: "list_data_plane_tokens",
		name: "List Data Plane Tokens",
		description: prompts.listDataPlaneTokensPrompt(),
		parameters: parameters.listDataPlaneTokensParameters(),
		category: "control_planes",
		handler: async (args, { api }) =>
			controlPlanesOps.listDataPlaneTokens(api, args.controlPlaneId, args.pageSize, args.pageNumber),
	},
	{
		method: "revoke_data_plane_token",
		name: "Revoke Data Plane Token",
		description: prompts.revokeDataPlaneTokenPrompt(),
		parameters: parameters.revokeDataPlaneTokenParameters(),
		category: "control_planes",
		handler: async (args, { api }) => controlPlanesOps.revokeDataPlaneToken(api, args.controlPlaneId, args.tokenId),
	},

	{
		method: "get_control_plane_config",
		name: "Get Control Plane Configuration",
		description: prompts.getControlPlaneConfigPrompt(),
		parameters: parameters.getControlPlaneConfigParameters(),
		category: "control_planes",
		handler: async (args, { api }) => controlPlanesOps.getControlPlaneConfig(api, args.controlPlaneId),
	},
	{
		method: "update_control_plane_config",
		name: "Update Control Plane Configuration",
		description: prompts.updateControlPlaneConfigPrompt(),
		parameters: parameters.updateControlPlaneConfigParameters(),
		category: "control_planes",
		handler: async (args, { api }) =>
			controlPlanesOps.updateControlPlaneConfig(api, args.controlPlaneId, {
				proxyUrl: args.proxyUrl,
				telemetryUrl: args.telemetryUrl,
				authType: args.authType,
				cloudGateway: args.cloudGateway,
				analyticsEnabled: args.analyticsEnabled,
			}),
	},
];
