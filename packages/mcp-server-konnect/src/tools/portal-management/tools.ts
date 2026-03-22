import type { z } from "zod";
import * as parameters from "./parameters.js";
import * as prompts from "./prompts.js";

export type PortalManagementTool = {
  method: string;
  name: string;
  description: string;
  parameters: z.ZodObject<any, any, any, any>;
  category: string;
};

export const portalManagementTools = (): PortalManagementTool[] => [
  // =========================
  // Portal Management
  // =========================
  {
    method: "list_portals",
    name: "List Developer Portals",
    description: prompts.portalManagementPrompts["list-portals"],
    parameters: parameters.listPortalsParametersSchema,
    category: "portal-management",
  },
  {
    method: "create_portal",
    name: "Create Developer Portal",
    description: prompts.portalManagementPrompts["create-portal"],
    parameters: parameters.createPortalParametersSchema,
    category: "portal-management",
  },
  {
    method: "get_portal",
    name: "Get Portal Details",
    description: prompts.portalManagementPrompts["get-portal"],
    parameters: parameters.getPortalParametersSchema,
    category: "portal-management",
  },
  {
    method: "update_portal",
    name: "Update Portal Configuration",
    description: prompts.portalManagementPrompts["update-portal"],
    parameters: parameters.updatePortalParametersSchema,
    category: "portal-management",
  },
  {
    method: "delete_portal",
    name: "Delete Developer Portal",
    description: prompts.portalManagementPrompts["delete-portal"],
    parameters: parameters.deletePortalParametersSchema,
    category: "portal-management",
  },
  {
    method: "list_portal_products",
    name: "List Portal Published Products",
    description: prompts.portalManagementPrompts["list-portal-products"],
    parameters: parameters.listPortalProductsParametersSchema,
    category: "portal-management",
  },
  {
    method: "publish_portal_product",
    name: "Publish API Product to Portal",
    description: prompts.portalManagementPrompts["publish-portal-product"],
    parameters: parameters.publishPortalProductParametersSchema,
    category: "portal-management",
  },
  {
    method: "unpublish_portal_product",
    name: "Unpublish API Product from Portal",
    description: prompts.portalManagementPrompts["unpublish-portal-product"],
    parameters: parameters.unpublishPortalProductParametersSchema,
    category: "portal-management",
  },
];
