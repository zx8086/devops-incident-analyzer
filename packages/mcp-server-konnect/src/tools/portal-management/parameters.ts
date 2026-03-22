import { z } from "zod";

// Portal Management Parameters
export const listPortalsParametersSchema = z.object({
	pageSize: z.number().min(1).max(100).optional().describe("Number of portals to return per page (1-100)"),
	pageNumber: z.number().min(1).optional().describe("Page number to retrieve (1-based)"),
});

export const createPortalParametersSchema = z.object({
	name: z.string().min(1).max(100).describe("Name of the developer portal"),
	description: z.string().optional().describe("Description of the portal's purpose"),
	displayName: z.string().optional().describe("Display name shown in the portal UI"),
	isPublic: z.boolean().optional().describe("Whether the portal is publicly accessible"),
	autoApproveDevelopers: z.boolean().optional().describe("Automatically approve new developer registrations"),
	autoApproveApplications: z.boolean().optional().describe("Automatically approve new application registrations"),
	customDomain: z.string().optional().describe("Custom domain for the portal (e.g., portal.company.com)"),
	labels: z.record(z.string()).optional().describe("Custom labels for the portal"),
});

export const getPortalParametersSchema = z.object({
	portalId: z.string().min(1).describe("ID of the portal to retrieve"),
});

export const updatePortalParametersSchema = z.object({
	portalId: z.string().min(1).describe("ID of the portal to update"),
	name: z.string().min(1).max(100).optional().describe("Updated name of the portal"),
	description: z.string().optional().describe("Updated description"),
	displayName: z.string().optional().describe("Updated display name"),
	isPublic: z.boolean().optional().describe("Updated public accessibility setting"),
	autoApproveDevelopers: z.boolean().optional().describe("Updated developer auto-approval setting"),
	autoApproveApplications: z.boolean().optional().describe("Updated application auto-approval setting"),
	customDomain: z.string().optional().describe("Updated custom domain"),
	labels: z.record(z.string()).optional().describe("Updated custom labels"),
});

export const deletePortalParametersSchema = z.object({
	portalId: z.string().min(1).describe("ID of the portal to delete"),
});

export const listPortalProductsParametersSchema = z.object({
	portalId: z.string().min(1).describe("ID of the portal"),
	pageSize: z.number().min(1).max(100).optional().describe("Number of products to return per page"),
	pageNumber: z.number().min(1).optional().describe("Page number to retrieve"),
});

export const publishPortalProductParametersSchema = z.object({
	portalId: z.string().min(1).describe("ID of the portal to publish to"),
	productId: z.string().min(1).describe("ID of the API product to publish"),
	productVersionId: z.string().optional().describe("Specific version ID of the product to publish"),
	description: z.string().optional().describe("Portal-specific description for this API"),
});

export const unpublishPortalProductParametersSchema = z.object({
	portalId: z.string().min(1).describe("ID of the portal"),
	productId: z.string().min(1).describe("ID of the API product to unpublish"),
});

export type ListPortalsParameters = z.infer<typeof listPortalsParametersSchema>;
export type CreatePortalParameters = z.infer<typeof createPortalParametersSchema>;
export type GetPortalParameters = z.infer<typeof getPortalParametersSchema>;
export type UpdatePortalParameters = z.infer<typeof updatePortalParametersSchema>;
export type DeletePortalParameters = z.infer<typeof deletePortalParametersSchema>;
export type ListPortalProductsParameters = z.infer<typeof listPortalProductsParametersSchema>;
export type PublishPortalProductParameters = z.infer<typeof publishPortalProductParametersSchema>;
export type UnpublishPortalProductParameters = z.infer<typeof unpublishPortalProductParametersSchema>;
