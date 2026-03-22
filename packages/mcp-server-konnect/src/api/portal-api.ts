import axios, { type AxiosRequestConfig } from "axios";
import { mcpLogger } from "../utils/mcp-logger.js";
import { API_REGIONS } from "./kong-api.js";

export interface PortalApiOptions {
	apiKey?: string;
	apiRegion?: string;
	portalDomain?: string; // Allow explicit portal domain override
}

/**
 * Portal API Client for Kong Konnect Developer Portal endpoints
 *
 * This client handles portal-specific operations that require
 * the portal domain (e.g., {portalId}.{region}.kongportals.com)
 * rather than the management API domain.
 */
export class PortalApi {
	private baseUrl: string;
	private apiKey: string;
	private portalId: string;
	private region: string;

	constructor(portalId: string, options: PortalApiOptions = {}) {
		this.portalId = portalId;
		this.region = options.apiRegion || process.env.KONNECT_REGION || API_REGIONS.US;

		// Use explicit domain if provided, otherwise construct from portalId
		if (options.portalDomain) {
			this.baseUrl = `https://${options.portalDomain}`;
		} else {
			// Use the correct portal domain format: {portal-subdomain}.{region}.portal.konghq.com
			this.baseUrl = `https://${portalId}.${this.region}.portal.konghq.com`;
		}

		this.apiKey = options.apiKey || process.env.KONNECT_ACCESS_TOKEN || "";

		if (!this.apiKey) {
			mcpLogger.warning("api", "KONNECT_ACCESS_TOKEN not set in environment - Portal API calls will fail");
		}

		if (!portalId) {
			throw new Error("Portal ID is required for Portal API client");
		}
	}

	/**
	 * Makes authenticated requests to Portal APIs with consistent error handling
	 */
	async portalRequest<T>(endpoint: string, method = "GET", data: any = null): Promise<T> {
		try {
			const url = `${this.baseUrl}${endpoint}`;
			mcpLogger.debug("api", "Making portal API request", { url });

			const headers = {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			};

			const config: AxiosRequestConfig = {
				method: method as any,
				url,
				headers,
				timeout: 30000,
			};

			if (data && (method === "POST" || method === "PUT" || method === "PATCH")) {
				config.data = data;
			}

			const response = await axios(config);
			mcpLogger.debug("api", "Received portal API response", {
				status: response.status,
			});
			return response.data;
		} catch (error: any) {
			mcpLogger.error("api", "Portal API request failed", {
				error: error.message,
			});

			let errorMessage = `Portal API Error`;

			if (error.response) {
				const status = error.response.status;
				const data = error.response.data;

				errorMessage += ` (Status ${status}): ${JSON.stringify(data)}`;

				if (status === 401) {
					errorMessage +=
						"\n\nTroubleshooting: Check that KONNECT_ACCESS_TOKEN is set correctly and has portal access permissions.";
				} else if (status === 404) {
					errorMessage += `\n\nTroubleshooting: Portal ${this.portalId} may not exist or endpoint ${endpoint} may not be available.`;
				} else if (status === 403) {
					errorMessage += "\n\nTroubleshooting: Token may not have permission to access this portal or resource.";
				} else if (status === 429) {
					errorMessage += "\n\nTroubleshooting: Rate limit exceeded. Please wait before making more requests.";
				}

				throw new Error(errorMessage);
			} else if (error.request) {
				errorMessage += `: Network error - could not reach portal ${this.portalId}.${this.region}.kongportals.com`;
				errorMessage += "\n\nTroubleshooting: Check internet connection and portal domain accessibility.";
			} else {
				errorMessage += `: ${error.message}`;
			}

			throw new Error(errorMessage);
		}
	}

	// =========================
	// Application Management
	// =========================

	async listApplications(
		pageSize = 10,
		pageNumber?: number,
		filterName?: string,
		filterAuthStrategy?: string,
	): Promise<any> {
		let endpoint = `/api/v3/applications?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		if (filterName) endpoint += `&filter[name][contains]=${encodeURIComponent(filterName)}`;
		if (filterAuthStrategy) endpoint += `&filter[auth_strategy_id][eq]=${filterAuthStrategy}`;

		return this.portalRequest<any>(endpoint);
	}

	async createApplication(applicationData: any): Promise<any> {
		return this.portalRequest<any>(`/api/v3/applications`, "POST", applicationData);
	}

	async getApplication(applicationId: string): Promise<any> {
		return this.portalRequest<any>(`/api/v3/applications/${applicationId}`);
	}

	async updateApplication(applicationId: string, applicationData: any): Promise<any> {
		return this.portalRequest<any>(`/api/v3/applications/${applicationId}`, "PATCH", applicationData);
	}

	async deleteApplication(applicationId: string): Promise<any> {
		return this.portalRequest<any>(`/api/v3/applications/${applicationId}`, "DELETE");
	}

	// =========================
	// Application Registrations
	// =========================

	async listApplicationRegistrations(
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

		return this.portalRequest<any>(endpoint);
	}

	async createApplicationRegistration(applicationId: string, registrationData: any): Promise<any> {
		return this.portalRequest<any>(`/api/v3/applications/${applicationId}/registrations`, "POST", registrationData);
	}

	async getApplicationRegistration(applicationId: string, registrationId: string): Promise<any> {
		return this.portalRequest<any>(`/api/v3/applications/${applicationId}/registrations/${registrationId}`);
	}

	async deleteApplicationRegistration(applicationId: string, registrationId: string): Promise<any> {
		return this.portalRequest<any>(`/api/v3/applications/${applicationId}/registrations/${registrationId}`, "DELETE");
	}

	// =========================
	// Application Credentials
	// =========================

	async listCredentials(applicationId: string, pageSize = 10, pageNumber?: number): Promise<any> {
		let endpoint = `/api/v3/applications/${applicationId}/credentials?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;

		return this.portalRequest<any>(endpoint);
	}

	async createCredential(applicationId: string, credentialData: any): Promise<any> {
		return this.portalRequest<any>(`/api/v3/applications/${applicationId}/credentials`, "POST", credentialData);
	}

	async updateCredential(applicationId: string, credentialId: string, credentialData: any): Promise<any> {
		return this.portalRequest<any>(
			`/api/v3/applications/${applicationId}/credentials/${credentialId}`,
			"PATCH",
			credentialData,
		);
	}

	async deleteCredential(applicationId: string, credentialId: string): Promise<any> {
		return this.portalRequest<any>(`/api/v3/applications/${applicationId}/credentials/${credentialId}`, "DELETE");
	}

	async regenerateApplicationSecret(applicationId: string): Promise<any> {
		return this.portalRequest<any>(`/api/v3/applications/${applicationId}/regenerate-secret`, "POST");
	}

	// =========================
	// Developer Authentication
	// =========================

	async registerDeveloper(developerData: any): Promise<any> {
		return this.portalRequest<any>(`/api/v3/register`, "POST", developerData);
	}

	async authenticateDeveloper(credentials: any): Promise<any> {
		return this.portalRequest<any>(`/api/v3/authenticate`, "POST", credentials);
	}

	async getDeveloperMe(): Promise<any> {
		return this.portalRequest<any>(`/api/v3/me`);
	}

	async logoutDeveloper(): Promise<any> {
		return this.portalRequest<any>(`/api/v3/logout`, "POST");
	}

	// =========================
	// Application Analytics
	// =========================

	async queryApplicationAnalytics(applicationId: string, analyticsQuery: any): Promise<any> {
		return this.portalRequest<any>(`/api/v3/applications/${applicationId}/analytics`, "POST", analyticsQuery);
	}

	// =========================
	// Portal APIs (within portal context)
	// =========================

	async listPortalApis(
		pageSize = 10,
		pageNumber?: number,
		filterName?: string,
		filterStatus?: string,
		sort?: string,
	): Promise<any> {
		let endpoint = `/api/v3/apis?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		if (filterName) endpoint += `&filter[name][contains]=${encodeURIComponent(filterName)}`;
		if (filterStatus) endpoint += `&filter[status][eq]=${filterStatus}`;
		if (sort) endpoint += `&sort=${encodeURIComponent(sort)}`;

		return this.portalRequest<any>(endpoint);
	}

	async fetchPortalApi(apiIdOrSlug: string): Promise<any> {
		return this.portalRequest<any>(`/api/v3/apis/${apiIdOrSlug}`);
	}

	async getPortalApiActions(apiIdOrSlug: string): Promise<any> {
		return this.portalRequest<any>(`/api/v3/apis/${apiIdOrSlug}/actions`);
	}

	async listPortalApiDocuments(apiIdOrSlug: string): Promise<any> {
		return this.portalRequest<any>(`/api/v3/apis/${apiIdOrSlug}/documents`);
	}

	async fetchPortalApiDocument(apiIdOrSlug: string, documentIdOrSlug: string, format = "json"): Promise<any> {
		const formatParam = format !== "json" ? `?format=${format}` : "";
		return this.portalRequest<any>(`/api/v3/apis/${apiIdOrSlug}/documents/${documentIdOrSlug}${formatParam}`);
	}

	// =========================
	// Utility Methods
	// =========================

	/**
	 * Get portal info (useful for debugging and validation)
	 */
	getPortalInfo() {
		return {
			portalId: this.portalId,
			region: this.region,
			baseUrl: this.baseUrl,
			hasApiKey: !!this.apiKey,
		};
	}

	/**
	 * Test portal connectivity
	 */
	async testConnection(): Promise<boolean> {
		try {
			await this.listPortalApis(1);
			return true;
		} catch (error) {
			mcpLogger.error("api", "Portal connection test failed", {
				error: error.message,
			});
			return false;
		}
	}
}
