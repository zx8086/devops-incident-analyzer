import type { z } from "zod";
import * as parameters from "./parameters.js";
import * as prompts from "./prompts.js";

export type ControlPlanesTool = {
	method: string;
	name: string;
	description: string;
	parameters: z.ZodObject<any, any, any, any>;
	category: string;
};

export const controlPlanesTools = (): ControlPlanesTool[] => [
	// =========================
	// Basic Control Plane Operations
	// =========================
	{
		method: "list_control_planes",
		name: "List Control Planes",
		description: prompts.listControlPlanesPrompt(),
		parameters: parameters.listControlPlanesParameters(),
		category: "control_planes",
	},
	{
		method: "get_control_plane",
		name: "Get Control Plane",
		description: prompts.getControlPlanePrompt(),
		parameters: parameters.getControlPlaneParameters(),
		category: "control_planes",
	},
	{
		method: "list_control_plane_group_memberships",
		name: "List Control Plane Group Memberships",
		description: prompts.listControlPlaneGroupMembershipsPrompt(),
		parameters: parameters.listControlPlaneGroupMembershipsParameters(),
		category: "control_planes",
	},
	{
		method: "check_control_plane_group_membership",
		name: "Check Control Plane Group Membership",
		description: prompts.checkControlPlaneGroupMembershipPrompt(),
		parameters: parameters.checkControlPlaneGroupMembershipParameters(),
		category: "control_planes",
	},

	// =========================
	// Control Plane CRUD Operations
	// =========================
	{
		method: "create_control_plane",
		name: "Create Control Plane",
		description: prompts.createControlPlanePrompt(),
		parameters: parameters.createControlPlaneParameters(),
		category: "control_planes",
	},
	{
		method: "update_control_plane",
		name: "Update Control Plane",
		description: prompts.updateControlPlanePrompt(),
		parameters: parameters.updateControlPlaneParameters(),
		category: "control_planes",
	},
	{
		method: "delete_control_plane",
		name: "Delete Control Plane",
		description: prompts.deleteControlPlanePrompt(),
		parameters: parameters.deleteControlPlaneParameters(),
		category: "control_planes",
	},

	// =========================
	// Data Plane Node Management
	// =========================
	{
		method: "list_data_plane_nodes",
		name: "List Data Plane Nodes",
		description: prompts.listDataPlaneNodesPrompt(),
		parameters: parameters.listDataPlaneNodesParameters(),
		category: "control_planes",
	},
	{
		method: "get_data_plane_node",
		name: "Get Data Plane Node",
		description: prompts.getDataPlaneNodePrompt(),
		parameters: parameters.getDataPlaneNodeParameters(),
		category: "control_planes",
	},

	// =========================
	// Data Plane Token Management
	// =========================
	{
		method: "create_data_plane_token",
		name: "Create Data Plane Token",
		description: prompts.createDataPlaneTokenPrompt(),
		parameters: parameters.createDataPlaneTokenParameters(),
		category: "control_planes",
	},
	{
		method: "list_data_plane_tokens",
		name: "List Data Plane Tokens",
		description: prompts.listDataPlaneTokensPrompt(),
		parameters: parameters.listDataPlaneTokensParameters(),
		category: "control_planes",
	},
	{
		method: "revoke_data_plane_token",
		name: "Revoke Data Plane Token",
		description: prompts.revokeDataPlaneTokenPrompt(),
		parameters: parameters.revokeDataPlaneTokenParameters(),
		category: "control_planes",
	},

	// =========================
	// Control Plane Configuration
	// =========================
	{
		method: "get_control_plane_config",
		name: "Get Control Plane Configuration",
		description: prompts.getControlPlaneConfigPrompt(),
		parameters: parameters.getControlPlaneConfigParameters(),
		category: "control_planes",
	},
	{
		method: "update_control_plane_config",
		name: "Update Control Plane Configuration",
		description: prompts.updateControlPlaneConfigPrompt(),
		parameters: parameters.updateControlPlaneConfigParameters(),
		category: "control_planes",
	},
];
