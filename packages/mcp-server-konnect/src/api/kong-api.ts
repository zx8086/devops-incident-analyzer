import axios, { type AxiosRequestConfig } from "axios";
import type { ApiRequestFilter, ApiRequestsResponse, TimeRange } from "../types.js";
import { createContextLogger } from "../utils/logger.js";
import { PortalApi, type PortalApiOptions } from "./portal-api.js";

const log = createContextLogger("api");

/**
 * Kong API Regions - Different geographical API endpoints
 */
export const API_REGIONS = {
	US: "us",
	EU: "eu",
	AU: "au",
	ME: "me",
	IN: "in",
} as const;

export interface KongApiOptions {
	apiKey?: string;
	apiRegion?: string;
}

export class KongApi {
	private baseUrl: string;
	private apiKey: string;
	private apiRegion: string;

	constructor(options: KongApiOptions = {}) {
		// Default to US region if not specified
		this.apiRegion = options.apiRegion || process.env.KONNECT_REGION || API_REGIONS.US;
		this.baseUrl = `https://${this.apiRegion}.api.konghq.com/v2`;
		this.apiKey = options.apiKey || process.env.KONNECT_ACCESS_TOKEN || "";

		if (!this.apiKey) {
			log.warn("KONNECT_ACCESS_TOKEN not set in environment - API calls will fail");
		}
	}

	/**
	 * Makes authenticated requests to Kong APIs with consistent error handling
	 */
	async kongRequest<T>(endpoint: string, method = "GET", data: any = null): Promise<T> {
		try {
			const url = `${this.baseUrl}${endpoint}`;
			log.debug({ url }, "Making Kong API request");

			const headers = {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			};

			const config: AxiosRequestConfig = {
				method,
				url,
				headers,
				data: data ? data : undefined,
			};

			const response = await axios(config);
			log.debug({ status: response.status }, "Received Kong API response");
			return response.data;
		} catch (error: any) {
			log.error({ error: error.message }, "Kong API request failed");

			if (error.response) {
				const errorData = error.response.data;
				let errorMessage = `API Error (Status ${error.response.status})`;

				if (typeof errorData === "object") {
					const errorDetails = errorData.message || JSON.stringify(errorData);
					errorMessage += `: ${errorDetails}`;
				} else if (typeof errorData === "string") {
					errorMessage += `: ${errorData.substring(0, 200)}`;
				}

				// Add troubleshooting context based on error type
				if (error.response.status === 401) {
					errorMessage += "\n\nTroubleshooting: Check that KONNECT_ACCESS_TOKEN is set correctly and has not expired.";
				} else if (error.response.status === 403) {
					errorMessage +=
						"\n\nTroubleshooting: Your access token may not have sufficient permissions for this operation.";
				} else if (error.response.status === 404) {
					errorMessage +=
						"\n\nTroubleshooting: The requested resource was not found. Verify the control plane ID and resource ID are correct.";
				} else if (error.response.status === 429) {
					errorMessage += "\n\nTroubleshooting: Rate limit exceeded. Please wait before making more requests.";
				}

				throw new Error(errorMessage);
			} else if (error.request) {
				throw new Error(
					"Network Error: No response received from Kong API. Please check your network connection and API endpoint configuration.",
				);
			} else {
				throw new Error(`Request Error: ${error.message}. Please check your request parameters and try again.`);
			}
		}
	}

	async queryApiRequests(
		timeRange: string,
		filters: ApiRequestFilter[] = [],
		maxResults = 100,
	): Promise<ApiRequestsResponse> {
		const requestBody = {
			time_range: {
				type: "relative",
				time_range: timeRange,
			} as TimeRange,
			filters: filters,
			size: maxResults,
		};

		return this.kongRequest<ApiRequestsResponse>("/api-requests", "POST", requestBody);
	}

	async listControlPlanes(
		pageSize = 10,
		pageNumber?: number,
		filterName?: string,
		filterClusterType?: string,
		filterCloudGateway?: boolean,
		labels?: string,
		sort?: string,
	): Promise<any> {
		let endpoint = `/control-planes?page[size]=${pageSize}`;

		if (pageNumber) {
			endpoint += `&page[number]=${pageNumber}`;
		}

		if (filterName) {
			endpoint += `&filter[name][contains]=${encodeURIComponent(filterName)}`;
		}

		if (filterClusterType) {
			endpoint += `&filter[cluster_type][eq]=${encodeURIComponent(filterClusterType)}`;
		}

		if (filterCloudGateway !== undefined) {
			endpoint += `&filter[cloud_gateway]=${filterCloudGateway}`;
		}

		if (labels) {
			endpoint += `&labels=${encodeURIComponent(labels)}`;
		}

		if (sort) {
			endpoint += `&sort=${encodeURIComponent(sort)}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async getControlPlane(controlPlaneId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}`);
	}

	async listControlPlaneGroupMemberships(groupId: string, pageSize = 10, pageAfter?: string): Promise<any> {
		let endpoint = `/control-planes/${groupId}/group-memberships?page[size]=${pageSize}`;

		if (pageAfter) {
			endpoint += `&page[after]=${pageAfter}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async checkControlPlaneGroupMembership(controlPlaneId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/group-member-status`);
	}

	async createControlPlane(controlPlaneData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes`, "POST", controlPlaneData);
	}

	async updateControlPlane(controlPlaneId: string, controlPlaneData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}`, "PATCH", controlPlaneData);
	}

	async deleteControlPlane(controlPlaneId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}`, "DELETE");
	}

	// Data Plane Node Management (deprecated - using newer /nodes endpoint below)

	async createDataPlaneToken(controlPlaneId: string, tokenData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/tokens`, "POST", tokenData);
	}

	async listDataPlaneTokens(controlPlaneId: string, pageSize = 10, pageNumber?: number): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/tokens?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;

		return this.kongRequest<any>(endpoint);
	}

	async revokeDataPlaneToken(controlPlaneId: string, tokenId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/tokens/${tokenId}`, "DELETE");
	}

	async getControlPlaneConfig(controlPlaneId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/config`);
	}

	async updateControlPlaneConfig(controlPlaneId: string, configData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/config`, "PATCH", configData);
	}

	async listServices(controlPlaneId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/services?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async getService(controlPlaneId: string, serviceId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/services/${serviceId}`);
	}

	async createService(controlPlaneId: string, serviceData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/services`, "POST", serviceData);
	}

	async updateService(controlPlaneId: string, serviceId: string, serviceData: any): Promise<any> {
		return this.kongRequest<any>(
			`/control-planes/${controlPlaneId}/core-entities/services/${serviceId}`,
			"PUT",
			serviceData,
		);
	}

	async deleteService(controlPlaneId: string, serviceId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/services/${serviceId}`, "DELETE");
	}

	async listRoutes(controlPlaneId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/routes?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async getRoute(controlPlaneId: string, routeId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/routes/${routeId}`);
	}

	async createRoute(controlPlaneId: string, routeData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/routes`, "POST", routeData);
	}

	async updateRoute(controlPlaneId: string, routeId: string, routeData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/routes/${routeId}`, "PUT", routeData);
	}

	async deleteRoute(controlPlaneId: string, routeId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/routes/${routeId}`, "DELETE");
	}

	async listConsumers(controlPlaneId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/consumers?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async createConsumer(controlPlaneId: string, consumerData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/consumers`, "POST", consumerData);
	}

	async getConsumer(controlPlaneId: string, consumerId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}`);
	}

	async updateConsumer(controlPlaneId: string, consumerId: string, consumerData: any): Promise<any> {
		return this.kongRequest<any>(
			`/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}`,
			"PUT",
			consumerData,
		);
	}

	async deleteConsumer(controlPlaneId: string, consumerId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}`, "DELETE");
	}

	async listPlugins(controlPlaneId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/plugins?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async getPlugin(controlPlaneId: string, pluginId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/plugins/${pluginId}`);
	}

	async createPlugin(controlPlaneId: string, pluginData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/plugins`, "POST", pluginData);
	}

	async updatePlugin(controlPlaneId: string, pluginId: string, pluginData: any): Promise<any> {
		return this.kongRequest<any>(
			`/control-planes/${controlPlaneId}/core-entities/plugins/${pluginId}`,
			"PUT",
			pluginData,
		);
	}

	async deletePlugin(controlPlaneId: string, pluginId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/plugins/${pluginId}`, "DELETE");
	}

	async listPluginSchemas(controlPlaneId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/plugin-schemas`);
	}

	async listCertificates(controlPlaneId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/certificates?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async getCertificate(controlPlaneId: string, certificateId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/certificates/${certificateId}`);
	}

	async createCertificate(controlPlaneId: string, certificateData: any): Promise<any> {
		return this.kongRequest<any>(
			`/control-planes/${controlPlaneId}/core-entities/certificates`,
			"POST",
			certificateData,
		);
	}

	async updateCertificate(controlPlaneId: string, certificateId: string, certificateData: any): Promise<any> {
		return this.kongRequest<any>(
			`/control-planes/${controlPlaneId}/core-entities/certificates/${certificateId}`,
			"PUT",
			certificateData,
		);
	}

	async deleteCertificate(controlPlaneId: string, certificateId: string): Promise<any> {
		return this.kongRequest<any>(
			`/control-planes/${controlPlaneId}/core-entities/certificates/${certificateId}`,
			"DELETE",
		);
	}

	async listUpstreams(controlPlaneId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/upstreams?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async getUpstream(controlPlaneId: string, upstreamId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/upstreams/${upstreamId}`);
	}

	async listUpstreamTargets(controlPlaneId: string, upstreamId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/upstreams/${upstreamId}/targets?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async getUpstreamHealth(controlPlaneId: string, upstreamId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/upstreams/${upstreamId}/health`);
	}

	async listDataPlaneNodes(
		controlPlaneId: string,
		pageSize = 10,
		pageNumber?: number,
		filterStatus?: string,
		filterHostname?: string,
	): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/nodes?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		if (filterStatus) endpoint += `&filter[status][eq]=${filterStatus}`;
		if (filterHostname) endpoint += `&filter[hostname][contains]=${encodeURIComponent(filterHostname)}`;

		return this.kongRequest<any>(endpoint);
	}

	async getDataPlaneNode(controlPlaneId: string, nodeId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/nodes/${nodeId}`);
	}

	async deleteDataPlaneNode(controlPlaneId: string, nodeId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/nodes/${nodeId}`, "DELETE");
	}

	async getExpectedConfigHash(controlPlaneId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/expected-config-hash`);
	}

	async listSNIs(controlPlaneId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/snis?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async createSNI(controlPlaneId: string, sniData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/snis`, "POST", sniData);
	}

	async listConsumerKeys(controlPlaneId: string, consumerId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}/key-auth?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async createConsumerKey(controlPlaneId: string, consumerId: string, keyData: any): Promise<any> {
		return this.kongRequest<any>(
			`/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}/key-auth`,
			"POST",
			keyData,
		);
	}

	async deleteConsumerKey(controlPlaneId: string, consumerId: string, keyId: string): Promise<any> {
		return this.kongRequest<any>(
			`/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}/key-auth/${keyId}`,
			"DELETE",
		);
	}

	async listPortalApis(
		pageSize = 10,
		pageNumber?: number,
		filterName?: string,
		filterStatus?: string,
		sort?: string,
	): Promise<any> {
		let endpoint = `/portal/apis?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		if (filterName) endpoint += `&filter[name][contains]=${encodeURIComponent(filterName)}`;
		if (filterStatus) endpoint += `&filter[status][eq]=${filterStatus}`;
		if (sort) endpoint += `&sort=${encodeURIComponent(sort)}`;

		return this.kongRequest<any>(endpoint);
	}

	async fetchPortalApi(apiIdOrSlug: string): Promise<any> {
		return this.kongRequest<any>(`/portal/apis/${apiIdOrSlug}`);
	}

	async getPortalApiActions(apiIdOrSlug: string): Promise<any> {
		return this.kongRequest<any>(`/portal/apis/${apiIdOrSlug}/actions`);
	}

	async listPortalApiDocuments(apiIdOrSlug: string): Promise<any> {
		return this.kongRequest<any>(`/portal/apis/${apiIdOrSlug}/documents`);
	}

	async fetchPortalApiDocument(apiIdOrSlug: string, documentIdOrSlug: string, format = "json"): Promise<any> {
		const _headers = {
			Accept:
				format === "yaml"
					? "application/yaml"
					: format === "html"
						? "text/html"
						: format === "markdown"
							? "text/markdown"
							: "application/json",
		};
		return this.kongRequest<any>(`/portal/apis/${apiIdOrSlug}/documents/${documentIdOrSlug}`, "GET");
	}

	async listPortalApplications(
		pageSize = 10,
		pageNumber?: number,
		filterName?: string,
		filterAuthStrategy?: string,
	): Promise<any> {
		let endpoint = `/api/v3/applications?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		if (filterName) endpoint += `&filter[name][contains]=${encodeURIComponent(filterName)}`;
		if (filterAuthStrategy) endpoint += `&filter[auth_strategy_id][eq]=${filterAuthStrategy}`;

		return this.kongRequest<any>(endpoint);
	}

	async createPortalApplication(applicationData: any): Promise<any> {
		return this.kongRequest<any>(`/api/v3/applications`, "POST", applicationData);
	}

	async getPortalApplication(applicationId: string): Promise<any> {
		return this.kongRequest<any>(`/api/v3/applications/${applicationId}`);
	}

	async updatePortalApplication(applicationId: string, applicationData: any): Promise<any> {
		return this.kongRequest<any>(`/api/v3/applications/${applicationId}`, "PATCH", applicationData);
	}

	async deletePortalApplication(applicationId: string): Promise<any> {
		return this.kongRequest<any>(`/api/v3/applications/${applicationId}`, "DELETE");
	}

	async listPortalApplicationRegistrations(
		applicationId: string,
		pageSize = 10,
		pageNumber?: number,
		filterStatus?: string,
		filterApiName?: string,
	): Promise<any> {
		let endpoint = `/api/v3/applications/${applicationId}/registrations?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		if (filterStatus) endpoint += `&filter[status][eq]=${filterStatus}`;
		if (filterApiName) endpoint += `&filter[api_name][contains]=${encodeURIComponent(filterApiName)}`;

		return this.kongRequest<any>(endpoint);
	}

	async createPortalApplicationRegistration(applicationId: string, registrationData: any): Promise<any> {
		return this.kongRequest<any>(`/api/v3/applications/${applicationId}/registrations`, "POST", registrationData);
	}

	async getPortalApplicationRegistration(applicationId: string, registrationId: string): Promise<any> {
		return this.kongRequest<any>(`/api/v3/applications/${applicationId}/registrations/${registrationId}`);
	}

	async deletePortalApplicationRegistration(applicationId: string, registrationId: string): Promise<any> {
		return this.kongRequest<any>(`/api/v3/applications/${applicationId}/registrations/${registrationId}`, "DELETE");
	}

	async listPortalCredentials(applicationId: string, pageSize = 10, pageNumber?: number): Promise<any> {
		let endpoint = `/api/v3/applications/${applicationId}/credentials?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;

		return this.kongRequest<any>(endpoint);
	}

	async createPortalCredential(applicationId: string, credentialData: any): Promise<any> {
		return this.kongRequest<any>(`/api/v3/applications/${applicationId}/credentials`, "POST", credentialData);
	}

	async updatePortalCredential(applicationId: string, credentialId: string, credentialData: any): Promise<any> {
		return this.kongRequest<any>(
			`/api/v3/applications/${applicationId}/credentials/${credentialId}`,
			"PATCH",
			credentialData,
		);
	}

	async deletePortalCredential(applicationId: string, credentialId: string): Promise<any> {
		return this.kongRequest<any>(`/api/v3/applications/${applicationId}/credentials/${credentialId}`, "DELETE");
	}

	async regeneratePortalApplicationSecret(applicationId: string): Promise<any> {
		return this.kongRequest<any>(`/api/v3/applications/${applicationId}/regenerate-secret`, "POST");
	}

	async registerPortalDeveloper(developerData: any): Promise<any> {
		return this.kongRequest<any>(`/api/v3/register`, "POST", developerData);
	}

	async authenticatePortalDeveloper(credentials: any): Promise<any> {
		return this.kongRequest<any>(`/api/v3/authenticate`, "POST", credentials);
	}

	async getPortalDeveloperMe(): Promise<any> {
		return this.kongRequest<any>(`/api/v3/me`);
	}

	async logoutPortalDeveloper(): Promise<any> {
		return this.kongRequest<any>(`/api/v3/logout`, "POST");
	}

	async queryPortalApplicationAnalytics(applicationId: string, analyticsQuery: any): Promise<any> {
		return this.kongRequest<any>(`/api/v3/applications/${applicationId}/analytics`, "POST", analyticsQuery);
	}

	async listPortals(pageSize = 10, pageNumber?: number): Promise<any> {
		let endpoint = `/portals?page[size]=${pageSize}`;
		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		return this.kongRequest<any>(endpoint);
	}

	async createPortal(portalData: any): Promise<any> {
		return this.kongRequest<any>(`/portals`, "POST", portalData);
	}

	async getPortal(portalId: string): Promise<any> {
		return this.kongRequest<any>(`/portals/${portalId}`);
	}

	async updatePortal(portalId: string, portalData: any): Promise<any> {
		return this.kongRequest<any>(`/portals/${portalId}`, "PATCH", portalData);
	}

	async deletePortal(portalId: string): Promise<any> {
		return this.kongRequest<any>(`/portals/${portalId}`, "DELETE");
	}

	async listPortalProducts(portalId: string, pageSize = 10, pageNumber?: number): Promise<any> {
		let endpoint = `/portals/${portalId}/products?page[size]=${pageSize}`;
		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		return this.kongRequest<any>(endpoint);
	}

	async publishPortalProduct(portalId: string, productData: any): Promise<any> {
		return this.kongRequest<any>(`/portals/${portalId}/products`, "POST", productData);
	}

	async unpublishPortalProduct(portalId: string, productId: string): Promise<any> {
		return this.kongRequest<any>(`/portals/${portalId}/products/${productId}`, "DELETE");
	}

	/**
	 * Create a Portal API client for portal-specific operations
	 * This handles operations that require the portal domain rather than management API
	 */
	async createPortalClient(portalId: string, options?: Partial<PortalApiOptions>): Promise<PortalApi> {
		// Fetch portal info to get the correct domain
		const portalInfo = await this.getPortal(portalId);

		const portalOptions: PortalApiOptions = {
			apiKey: options?.apiKey || this.apiKey,
			apiRegion: options?.apiRegion || this.apiRegion,
			portalDomain: portalInfo.default_domain,
		};

		return new PortalApi(portalId, portalOptions);
	}

	// Legacy synchronous method for backward compatibility
	createPortalClientSync(portalId: string, options?: Partial<PortalApiOptions>): PortalApi {
		const portalOptions: PortalApiOptions = {
			apiKey: options?.apiKey || this.apiKey,
			apiRegion: options?.apiRegion || this.apiRegion,
		};

		return new PortalApi(portalId, portalOptions);
	}

	// Portal application methods are available via createPortalClient(portalId)
}
