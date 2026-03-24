import type { KongApi } from "../../api/kong-api.js";
import { mcpLogger } from "../../utils/mcp-logger.js";

export async function listPortals(api: KongApi, pageSize = 10, pageNumber?: number) {
	mcpLogger.debug("tools", "Listing portals", { pageSize });
	try {
		const result = await api.listPortals(pageSize, pageNumber);

		return {
			metadata: {
				pagination: {
					pageSize: pageSize,
					pageNumber: pageNumber || 1,
					totalPages: result.meta?.page?.total || 1,
					totalItems: result.meta?.page?.total_count || 0,
				},
			},
			portals:
				result.data?.map((portal: any) => ({
					portalId: portal.id,
					name: portal.name,
					description: portal.description,
					displayName: portal.display_name,
					isPublic: portal.is_public,
					autoApproveDevelopers: portal.auto_approve_developers,
					autoApproveApplications: portal.auto_approve_applications,
					defaultDomain: portal.default_domain,
					customDomain: portal.custom_domain,
					statistics: {
						developerCount: portal.developer_count || 0,
						applicationCount: portal.application_count || 0,
						publishedProductCount: portal.published_product_count || 0,
					},
					metadata: {
						createdAt: portal.created_at,
						updatedAt: portal.updated_at,
					},
				})) || [],
			relatedTools: [
				"Use create-portal to create a new developer portal",
				"Use get-portal for detailed portal information",
				"Use update-portal to modify portal settings",
			],
		};
	} catch (error) {
		throw error;
	}
}

export async function createPortal(
	api: KongApi,
	portalData: {
		name: string;
		description?: string;
		displayName?: string;
		isPublic?: boolean;
		autoApproveDevelopers?: boolean;
		autoApproveApplications?: boolean;
		customDomain?: string;
		labels?: Record<string, string>;
	},
) {
	mcpLogger.debug("tools", "Creating portal", { name: portalData.name });
	try {
		const requestData = {
			name: portalData.name,
			description: portalData.description,
			display_name: portalData.displayName || portalData.name,
			is_public: portalData.isPublic || false,
			auto_approve_developers: portalData.autoApproveDevelopers || true,
			auto_approve_applications: portalData.autoApproveApplications || true,
			custom_domain: portalData.customDomain,
			labels: portalData.labels || {},
		};

		const result = await api.createPortal(requestData);

		return {
			success: true,
			portal: {
				portalId: result.id,
				name: result.name,
				description: result.description,
				displayName: result.display_name,
				defaultDomain: result.default_domain,
				customDomain: result.custom_domain,
				isPublic: result.is_public,
				autoApproveDevelopers: result.auto_approve_developers,
				autoApproveApplications: result.auto_approve_applications,
				metadata: {
					createdAt: result.created_at,
				},
			},
			message: `Developer portal '${result.name}' created successfully`,
			nextSteps: [
				"Portal URL: " + result.default_domain,
				"Use publish-portal-product to add APIs to the portal",
				"Use register-developer to create developer accounts",
			],
			relatedTools: [
				"Use publish-portal-product to add Flight API to the portal",
				"Use list-portal-products to see published APIs",
				"Use get-portal to view complete portal details",
			],
		};
	} catch (error) {
		throw error;
	}
}

export async function getPortal(api: KongApi, portalId: string) {
	mcpLogger.debug("tools", "Getting portal", { portalId });
	try {
		const result = await api.getPortal(portalId);

		return {
			portal: {
				portalId: result.id,
				name: result.name,
				description: result.description,
				displayName: result.display_name,
				isPublic: result.is_public,
				rbacEnabled: result.rbac_enabled,
				autoApproveDevelopers: result.auto_approve_developers,
				autoApproveApplications: result.auto_approve_applications,
				domains: {
					defaultDomain: result.default_domain,
					customDomain: result.custom_domain,
					customClientDomain: result.custom_client_domain,
				},
				authentication: {
					defaultAuthStrategyId: result.default_application_auth_strategy_id,
				},
				statistics: {
					developerCount: result.developer_count || 0,
					applicationCount: result.application_count || 0,
					publishedProductCount: result.published_product_count || 0,
				},
				labels: result.labels || {},
				metadata: {
					createdAt: result.created_at,
					updatedAt: result.updated_at,
				},
			},
			relatedTools: [
				"Use update-portal to modify portal settings",
				"Use list-portal-products to see published APIs",
				"Use register-developer to add developers",
			],
		};
	} catch (error) {
		throw error;
	}
}

/**
 * Update portal configuration
 */
export async function updatePortal(
	api: KongApi,
	portalId: string,
	portalData: {
		name?: string;
		description?: string;
		displayName?: string;
		isPublic?: boolean;
		autoApproveDevelopers?: boolean;
		autoApproveApplications?: boolean;
		customDomain?: string;
		labels?: Record<string, string>;
	},
) {
	mcpLogger.debug("tools", "Updating portal", { portalId });
	try {
		const requestData: any = {};

		if (portalData.name !== undefined) requestData.name = portalData.name;
		if (portalData.description !== undefined) requestData.description = portalData.description;
		if (portalData.displayName !== undefined) requestData.display_name = portalData.displayName;
		if (portalData.isPublic !== undefined) requestData.is_public = portalData.isPublic;
		if (portalData.autoApproveDevelopers !== undefined)
			requestData.auto_approve_developers = portalData.autoApproveDevelopers;
		if (portalData.autoApproveApplications !== undefined)
			requestData.auto_approve_applications = portalData.autoApproveApplications;
		if (portalData.customDomain !== undefined) requestData.custom_domain = portalData.customDomain;
		if (portalData.labels !== undefined) requestData.labels = portalData.labels;

		const result = await api.updatePortal(portalId, requestData);

		return {
			success: true,
			portal: {
				portalId: result.id,
				name: result.name,
				description: result.description,
				displayName: result.display_name,
				isPublic: result.is_public,
				autoApproveDevelopers: result.auto_approve_developers,
				autoApproveApplications: result.auto_approve_applications,
				customDomain: result.custom_domain,
				labels: result.labels,
				metadata: {
					updatedAt: result.updated_at,
				},
			},
			message: "Portal updated successfully",
			relatedTools: ["Use get-portal to see all updated details"],
		};
	} catch (error) {
		throw error;
	}
}

/**
 * Delete a developer portal
 */
export async function deletePortal(api: KongApi, portalId: string) {
	mcpLogger.debug("tools", "Deleting portal", { portalId });
	try {
		await api.deletePortal(portalId);

		return {
			success: true,
			message: `Portal ${portalId} deleted successfully`,
			warning:
				"WARNING: All portal data, developers, applications, and published products have been permanently removed",
			relatedTools: ["Use list-portals to see remaining portals", "Use create-portal to create a new portal"],
		};
	} catch (error) {
		throw error;
	}
}

/**
 * List products published to a portal
 */
export async function listPortalProducts(api: KongApi, portalId: string, pageSize = 10, pageNumber?: number) {
	mcpLogger.debug("tools", "Listing portal products", { portalId, pageSize });
	try {
		const result = await api.listPortalProducts(portalId, pageSize, pageNumber);

		return {
			metadata: {
				portalId: portalId,
				pagination: {
					pageSize: pageSize,
					pageNumber: pageNumber || 1,
					totalPages: result.meta?.page?.total || 1,
					totalItems: result.meta?.page?.total_count || 0,
				},
			},
			products:
				result.data?.map((product: any) => ({
					productId: product.id,
					name: product.name,
					description: product.description,
					version: product.version,
					status: product.status,
					publishedAt: product.published_at,
					apiCount: product.api_count || 0,
					applicationRegistrations: product.application_registration_count || 0,
				})) || [],
			relatedTools: [
				"Use publish-portal-product to add more APIs",
				"Use unpublish-portal-product to remove APIs",
				"Use fetch-api to get API details",
			],
		};
	} catch (error) {
		throw error;
	}
}

/**
 * Publish an API product to the portal
 */
export async function publishPortalProduct(
	api: KongApi,
	portalId: string,
	productData: {
		productId: string;
		productVersionId?: string;
		description?: string;
	},
) {
	mcpLogger.debug("tools", "Publishing portal product", { portalId, productId: productData.productId });
	try {
		const requestData = {
			product_id: productData.productId,
			product_version_id: productData.productVersionId,
			description: productData.description,
		};

		const result = await api.publishPortalProduct(portalId, requestData);

		return {
			success: true,
			publication: {
				publicationId: result.id,
				productId: result.product_id,
				productName: result.product_name,
				status: result.status,
				publishedAt: result.published_at,
			},
			message: `API product published to portal successfully`,
			relatedTools: [
				"Use list-portal-products to see all published APIs",
				"Use create-application to register applications for this API",
			],
		};
	} catch (error) {
		throw error;
	}
}

/**
 * Unpublish an API product from the portal
 */
export async function unpublishPortalProduct(api: KongApi, portalId: string, productId: string) {
	mcpLogger.debug("tools", "Unpublishing portal product", { portalId, productId });
	try {
		await api.unpublishPortalProduct(portalId, productId);

		return {
			success: true,
			message: `API product ${productId} unpublished from portal`,
			warning: "Existing application registrations for this API remain active",
			relatedTools: ["Use list-portal-products to see remaining published APIs"],
		};
	} catch (error) {
		throw error;
	}
}
