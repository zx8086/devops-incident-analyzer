import type { MCPTool } from "../registry.js";
import * as portalManagementOps from "./operations.js";
import * as parameters from "./parameters.js";
import type {
	CreatePortalParameters,
	DeletePortalParameters,
	GetPortalParameters,
	ListPortalProductsParameters,
	ListPortalsParameters,
	PublishPortalProductParameters,
	UnpublishPortalProductParameters,
	UpdatePortalParameters,
} from "./parameters.js";
import * as prompts from "./prompts.js";

export const portalManagementTools = (): MCPTool[] => [
	{
		method: "list_portals",
		name: "List Developer Portals",
		description: prompts.portalManagementPrompts["list-portals"],
		parameters: parameters.listPortalsParametersSchema,
		category: "portal-management",
		handler: async (args: ListPortalsParameters, { api }) =>
			portalManagementOps.listPortals(api, args.pageSize, args.pageNumber),
	},
	{
		method: "create_portal",
		name: "Create Developer Portal",
		description: prompts.portalManagementPrompts["create-portal"],
		parameters: parameters.createPortalParametersSchema,
		category: "portal-management",
		handler: async (args: CreatePortalParameters, { api }) => portalManagementOps.createPortal(api, args),
	},
	{
		method: "get_portal",
		name: "Get Portal Details",
		description: prompts.portalManagementPrompts["get-portal"],
		parameters: parameters.getPortalParametersSchema,
		category: "portal-management",
		handler: async (args: GetPortalParameters, { api }) => portalManagementOps.getPortal(api, args.portalId),
	},
	{
		method: "update_portal",
		name: "Update Portal Configuration",
		description: prompts.portalManagementPrompts["update-portal"],
		parameters: parameters.updatePortalParametersSchema,
		category: "portal-management",
		handler: async (args: UpdatePortalParameters, { api }) => portalManagementOps.updatePortal(api, args.portalId, args),
	},
	{
		method: "delete_portal",
		name: "Delete Developer Portal",
		description: prompts.portalManagementPrompts["delete-portal"],
		parameters: parameters.deletePortalParametersSchema,
		category: "portal-management",
		handler: async (args: DeletePortalParameters, { api }) => portalManagementOps.deletePortal(api, args.portalId),
	},
	{
		method: "list_portal_products",
		name: "List Portal Published Products",
		description: prompts.portalManagementPrompts["list-portal-products"],
		parameters: parameters.listPortalProductsParametersSchema,
		category: "portal-management",
		handler: async (args: ListPortalProductsParameters, { api }) =>
			portalManagementOps.listPortalProducts(api, args.portalId, args.pageSize, args.pageNumber),
	},
	{
		method: "publish_portal_product",
		name: "Publish API Product to Portal",
		description: prompts.portalManagementPrompts["publish-portal-product"],
		parameters: parameters.publishPortalProductParametersSchema,
		category: "portal-management",
		handler: async (args: PublishPortalProductParameters, { api }) =>
			portalManagementOps.publishPortalProduct(api, args.portalId, args),
	},
	{
		method: "unpublish_portal_product",
		name: "Unpublish API Product from Portal",
		description: prompts.portalManagementPrompts["unpublish-portal-product"],
		parameters: parameters.unpublishPortalProductParametersSchema,
		category: "portal-management",
		handler: async (args: UnpublishPortalProductParameters, { api }) =>
			portalManagementOps.unpublishPortalProduct(api, args.portalId, args.productId),
	},
];
