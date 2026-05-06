// src/api/portal-api.ts
import axios, { type AxiosError, type AxiosRequestConfig, type Method } from "axios";
import type {
	KongListResponse,
	PortalAnalyticsResponse,
	PortalApiActions,
	PortalApiDocument,
	PortalApiDocumentTree,
	PortalApiSummary,
	PortalApplication,
	PortalApplicationRegistration,
	PortalApplicationSecret,
	PortalAuthSession,
	PortalCredential,
	PortalDeveloper,
} from "../types.js";
import { createContextLogger } from "../utils/logger.js";
import { API_REGIONS } from "./kong-api.js";

const log = createContextLogger("api");

export interface PortalApiOptions {
	apiKey?: string;
	apiRegion?: string;
	portalDomain?: string; // Allow explicit portal domain override
}

// JSON-serializable bodies. Tools layer validates with Zod before calling.
export type PortalRequestBody = Record<string, unknown> | unknown[] | null;

// Portal API Client for Kong Konnect Developer Portal endpoints
//
// This client handles portal-specific operations that require the portal
// domain (e.g., {portalId}.{region}.kongportals.com) rather than the
// management API domain.
export class PortalApi {
	private baseUrl: string;
	private apiKey: string;
	private portalId: string;
	private region: string;

	constructor(portalId: string, options: PortalApiOptions = {}) {
		this.portalId = portalId;
		this.region = options.apiRegion || process.env.KONNECT_REGION || API_REGIONS.US;

		if (options.portalDomain) {
			this.baseUrl = `https://${options.portalDomain}`;
		} else {
			// Default portal domain format: {portal-subdomain}.{region}.portal.konghq.com
			this.baseUrl = `https://${portalId}.${this.region}.portal.konghq.com`;
		}

		this.apiKey = options.apiKey || process.env.KONNECT_ACCESS_TOKEN || "";

		if (!this.apiKey) {
			log.warn("KONNECT_ACCESS_TOKEN not set in environment - Portal API calls will fail");
		}

		if (!portalId) {
			throw new Error("Portal ID is required for Portal API client");
		}
	}

	async portalRequest<T>(endpoint: string, method = "GET", data: PortalRequestBody = null): Promise<T> {
		try {
			const url = `${this.baseUrl}${endpoint}`;
			log.debug({ url }, "Making portal API request");

			const headers = {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			};

			const config: AxiosRequestConfig = {
				method: method as Method,
				url,
				headers,
				timeout: 30000,
			};

			if (data && (method === "POST" || method === "PUT" || method === "PATCH")) {
				config.data = data;
			}

			const response = await axios(config);
			log.debug({ status: response.status }, "Received portal API response");
			return response.data as T;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ error: message }, "Portal API request failed");

			let errorMessage = `Portal API Error`;

			if (axios.isAxiosError(error)) {
				const axiosError = error as AxiosError<unknown>;
				if (axiosError.response) {
					const status = axiosError.response.status;
					const data = axiosError.response.data;

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
				}
				if (axiosError.request) {
					errorMessage += `: Network error - could not reach portal ${this.portalId}.${this.region}.kongportals.com`;
					errorMessage += "\n\nTroubleshooting: Check internet connection and portal domain accessibility.";
					throw new Error(errorMessage);
				}
			}

			errorMessage += `: ${message}`;
			throw new Error(errorMessage);
		}
	}

	async listApplications(
		pageSize = 10,
		pageNumber?: number,
		filterName?: string,
		filterAuthStrategy?: string,
	): Promise<KongListResponse<PortalApplication>> {
		let endpoint = `/api/v3/applications?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		if (filterName) endpoint += `&filter[name][contains]=${encodeURIComponent(filterName)}`;
		if (filterAuthStrategy) endpoint += `&filter[auth_strategy_id][eq]=${filterAuthStrategy}`;

		return this.portalRequest<KongListResponse<PortalApplication>>(endpoint);
	}

	async createApplication(applicationData: Record<string, unknown>): Promise<PortalApplication> {
		return this.portalRequest<PortalApplication>(`/api/v3/applications`, "POST", applicationData);
	}

	async getApplication(applicationId: string): Promise<PortalApplication> {
		return this.portalRequest<PortalApplication>(`/api/v3/applications/${applicationId}`);
	}

	async updateApplication(
		applicationId: string,
		applicationData: Record<string, unknown>,
	): Promise<PortalApplication> {
		return this.portalRequest<PortalApplication>(
			`/api/v3/applications/${applicationId}`,
			"PATCH",
			applicationData,
		);
	}

	async deleteApplication(applicationId: string): Promise<void> {
		return this.portalRequest<void>(`/api/v3/applications/${applicationId}`, "DELETE");
	}

	async listApplicationRegistrations(
		applicationId: string,
		pageSize = 10,
		pageNumber?: number,
		filterStatus?: string,
		filterApiName?: string,
	): Promise<KongListResponse<PortalApplicationRegistration>> {
		let endpoint = `/api/v3/applications/${applicationId}/registrations?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		if (filterStatus) endpoint += `&filter[status][eq]=${filterStatus}`;
		if (filterApiName) endpoint += `&filter[api_name][contains]=${encodeURIComponent(filterApiName)}`;

		return this.portalRequest<KongListResponse<PortalApplicationRegistration>>(endpoint);
	}

	async createApplicationRegistration(
		applicationId: string,
		registrationData: Record<string, unknown>,
	): Promise<PortalApplicationRegistration> {
		return this.portalRequest<PortalApplicationRegistration>(
			`/api/v3/applications/${applicationId}/registrations`,
			"POST",
			registrationData,
		);
	}

	async getApplicationRegistration(
		applicationId: string,
		registrationId: string,
	): Promise<PortalApplicationRegistration> {
		return this.portalRequest<PortalApplicationRegistration>(
			`/api/v3/applications/${applicationId}/registrations/${registrationId}`,
		);
	}

	async deleteApplicationRegistration(applicationId: string, registrationId: string): Promise<void> {
		return this.portalRequest<void>(
			`/api/v3/applications/${applicationId}/registrations/${registrationId}`,
			"DELETE",
		);
	}

	async listCredentials(
		applicationId: string,
		pageSize = 10,
		pageNumber?: number,
	): Promise<KongListResponse<PortalCredential>> {
		let endpoint = `/api/v3/applications/${applicationId}/credentials?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;

		return this.portalRequest<KongListResponse<PortalCredential>>(endpoint);
	}

	async createCredential(
		applicationId: string,
		credentialData: Record<string, unknown>,
	): Promise<PortalCredential> {
		return this.portalRequest<PortalCredential>(
			`/api/v3/applications/${applicationId}/credentials`,
			"POST",
			credentialData,
		);
	}

	async updateCredential(
		applicationId: string,
		credentialId: string,
		credentialData: Record<string, unknown>,
	): Promise<PortalCredential> {
		return this.portalRequest<PortalCredential>(
			`/api/v3/applications/${applicationId}/credentials/${credentialId}`,
			"PATCH",
			credentialData,
		);
	}

	async deleteCredential(applicationId: string, credentialId: string): Promise<void> {
		return this.portalRequest<void>(
			`/api/v3/applications/${applicationId}/credentials/${credentialId}`,
			"DELETE",
		);
	}

	async regenerateApplicationSecret(applicationId: string): Promise<PortalApplicationSecret> {
		return this.portalRequest<PortalApplicationSecret>(
			`/api/v3/applications/${applicationId}/regenerate-secret`,
			"POST",
		);
	}

	async registerDeveloper(developerData: Record<string, unknown>): Promise<PortalDeveloper> {
		return this.portalRequest<PortalDeveloper>(`/api/v3/register`, "POST", developerData);
	}

	async authenticateDeveloper(credentials: Record<string, unknown>): Promise<PortalAuthSession> {
		return this.portalRequest<PortalAuthSession>(`/api/v3/authenticate`, "POST", credentials);
	}

	async getDeveloperMe(): Promise<PortalDeveloper> {
		return this.portalRequest<PortalDeveloper>(`/api/v3/me`);
	}

	async logoutDeveloper(): Promise<void> {
		return this.portalRequest<void>(`/api/v3/logout`, "POST");
	}

	async queryApplicationAnalytics(
		applicationId: string,
		analyticsQuery: Record<string, unknown>,
	): Promise<PortalAnalyticsResponse> {
		return this.portalRequest<PortalAnalyticsResponse>(
			`/api/v3/applications/${applicationId}/analytics`,
			"POST",
			analyticsQuery,
		);
	}

	async listPortalApis(
		pageSize = 10,
		pageNumber?: number,
		filterName?: string,
		filterStatus?: string,
		sort?: string,
	): Promise<KongListResponse<PortalApiSummary>> {
		let endpoint = `/api/v3/apis?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		if (filterName) endpoint += `&filter[name][contains]=${encodeURIComponent(filterName)}`;
		if (filterStatus) endpoint += `&filter[status][eq]=${filterStatus}`;
		if (sort) endpoint += `&sort=${encodeURIComponent(sort)}`;

		return this.portalRequest<KongListResponse<PortalApiSummary>>(endpoint);
	}

	async fetchPortalApi(apiIdOrSlug: string): Promise<PortalApiSummary> {
		return this.portalRequest<PortalApiSummary>(`/api/v3/apis/${apiIdOrSlug}`);
	}

	async getPortalApiActions(apiIdOrSlug: string): Promise<PortalApiActions> {
		return this.portalRequest<PortalApiActions>(`/api/v3/apis/${apiIdOrSlug}/actions`);
	}

	async listPortalApiDocuments(apiIdOrSlug: string): Promise<PortalApiDocumentTree> {
		return this.portalRequest<PortalApiDocumentTree>(`/api/v3/apis/${apiIdOrSlug}/documents`);
	}

	async fetchPortalApiDocument(
		apiIdOrSlug: string,
		documentIdOrSlug: string,
		format = "json",
	): Promise<PortalApiDocument> {
		const formatParam = format !== "json" ? `?format=${format}` : "";
		return this.portalRequest<PortalApiDocument>(
			`/api/v3/apis/${apiIdOrSlug}/documents/${documentIdOrSlug}${formatParam}`,
		);
	}

	// Useful for debugging and validation
	getPortalInfo() {
		return {
			portalId: this.portalId,
			region: this.region,
			baseUrl: this.baseUrl,
			hasApiKey: !!this.apiKey,
		};
	}

	async testConnection(): Promise<boolean> {
		try {
			await this.listPortalApis(1);
			return true;
		} catch (error) {
			log.error({ error: error instanceof Error ? error.message : String(error) }, "Portal connection test failed");
			return false;
		}
	}
}
