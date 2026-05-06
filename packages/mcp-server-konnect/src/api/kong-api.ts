// src/api/kong-api.ts
import axios, { type AxiosError, type AxiosRequestConfig } from "axios";
import type {
	ApiRequestFilter,
	ApiRequestsResponse,
	Certificate,
	Consumer,
	ConsumerKey,
	ControlPlane,
	ControlPlaneConfig,
	DataPlaneNode,
	DataPlaneNodeListResponse,
	DataPlaneToken,
	GroupMember,
	GroupMembershipStatus,
	KongEntityResponse,
	KongListResponse,
	Plugin,
	PluginSchema,
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
	PortalInfo,
	PortalProduct,
	Route,
	SNI,
	Service,
	TimeRange,
	Upstream,
	UpstreamHealth,
	UpstreamTarget,
} from "../types.js";
import { createContextLogger } from "../utils/logger.js";
import { PortalApi, type PortalApiOptions } from "./portal-api.js";

const log = createContextLogger("api");

// Kong Konnect API region prefixes (subdomain on api.konghq.com)
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

// Body payloads accept arbitrary JSON-serializable shapes; tools layer above
// validates with Zod and the Konnect API itself rejects malformed bodies.
export type KongRequestBody = Record<string, unknown> | unknown[] | null;

export class KongApi {
	private baseUrl: string;
	private apiKey: string;
	private apiRegion: string;

	constructor(options: KongApiOptions = {}) {
		this.apiRegion = options.apiRegion || process.env.KONNECT_REGION || API_REGIONS.US;
		this.baseUrl = `https://${this.apiRegion}.api.konghq.com/v2`;
		this.apiKey = options.apiKey || process.env.KONNECT_ACCESS_TOKEN || "";

		if (!this.apiKey) {
			log.warn("KONNECT_ACCESS_TOKEN not set in environment - API calls will fail");
		}
	}

	// Authenticated request helper with consistent error normalisation.
	async kongRequest<T>(endpoint: string, method = "GET", data: KongRequestBody = null): Promise<T> {
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
			return response.data as T;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			log.error({ error: message }, "Kong API request failed");

			// Axios attaches `response`/`request` on its error type; narrow via instanceof
			// then fall through for non-axios errors (network, programmer error, etc).
			if (axios.isAxiosError(error)) {
				const axiosError = error as AxiosError<unknown>;
				if (axiosError.response) {
					const errorData = axiosError.response.data;
					let errorMessage = `API Error (Status ${axiosError.response.status})`;

					if (errorData && typeof errorData === "object") {
						const maybeMessage = (errorData as { message?: unknown }).message;
						const errorDetails = typeof maybeMessage === "string" ? maybeMessage : JSON.stringify(errorData);
						errorMessage += `: ${errorDetails}`;
					} else if (typeof errorData === "string") {
						errorMessage += `: ${errorData.substring(0, 200)}`;
					}

					if (axiosError.response.status === 401) {
						errorMessage += "\n\nTroubleshooting: Check that KONNECT_ACCESS_TOKEN is set correctly and has not expired.";
					} else if (axiosError.response.status === 403) {
						errorMessage +=
							"\n\nTroubleshooting: Your access token may not have sufficient permissions for this operation.";
					} else if (axiosError.response.status === 404) {
						errorMessage +=
							"\n\nTroubleshooting: The requested resource was not found. Verify the control plane ID and resource ID are correct.";
					} else if (axiosError.response.status === 429) {
						errorMessage += "\n\nTroubleshooting: Rate limit exceeded. Please wait before making more requests.";
					}

					throw new Error(errorMessage);
				}
				if (axiosError.request) {
					throw new Error(
						"Network Error: No response received from Kong API. Please check your network connection and API endpoint configuration.",
					);
				}
			}

			throw new Error(`Request Error: ${message}. Please check your request parameters and try again.`);
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
	): Promise<KongListResponse<ControlPlane>> {
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

		return this.kongRequest<KongListResponse<ControlPlane>>(endpoint);
	}

	async getControlPlane(controlPlaneId: string): Promise<ControlPlane> {
		return this.kongRequest<ControlPlane>(`/control-planes/${controlPlaneId}`);
	}

	async listControlPlaneGroupMemberships(
		groupId: string,
		pageSize = 10,
		pageAfter?: string,
	): Promise<KongListResponse<GroupMember>> {
		let endpoint = `/control-planes/${groupId}/group-memberships?page[size]=${pageSize}`;

		if (pageAfter) {
			endpoint += `&page[after]=${pageAfter}`;
		}

		return this.kongRequest<KongListResponse<GroupMember>>(endpoint);
	}

	async checkControlPlaneGroupMembership(controlPlaneId: string): Promise<GroupMembershipStatus> {
		return this.kongRequest<GroupMembershipStatus>(
			`/control-planes/${controlPlaneId}/group-member-status`,
		);
	}

	async createControlPlane(controlPlaneData: Record<string, unknown>): Promise<ControlPlane> {
		return this.kongRequest<ControlPlane>(`/control-planes`, "POST", controlPlaneData);
	}

	async updateControlPlane(
		controlPlaneId: string,
		controlPlaneData: Record<string, unknown>,
	): Promise<ControlPlane> {
		return this.kongRequest<ControlPlane>(`/control-planes/${controlPlaneId}`, "PATCH", controlPlaneData);
	}

	async deleteControlPlane(controlPlaneId: string): Promise<void> {
		return this.kongRequest<void>(`/control-planes/${controlPlaneId}`, "DELETE");
	}

	// Data Plane Node Management (deprecated - using newer /nodes endpoint below)

	async createDataPlaneToken(
		controlPlaneId: string,
		tokenData: Record<string, unknown>,
	): Promise<DataPlaneToken> {
		return this.kongRequest<DataPlaneToken>(`/control-planes/${controlPlaneId}/tokens`, "POST", tokenData);
	}

	async listDataPlaneTokens(
		controlPlaneId: string,
		pageSize = 10,
		pageNumber?: number,
	): Promise<KongListResponse<DataPlaneToken>> {
		let endpoint = `/control-planes/${controlPlaneId}/tokens?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;

		return this.kongRequest<KongListResponse<DataPlaneToken>>(endpoint);
	}

	async revokeDataPlaneToken(controlPlaneId: string, tokenId: string): Promise<void> {
		return this.kongRequest<void>(`/control-planes/${controlPlaneId}/tokens/${tokenId}`, "DELETE");
	}

	async getControlPlaneConfig(controlPlaneId: string): Promise<ControlPlaneConfig> {
		return this.kongRequest<ControlPlaneConfig>(`/control-planes/${controlPlaneId}/config`);
	}

	async updateControlPlaneConfig(
		controlPlaneId: string,
		configData: Record<string, unknown>,
	): Promise<ControlPlaneConfig> {
		return this.kongRequest<ControlPlaneConfig>(
			`/control-planes/${controlPlaneId}/config`,
			"PATCH",
			configData,
		);
	}

	async listServices(
		controlPlaneId: string,
		size = 100,
		offset?: string,
	): Promise<KongListResponse<Service>> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/services?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<KongListResponse<Service>>(endpoint);
	}

	async getService(controlPlaneId: string, serviceId: string): Promise<Service> {
		return this.kongRequest<Service>(`/control-planes/${controlPlaneId}/core-entities/services/${serviceId}`);
	}

	async createService(controlPlaneId: string, serviceData: Record<string, unknown>): Promise<Service> {
		return this.kongRequest<Service>(
			`/control-planes/${controlPlaneId}/core-entities/services`,
			"POST",
			serviceData,
		);
	}

	async updateService(
		controlPlaneId: string,
		serviceId: string,
		serviceData: Record<string, unknown>,
	): Promise<Service> {
		return this.kongRequest<Service>(
			`/control-planes/${controlPlaneId}/core-entities/services/${serviceId}`,
			"PUT",
			serviceData,
		);
	}

	async deleteService(controlPlaneId: string, serviceId: string): Promise<void> {
		return this.kongRequest<void>(
			`/control-planes/${controlPlaneId}/core-entities/services/${serviceId}`,
			"DELETE",
		);
	}

	async listRoutes(
		controlPlaneId: string,
		size = 100,
		offset?: string,
	): Promise<KongListResponse<Route>> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/routes?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<KongListResponse<Route>>(endpoint);
	}

	async getRoute(controlPlaneId: string, routeId: string): Promise<Route> {
		return this.kongRequest<Route>(`/control-planes/${controlPlaneId}/core-entities/routes/${routeId}`);
	}

	async createRoute(controlPlaneId: string, routeData: Record<string, unknown>): Promise<Route> {
		return this.kongRequest<Route>(`/control-planes/${controlPlaneId}/core-entities/routes`, "POST", routeData);
	}

	async updateRoute(
		controlPlaneId: string,
		routeId: string,
		routeData: Record<string, unknown>,
	): Promise<Route> {
		return this.kongRequest<Route>(
			`/control-planes/${controlPlaneId}/core-entities/routes/${routeId}`,
			"PUT",
			routeData,
		);
	}

	async deleteRoute(controlPlaneId: string, routeId: string): Promise<void> {
		return this.kongRequest<void>(
			`/control-planes/${controlPlaneId}/core-entities/routes/${routeId}`,
			"DELETE",
		);
	}

	async listConsumers(
		controlPlaneId: string,
		size = 100,
		offset?: string,
	): Promise<KongListResponse<Consumer>> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/consumers?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<KongListResponse<Consumer>>(endpoint);
	}

	async createConsumer(controlPlaneId: string, consumerData: Record<string, unknown>): Promise<Consumer> {
		return this.kongRequest<Consumer>(
			`/control-planes/${controlPlaneId}/core-entities/consumers`,
			"POST",
			consumerData,
		);
	}

	async getConsumer(controlPlaneId: string, consumerId: string): Promise<Consumer> {
		return this.kongRequest<Consumer>(`/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}`);
	}

	async updateConsumer(
		controlPlaneId: string,
		consumerId: string,
		consumerData: Record<string, unknown>,
	): Promise<Consumer> {
		return this.kongRequest<Consumer>(
			`/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}`,
			"PUT",
			consumerData,
		);
	}

	async deleteConsumer(controlPlaneId: string, consumerId: string): Promise<void> {
		return this.kongRequest<void>(
			`/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}`,
			"DELETE",
		);
	}

	async listPlugins(
		controlPlaneId: string,
		size = 100,
		offset?: string,
	): Promise<KongListResponse<Plugin>> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/plugins?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<KongListResponse<Plugin>>(endpoint);
	}

	async getPlugin(controlPlaneId: string, pluginId: string): Promise<Plugin> {
		return this.kongRequest<Plugin>(`/control-planes/${controlPlaneId}/core-entities/plugins/${pluginId}`);
	}

	async createPlugin(controlPlaneId: string, pluginData: Record<string, unknown>): Promise<Plugin> {
		return this.kongRequest<Plugin>(
			`/control-planes/${controlPlaneId}/core-entities/plugins`,
			"POST",
			pluginData,
		);
	}

	async updatePlugin(
		controlPlaneId: string,
		pluginId: string,
		pluginData: Record<string, unknown>,
	): Promise<Plugin> {
		return this.kongRequest<Plugin>(
			`/control-planes/${controlPlaneId}/core-entities/plugins/${pluginId}`,
			"PUT",
			pluginData,
		);
	}

	async deletePlugin(controlPlaneId: string, pluginId: string): Promise<void> {
		return this.kongRequest<void>(
			`/control-planes/${controlPlaneId}/core-entities/plugins/${pluginId}`,
			"DELETE",
		);
	}

	async listPluginSchemas(controlPlaneId: string): Promise<KongListResponse<PluginSchema>> {
		return this.kongRequest<KongListResponse<PluginSchema>>(
			`/control-planes/${controlPlaneId}/core-entities/plugin-schemas`,
		);
	}

	async listCertificates(
		controlPlaneId: string,
		size = 100,
		offset?: string,
	): Promise<KongListResponse<Certificate>> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/certificates?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<KongListResponse<Certificate>>(endpoint);
	}

	async getCertificate(
		controlPlaneId: string,
		certificateId: string,
	): Promise<KongEntityResponse<Certificate>> {
		return this.kongRequest<KongEntityResponse<Certificate>>(
			`/control-planes/${controlPlaneId}/core-entities/certificates/${certificateId}`,
		);
	}

	async createCertificate(
		controlPlaneId: string,
		certificateData: Record<string, unknown>,
	): Promise<KongEntityResponse<Certificate>> {
		return this.kongRequest<KongEntityResponse<Certificate>>(
			`/control-planes/${controlPlaneId}/core-entities/certificates`,
			"POST",
			certificateData,
		);
	}

	async updateCertificate(
		controlPlaneId: string,
		certificateId: string,
		certificateData: Record<string, unknown>,
	): Promise<KongEntityResponse<Certificate>> {
		return this.kongRequest<KongEntityResponse<Certificate>>(
			`/control-planes/${controlPlaneId}/core-entities/certificates/${certificateId}`,
			"PUT",
			certificateData,
		);
	}

	async deleteCertificate(controlPlaneId: string, certificateId: string): Promise<void> {
		return this.kongRequest<void>(
			`/control-planes/${controlPlaneId}/core-entities/certificates/${certificateId}`,
			"DELETE",
		);
	}

	async listUpstreams(
		controlPlaneId: string,
		size = 100,
		offset?: string,
	): Promise<KongListResponse<Upstream>> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/upstreams?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<KongListResponse<Upstream>>(endpoint);
	}

	async getUpstream(controlPlaneId: string, upstreamId: string): Promise<Upstream> {
		return this.kongRequest<Upstream>(`/control-planes/${controlPlaneId}/core-entities/upstreams/${upstreamId}`);
	}

	async listUpstreamTargets(
		controlPlaneId: string,
		upstreamId: string,
		size = 100,
		offset?: string,
	): Promise<KongListResponse<UpstreamTarget>> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/upstreams/${upstreamId}/targets?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<KongListResponse<UpstreamTarget>>(endpoint);
	}

	async getUpstreamHealth(controlPlaneId: string, upstreamId: string): Promise<UpstreamHealth> {
		return this.kongRequest<UpstreamHealth>(
			`/control-planes/${controlPlaneId}/core-entities/upstreams/${upstreamId}/health`,
		);
	}

	async listDataPlaneNodes(
		controlPlaneId: string,
		pageSize = 10,
		pageNumber?: number,
		filterStatus?: string,
		filterHostname?: string,
	): Promise<DataPlaneNodeListResponse> {
		let endpoint = `/control-planes/${controlPlaneId}/nodes?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		if (filterStatus) endpoint += `&filter[status][eq]=${filterStatus}`;
		if (filterHostname) endpoint += `&filter[hostname][contains]=${encodeURIComponent(filterHostname)}`;

		return this.kongRequest<DataPlaneNodeListResponse>(endpoint);
	}

	async getDataPlaneNode(controlPlaneId: string, nodeId: string): Promise<DataPlaneNode> {
		return this.kongRequest<DataPlaneNode>(`/control-planes/${controlPlaneId}/nodes/${nodeId}`);
	}

	async deleteDataPlaneNode(controlPlaneId: string, nodeId: string): Promise<void> {
		return this.kongRequest<void>(`/control-planes/${controlPlaneId}/nodes/${nodeId}`, "DELETE");
	}

	async getExpectedConfigHash(controlPlaneId: string): Promise<{ hash?: string } & Record<string, unknown>> {
		return this.kongRequest<{ hash?: string } & Record<string, unknown>>(
			`/control-planes/${controlPlaneId}/expected-config-hash`,
		);
	}

	async listSNIs(
		controlPlaneId: string,
		size = 100,
		offset?: string,
	): Promise<KongListResponse<SNI>> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/snis?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<KongListResponse<SNI>>(endpoint);
	}

	async createSNI(controlPlaneId: string, sniData: Record<string, unknown>): Promise<SNI> {
		return this.kongRequest<SNI>(`/control-planes/${controlPlaneId}/core-entities/snis`, "POST", sniData);
	}

	async listConsumerKeys(
		controlPlaneId: string,
		consumerId: string,
		size = 100,
		offset?: string,
	): Promise<KongListResponse<ConsumerKey>> {
		let endpoint = `/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}/key-auth?size=${size}`;

		if (offset) {
			endpoint += `&offset=${offset}`;
		}

		return this.kongRequest<KongListResponse<ConsumerKey>>(endpoint);
	}

	async createConsumerKey(
		controlPlaneId: string,
		consumerId: string,
		keyData: Record<string, unknown>,
	): Promise<ConsumerKey> {
		return this.kongRequest<ConsumerKey>(
			`/control-planes/${controlPlaneId}/core-entities/consumers/${consumerId}/key-auth`,
			"POST",
			keyData,
		);
	}

	async deleteConsumerKey(controlPlaneId: string, consumerId: string, keyId: string): Promise<void> {
		return this.kongRequest<void>(
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
	): Promise<KongListResponse<PortalApiSummary>> {
		let endpoint = `/portal/apis?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		if (filterName) endpoint += `&filter[name][contains]=${encodeURIComponent(filterName)}`;
		if (filterStatus) endpoint += `&filter[status][eq]=${filterStatus}`;
		if (sort) endpoint += `&sort=${encodeURIComponent(sort)}`;

		return this.kongRequest<KongListResponse<PortalApiSummary>>(endpoint);
	}

	async fetchPortalApi(apiIdOrSlug: string): Promise<PortalApiSummary> {
		return this.kongRequest<PortalApiSummary>(`/portal/apis/${apiIdOrSlug}`);
	}

	async getPortalApiActions(apiIdOrSlug: string): Promise<PortalApiActions> {
		return this.kongRequest<PortalApiActions>(`/portal/apis/${apiIdOrSlug}/actions`);
	}

	async listPortalApiDocuments(apiIdOrSlug: string): Promise<PortalApiDocumentTree> {
		return this.kongRequest<PortalApiDocumentTree>(`/portal/apis/${apiIdOrSlug}/documents`);
	}

	async fetchPortalApiDocument(
		apiIdOrSlug: string,
		documentIdOrSlug: string,
		format = "json",
	): Promise<PortalApiDocument> {
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
		return this.kongRequest<PortalApiDocument>(`/portal/apis/${apiIdOrSlug}/documents/${documentIdOrSlug}`, "GET");
	}

	async listPortalApplications(
		pageSize = 10,
		pageNumber?: number,
		filterName?: string,
		filterAuthStrategy?: string,
	): Promise<KongListResponse<PortalApplication>> {
		let endpoint = `/api/v3/applications?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		if (filterName) endpoint += `&filter[name][contains]=${encodeURIComponent(filterName)}`;
		if (filterAuthStrategy) endpoint += `&filter[auth_strategy_id][eq]=${filterAuthStrategy}`;

		return this.kongRequest<KongListResponse<PortalApplication>>(endpoint);
	}

	async createPortalApplication(applicationData: Record<string, unknown>): Promise<PortalApplication> {
		return this.kongRequest<PortalApplication>(`/api/v3/applications`, "POST", applicationData);
	}

	async getPortalApplication(applicationId: string): Promise<PortalApplication> {
		return this.kongRequest<PortalApplication>(`/api/v3/applications/${applicationId}`);
	}

	async updatePortalApplication(
		applicationId: string,
		applicationData: Record<string, unknown>,
	): Promise<PortalApplication> {
		return this.kongRequest<PortalApplication>(`/api/v3/applications/${applicationId}`, "PATCH", applicationData);
	}

	async deletePortalApplication(applicationId: string): Promise<void> {
		return this.kongRequest<void>(`/api/v3/applications/${applicationId}`, "DELETE");
	}

	async listPortalApplicationRegistrations(
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

		return this.kongRequest<KongListResponse<PortalApplicationRegistration>>(endpoint);
	}

	async createPortalApplicationRegistration(
		applicationId: string,
		registrationData: Record<string, unknown>,
	): Promise<PortalApplicationRegistration> {
		return this.kongRequest<PortalApplicationRegistration>(
			`/api/v3/applications/${applicationId}/registrations`,
			"POST",
			registrationData,
		);
	}

	async getPortalApplicationRegistration(
		applicationId: string,
		registrationId: string,
	): Promise<PortalApplicationRegistration> {
		return this.kongRequest<PortalApplicationRegistration>(
			`/api/v3/applications/${applicationId}/registrations/${registrationId}`,
		);
	}

	async deletePortalApplicationRegistration(applicationId: string, registrationId: string): Promise<void> {
		return this.kongRequest<void>(
			`/api/v3/applications/${applicationId}/registrations/${registrationId}`,
			"DELETE",
		);
	}

	async listPortalCredentials(
		applicationId: string,
		pageSize = 10,
		pageNumber?: number,
	): Promise<KongListResponse<PortalCredential>> {
		let endpoint = `/api/v3/applications/${applicationId}/credentials?page[size]=${pageSize}`;

		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;

		return this.kongRequest<KongListResponse<PortalCredential>>(endpoint);
	}

	async createPortalCredential(
		applicationId: string,
		credentialData: Record<string, unknown>,
	): Promise<PortalCredential> {
		return this.kongRequest<PortalCredential>(
			`/api/v3/applications/${applicationId}/credentials`,
			"POST",
			credentialData,
		);
	}

	async updatePortalCredential(
		applicationId: string,
		credentialId: string,
		credentialData: Record<string, unknown>,
	): Promise<PortalCredential> {
		return this.kongRequest<PortalCredential>(
			`/api/v3/applications/${applicationId}/credentials/${credentialId}`,
			"PATCH",
			credentialData,
		);
	}

	async deletePortalCredential(applicationId: string, credentialId: string): Promise<void> {
		return this.kongRequest<void>(
			`/api/v3/applications/${applicationId}/credentials/${credentialId}`,
			"DELETE",
		);
	}

	async regeneratePortalApplicationSecret(applicationId: string): Promise<PortalApplicationSecret> {
		return this.kongRequest<PortalApplicationSecret>(
			`/api/v3/applications/${applicationId}/regenerate-secret`,
			"POST",
		);
	}

	async registerPortalDeveloper(developerData: Record<string, unknown>): Promise<PortalDeveloper> {
		return this.kongRequest<PortalDeveloper>(`/api/v3/register`, "POST", developerData);
	}

	async authenticatePortalDeveloper(credentials: Record<string, unknown>): Promise<PortalAuthSession> {
		return this.kongRequest<PortalAuthSession>(`/api/v3/authenticate`, "POST", credentials);
	}

	async getPortalDeveloperMe(): Promise<PortalDeveloper> {
		return this.kongRequest<PortalDeveloper>(`/api/v3/me`);
	}

	async logoutPortalDeveloper(): Promise<void> {
		return this.kongRequest<void>(`/api/v3/logout`, "POST");
	}

	async queryPortalApplicationAnalytics(
		applicationId: string,
		analyticsQuery: Record<string, unknown>,
	): Promise<PortalAnalyticsResponse> {
		return this.kongRequest<PortalAnalyticsResponse>(
			`/api/v3/applications/${applicationId}/analytics`,
			"POST",
			analyticsQuery,
		);
	}

	async listPortals(pageSize = 10, pageNumber?: number): Promise<KongListResponse<PortalInfo>> {
		let endpoint = `/portals?page[size]=${pageSize}`;
		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		return this.kongRequest<KongListResponse<PortalInfo>>(endpoint);
	}

	async createPortal(portalData: Record<string, unknown>): Promise<PortalInfo> {
		return this.kongRequest<PortalInfo>(`/portals`, "POST", portalData);
	}

	async getPortal(portalId: string): Promise<PortalInfo> {
		return this.kongRequest<PortalInfo>(`/portals/${portalId}`);
	}

	async updatePortal(portalId: string, portalData: Record<string, unknown>): Promise<PortalInfo> {
		return this.kongRequest<PortalInfo>(`/portals/${portalId}`, "PATCH", portalData);
	}

	async deletePortal(portalId: string): Promise<void> {
		return this.kongRequest<void>(`/portals/${portalId}`, "DELETE");
	}

	async listPortalProducts(
		portalId: string,
		pageSize = 10,
		pageNumber?: number,
	): Promise<KongListResponse<PortalProduct>> {
		let endpoint = `/portals/${portalId}/products?page[size]=${pageSize}`;
		if (pageNumber) endpoint += `&page[number]=${pageNumber}`;
		return this.kongRequest<KongListResponse<PortalProduct>>(endpoint);
	}

	async publishPortalProduct(portalId: string, productData: Record<string, unknown>): Promise<PortalProduct> {
		return this.kongRequest<PortalProduct>(`/portals/${portalId}/products`, "POST", productData);
	}

	async unpublishPortalProduct(portalId: string, productId: string): Promise<void> {
		return this.kongRequest<void>(`/portals/${portalId}/products/${productId}`, "DELETE");
	}

	// Portal-domain operations live on a different host than the management API.
	async createPortalClient(portalId: string, options?: Partial<PortalApiOptions>): Promise<PortalApi> {
		const portalInfo = await this.getPortal(portalId);

		const portalOptions: PortalApiOptions = {
			apiKey: options?.apiKey || this.apiKey,
			apiRegion: options?.apiRegion || this.apiRegion,
			portalDomain: portalInfo.default_domain,
		};

		return new PortalApi(portalId, portalOptions);
	}

	// Legacy synchronous variant retained for callers that already know the portal domain.
	createPortalClientSync(portalId: string, options?: Partial<PortalApiOptions>): PortalApi {
		const portalOptions: PortalApiOptions = {
			apiKey: options?.apiKey || this.apiKey,
			apiRegion: options?.apiRegion || this.apiRegion,
		};

		return new PortalApi(portalId, portalOptions);
	}

	// Portal application methods are available via createPortalClient(portalId)
}
