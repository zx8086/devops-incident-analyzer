import axios, { type AxiosRequestConfig } from "axios";
import type { ApiRequestFilter, ApiRequestsResponse, TimeRange } from "./types.js";
import { mcpLogger } from "./utils/mcp-logger.js";

/**
 * Kong API Regions - Different geographical API endpoints
 */
export const API_REGIONS = {
	US: "us",
	EU: "eu",
	AU: "au",
	ME: "me",
	IN: "in",
};

export interface KongApiOptions {
	apiKey?: string;
	apiRegion?: string;
}

export class KongApi {
	private baseUrl: string;
	private apiKey: string;

	constructor(options: KongApiOptions = {}) {
		// Default to US region if not specified
		const apiRegion = options.apiRegion || process.env.KONNECT_REGION || API_REGIONS.US;
		this.baseUrl = `https://${apiRegion}.api.konghq.com/v2`;
		this.apiKey = options.apiKey || process.env.KONNECT_ACCESS_TOKEN || "";

		if (!this.apiKey) {
			mcpLogger.warning("api", "KONNECT_ACCESS_TOKEN not set in environment - API calls will fail");
		}
	}

	/**
	 * Makes authenticated requests to Kong APIs with consistent error handling
	 */
	async kongRequest<T>(endpoint: string, method = "GET", data: any = null): Promise<T> {
		try {
			const url = `${this.baseUrl}${endpoint}`;
			mcpLogger.debug("api", "Making Kong API request", { url });

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
			mcpLogger.debug("api", "Received Kong API response", {
				status: response.status,
			});
			return response.data;
		} catch (error: any) {
			mcpLogger.error("api", "Kong API request failed", {
				error: error.message,
			});

			if (error.response) {
				const errorData = error.response.data;
				let errorMessage = `API Error (Status ${error.response.status})`;

				if (typeof errorData === "object") {
					const errorDetails = errorData.message || JSON.stringify(errorData);
					errorMessage += `: ${errorDetails}`;
				} else if (typeof errorData === "string") {
					errorMessage += `: ${errorData.substring(0, 200)}`;
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

	// Analytics API methods
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

	// Control Planes API methods
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

	// Configuration API methods
	async listServices(controlPlaneId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/services?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async listRoutes(controlPlaneId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/routes?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async listConsumers(controlPlaneId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/consumers?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	async listPlugins(controlPlaneId: string, size = 100, offset?: string): Promise<any> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/plugins?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<any>(endpoint);
	}

	// Service CRUD operations
	async createService(controlPlaneId: string, serviceData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/services`, "POST", serviceData);
	}

	async getService(controlPlaneId: string, serviceId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/services/${serviceId}`);
	}

	async updateService(controlPlaneId: string, serviceId: string, serviceData: any): Promise<any> {
		return this.kongRequest<any>(
			`/control-planes/${controlPlaneId}/core-entities/services/${serviceId}`,
			"PATCH",
			serviceData,
		);
	}

	async deleteService(controlPlaneId: string, serviceId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/services/${serviceId}`, "DELETE");
	}

	// Route CRUD operations
	async createRoute(controlPlaneId: string, routeData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/routes`, "POST", routeData);
	}

	async getRoute(controlPlaneId: string, routeId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/routes/${routeId}`);
	}

	async updateRoute(controlPlaneId: string, routeId: string, routeData: any): Promise<any> {
		return this.kongRequest<any>(
			`/control-planes/${controlPlaneId}/core-entities/routes/${routeId}`,
			"PATCH",
			routeData,
		);
	}

	async deleteRoute(controlPlaneId: string, routeId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/routes/${routeId}`, "DELETE");
	}

	// Consumer CRUD operations
	async createConsumer(controlPlaneId: string, consumerData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/consumers`, "POST", consumerData);
	}

	async getConsumer(controlPlaneId: string, consumerId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}`);
	}

	async updateConsumer(controlPlaneId: string, consumerId: string, consumerData: any): Promise<any> {
		return this.kongRequest<any>(
			`/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}`,
			"PATCH",
			consumerData,
		);
	}

	async deleteConsumer(controlPlaneId: string, consumerId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}`, "DELETE");
	}

	// Plugin CRUD operations
	async createPlugin(controlPlaneId: string, pluginData: any): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/plugins`, "POST", pluginData);
	}

	async getPlugin(controlPlaneId: string, pluginId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/plugins/${pluginId}`);
	}

	async updatePlugin(controlPlaneId: string, pluginId: string, pluginData: any): Promise<any> {
		return this.kongRequest<any>(
			`/control-planes/${controlPlaneId}/core-entities/plugins/${pluginId}`,
			"PATCH",
			pluginData,
		);
	}

	async deletePlugin(controlPlaneId: string, pluginId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/core-entities/plugins/${pluginId}`, "DELETE");
	}

	async listPluginSchemas(controlPlaneId: string): Promise<any> {
		return this.kongRequest<any>(`/control-planes/${controlPlaneId}/schemas/plugins`);
	}
}
