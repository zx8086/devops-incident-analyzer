import type { z } from "zod";
import type { ToolHandler } from "../registry.js";
import * as portalManagementOps from "./operations.js";
import * as parameters from "./parameters.js";
import * as prompts from "./prompts.js";

export type PortalManagementTool = {
	method: string;
	name: string;
	description: string;
	parameters: z.ZodObject;
	category: string;
	handler: ToolHandler;
};

export const portalManagementTools = (): PortalManagementTool[] => [
	{
		method: "list_portals",
		name: "List Developer Portals",
		description: prompts.portalManagementPrompts["list-portals"],
		parameters: parameters.listPortalsParametersSchema,
		category: "portal-management",
		handler: async (args, { api }) => portalManagementOps.listPortals(api, args.pageSize, args.pageNumber),
	},
	{
		method: "create_portal",
		name: "Create Developer Portal",
		description: prompts.portalManagementPrompts["create-portal"],
		parameters: parameters.createPortalParametersSchema,
		category: "portal-management",
		handler: async (args, { api }) => portalManagementOps.createPortal(api, args),
	},
	{
		method: "get_portal",
		name: "Get Portal Details",
		description: prompts.portalManagementPrompts["get-portal"],
		parameters: parameters.getPortalParametersSchema,
		category: "portal-management",
		handler: async (args, { api }) => portalManagementOps.getPortal(api, args.portalId),
	},
	{
		method: "update_portal",
		name: "Update Portal Configuration",
		description: prompts.portalManagementPrompts["update-portal"],
		parameters: parameters.updatePortalParametersSchema,
		category: "portal-management",
		handler: async (args, { api }) => portalManagementOps.updatePortal(api, args.portalId, args),
	},
	{
		method: "delete_portal",
		name: "Delete Developer Portal",
		description: prompts.portalManagementPrompts["delete-portal"],
		parameters: parameters.deletePortalParametersSchema,
		category: "portal-management",
		handler: async (args, { api }) => portalManagementOps.deletePortal(api, args.portalId),
	},
	{
		method: "list_portal_products",
		name: "List Portal Published Products",
		description: prompts.portalManagementPrompts["list-portal-products"],
		parameters: parameters.listPortalProductsParametersSchema,
		category: "portal-management",
		handler: async (args, { api }) =>
			portalManagementOps.listPortalProducts(api, args.portalId, args.pageSize, args.pageNumber),
	},
	{
		method: "publish_portal_product",
		name: "Publish API Product to Portal",
		description: prompts.portalManagementPrompts["publish-portal-product"],
		parameters: parameters.publishPortalProductParametersSchema,
		category: "portal-management",
		handler: async (args, { api }) => portalManagementOps.publishPortalProduct(api, args.portalId, args),
	},
	{
		method: "unpublish_portal_product",
		name: "Unpublish API Product from Portal",
		description: prompts.portalManagementPrompts["unpublish-portal-product"],
		parameters: parameters.unpublishPortalProductParametersSchema,
		category: "portal-management",
		handler: async (args, { api }) => portalManagementOps.unpublishPortalProduct(api, args.portalId, args.productId),
	},
];
