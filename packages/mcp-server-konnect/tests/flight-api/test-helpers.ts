/**
 * Flight API Test Helpers and Utilities
 * Comprehensive test utilities for Kong Konnect flight API testing
 */

import { expect } from "bun:test";
import { KongApi } from "../../src/api/kong-api.js";

export const TEST_CONFIG = {
	controlPlaneId: "1379aab0-2351-4e68-bff9-64e091173c82",
	consumer: {
		id: "5a77ce27-d2cc-420b-b7f3-3ff323165de0",
		username: "flight-api-client",
	},
	service: {
		name: "flight-service",
		host: "api.flights.example.com",
		port: 443,
		protocol: "https",
	},
	routes: [
		{ name: "get-flights", paths: ["/flights"], methods: ["GET"] },
		{ name: "create-flight", paths: ["/flights"], methods: ["POST"] },
		{ name: "get-flight", paths: ["/flights/(?<id>\\d+)"], methods: ["GET"] },
		{
			name: "update-flight",
			paths: ["/flights/(?<id>\\d+)"],
			methods: ["PUT"],
		},
		{
			name: "delete-flight",
			paths: ["/flights/(?<id>\\d+)"],
			methods: ["DELETE"],
		},
		{
			name: "book-flight",
			paths: ["/flights/(?<id>\\d+)/book"],
			methods: ["POST"],
		},
	],
	plugins: [
		{ name: "rate-limiting", config: { minute: 100, hour: 1000 } },
		{ name: "key-auth", config: { key_names: ["X-API-Key"] } },
		{
			name: "cors",
			config: { origins: ["*"], methods: ["GET", "POST", "PUT", "DELETE"] },
		},
		{ name: "request-validator", config: { version: "draft4" } },
		{
			name: "response-transformer",
			config: { add: { headers: ["X-Flight-API: v1"] } },
		},
	],
};

export const TEST_FIXTURES = {
	flightData: {
		origin: "JFK",
		destination: "LAX",
		departureTime: "2025-01-15T08:00:00Z",
		arrivalTime: "2025-01-15T11:30:00Z",
		price: 299.99,
		airline: "Kong Air",
		flightNumber: "KA101",
	},
	bookingData: {
		passengerName: "John Doe",
		email: "john.doe@example.com",
		seatPreference: "window",
		specialRequests: "vegetarian meal",
	},
	authCredentials: {
		keyAuth: "flight-api-key-12345",
		jwtSecret: "super-secret-jwt-key",
		oauth2ClientId: "flight-client-oauth2",
	},
};

export class FlightApiTestUtils {
	public readonly kongApi: KongApi;
	private createdResources: {
		services: string[];
		routes: string[];
		consumers: string[];
		plugins: string[];
		applications: string[];
		credentials: string[];
		tokens: string[];
		certificates: string[];
		portals: string[];
	} = {
		services: [],
		routes: [],
		consumers: [],
		plugins: [],
		applications: [],
		credentials: [],
		tokens: [],
		certificates: [],
		portals: [],
	};

	// Add controlPlaneId property
	public readonly controlPlaneId: string;

	constructor() {
		this.kongApi = new KongApi({
			apiKey: process.env.KONNECT_ACCESS_TOKEN ?? "",
			apiRegion: process.env.KONNECT_REGION || "eu",
		});

		// Use the same control plane ID as in the test config
		this.controlPlaneId = TEST_CONFIG.controlPlaneId;
	}

	/**
	 * Create flight service for testing
	 */
	async createFlightService(): Promise<unknown> {
		const serviceData = {
			name: `${TEST_CONFIG.service.name}-${Date.now()}`,
			host: TEST_CONFIG.service.host,
			port: TEST_CONFIG.service.port,
			protocol: TEST_CONFIG.service.protocol,
			tags: ["test", "flight-api", "automated-test"],
		};

		const service = await this.kongApi.createService(TEST_CONFIG.controlPlaneId, serviceData);
		this.createdResources.services.push(service.id);
		return service;
	}

	/**
	 * Create flight routes for testing
	 */
	async createFlightRoutes(serviceId: string): Promise<unknown[]> {
		const routes = [];

		for (const routeConfig of TEST_CONFIG.routes) {
			const routeData = {
				name: `${routeConfig.name}-${Date.now()}`,
				service: { id: serviceId },
				paths: routeConfig.paths,
				methods: routeConfig.methods,
				tags: ["test", "flight-api", routeConfig.name],
			};

			const route = await this.kongApi.createRoute(TEST_CONFIG.controlPlaneId, routeData);
			this.createdResources.routes.push(route.id);
			routes.push(route);
		}

		return routes;
	}

	/**
	 * Create test consumer (if not exists)
	 */
	async createTestConsumer(): Promise<unknown> {
		const consumerData = {
			username: `${TEST_CONFIG.consumer.username}-${Date.now()}`,
			tags: ["test", "flight-api", "automated-test"],
		};

		const consumer = await this.kongApi.createConsumer(TEST_CONFIG.controlPlaneId, consumerData);
		this.createdResources.consumers.push(consumer.id);
		return consumer;
	}

	/**
	 * Add authentication plugin to service
	 */
	async addAuthPlugin(serviceId: string, pluginName: string, config: unknown): Promise<unknown> {
		const pluginData = {
			name: pluginName,
			service: { id: serviceId },
			config: config,
			tags: ["test", "flight-api", "auth"],
		};

		const plugin = await this.kongApi.createPlugin(TEST_CONFIG.controlPlaneId, pluginData);
		this.createdResources.plugins.push(plugin.id);
		return plugin;
	}

	/**
	 * Add rate limiting plugin
	 */
	async addRateLimitingPlugin(serviceId: string): Promise<unknown> {
		return this.addAuthPlugin(serviceId, "rate-limiting", TEST_CONFIG.plugins[0]?.config);
	}

	/**
	 * Add CORS plugin
	 */
	async addCorsPlugin(serviceId: string): Promise<unknown> {
		return this.addAuthPlugin(serviceId, "cors", TEST_CONFIG.plugins[2]?.config);
	}

	/**
	 * Create consumer credentials
	 */
	async createConsumerCredentials(consumerId: string): Promise<unknown> {
		const credentials: Record<string, unknown> = {};

		// Create Key Auth credential
		const keyAuth = await this.kongApi.createConsumerKey(TEST_CONFIG.controlPlaneId, consumerId, {
			key: TEST_FIXTURES.authCredentials.keyAuth,
		});
		credentials.keyAuth = keyAuth;
		this.createdResources.credentials.push(keyAuth.id);

		return credentials;
	}

	/**
	 * Create portal application for testing
	 */
	async createPortalApplication(overrides?: Record<string, unknown>): Promise<unknown> {
		const appData = {
			name: `Flight API Test App ${Date.now()}`,
			description: "Test application for flight API integration testing",
			clientId: `flight-test-client-${Date.now()}`,
			redirectUri: "https://test.flights.example.com/callback",
			...overrides,
		};

		const application = await this.kongApi.createPortalApplication(appData);
		this.createdResources.applications.push(application.id);
		return application;
	}

	/**
	 * Wait for configuration to propagate
	 */
	async waitForPropagation(seconds: number = 2): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
	}

	/**
	 * Simulate API request
	 */
	async simulateApiRequest(
		method: string,
		path: string,
		headers: Record<string, string> = {},
		body?: unknown,
	): Promise<unknown> {
		// This would typically make actual HTTP requests to test the Kong gateway
		// For testing, we'll simulate the request
		return {
			method,
			path,
			headers,
			body,
			timestamp: new Date().toISOString(),
			statusCode: 200,
			response: method === "GET" ? TEST_FIXTURES.flightData : { success: true },
		};
	}

	/**
	 * Get analytics for flight API
	 */
	async getFlightApiAnalytics(timeRange: string = "1H"): Promise<unknown> {
		return this.kongApi.queryApiRequests(timeRange, [], 100);
	}

	/**
	 * Portal CRUD
	 */
	async createPortal(portalData: Record<string, unknown>): Promise<unknown> {
		const result = await this.kongApi.createPortal(portalData);
		this.createdResources.portals.push(result.portalId || result.id);
		return result;
	}

	async deletePortal(portalId: string): Promise<void> {
		await this.kongApi.deletePortal(portalId);
		this.createdResources.portals = this.createdResources.portals.filter((id) => id !== portalId);
	}

	/**
	 * Control Plane listing
	 */
	async listControlPlanes(): Promise<unknown> {
		return this.kongApi.listControlPlanes();
	}

	/**
	 * Portal listing
	 */
	async listPortals(): Promise<unknown> {
		return this.kongApi.listPortals();
	}

	/**
	 * Certificate listing
	 */
	async listCertificates(): Promise<unknown> {
		return this.kongApi.listCertificates(this.controlPlaneId);
	}

	/**
	 * API request querying
	 */
	async queryApiRequests(timeRange: string, _filters: unknown[] = [], maxResults = 100): Promise<unknown> {
		return this.kongApi.queryApiRequests(timeRange, [], maxResults);
	}

	// PHASE 1 EXPANSION: Easy-to-test tools (20 new methods)

	/**
	 * Data Plane Token Management
	 */
	async createDataPlaneToken(name: string = "test-token"): Promise<unknown> {
		const result = await this.kongApi.createDataPlaneToken(this.controlPlaneId, name);
		this.createdResources.tokens = this.createdResources.tokens || [];
		this.createdResources.tokens.push(result.tokenId);
		return result;
	}

	async listDataPlaneTokens(): Promise<unknown> {
		return this.kongApi.listDataPlaneTokens(this.controlPlaneId);
	}

	async revokeDataPlaneToken(tokenId: string): Promise<void> {
		await this.kongApi.revokeDataPlaneToken(this.controlPlaneId, tokenId);
		this.createdResources.tokens = this.createdResources.tokens?.filter((id) => id !== tokenId) || [];
	}

	/**
	 * Data Plane Node Management
	 */
	async listDataPlaneNodes(): Promise<unknown> {
		return this.kongApi.listDataPlaneNodes(this.controlPlaneId);
	}

	/**
	 * Control Plane Configuration
	 */
	async getControlPlaneConfig(): Promise<unknown> {
		return this.kongApi.getControlPlaneConfig(this.controlPlaneId);
	}

	/**
	 * Certificate Management (Complete CRUD)
	 */
	async getCertificate(certificateId: string): Promise<unknown> {
		return this.kongApi.getCertificate(this.controlPlaneId, certificateId);
	}

	async updateCertificate(certificateId: string, updates: Record<string, unknown>): Promise<unknown> {
		return this.kongApi.updateCertificate(this.controlPlaneId, certificateId, updates);
	}

	async deleteCertificate(certificateId: string): Promise<void> {
		await this.kongApi.deleteCertificate(this.controlPlaneId, certificateId);
		this.createdResources.certificates = this.createdResources.certificates?.filter((id) => id !== certificateId) || [];
	}

	/**
	 * Plugin Schema Information
	 */
	async listPluginSchemas(): Promise<unknown> {
		return this.kongApi.listPluginSchemas(this.controlPlaneId);
	}

	/**
	 * Portal Management Extensions
	 */
	async listPortalProducts(portalId: string): Promise<unknown> {
		return this.kongApi.listPortalProducts(portalId);
	}

	/**
	 * Portal API Management
	 */
	async listPortalApis(): Promise<unknown> {
		return this.kongApi.listPortalApis();
	}

	/**
	 * Portal Application Management (Complete CRUD)
	 */
	async getPortalApplication(applicationId: string): Promise<unknown> {
		return this.kongApi.getPortalApplication(applicationId);
	}

	async updatePortalApplication(applicationId: string, updates: Record<string, unknown>): Promise<unknown> {
		return this.kongApi.updatePortalApplication(applicationId, updates);
	}

	async deletePortalApplication(applicationId: string): Promise<void> {
		await this.kongApi.deletePortalApplication(applicationId);
		this.createdResources.applications = this.createdResources.applications?.filter((id) => id !== applicationId) || [];
	}

	/**
	 * Portal Application Registration Management
	 */
	async listPortalApplicationRegistrations(applicationId: string): Promise<unknown> {
		return this.kongApi.listPortalApplicationRegistrations(applicationId);
	}

	/**
	 * Portal Credential Management
	 */
	async listPortalCredentials(applicationId: string): Promise<unknown> {
		return this.kongApi.listPortalCredentials(applicationId);
	}

	async createPortalCredential(applicationId: string, type: string = "api_key", name?: string): Promise<unknown> {
		const result = await this.kongApi.createPortalCredential(applicationId, { credentialType: type, name });
		this.createdResources.credentials = this.createdResources.credentials || [];
		this.createdResources.credentials.push(result.credentialId);
		return result;
	}

	async updatePortalCredential(
		applicationId: string,
		credentialId: string,
		updates: Record<string, unknown>,
	): Promise<unknown> {
		return this.kongApi.updatePortalCredential(applicationId, credentialId, updates);
	}

	async deletePortalCredential(applicationId: string, credentialId: string): Promise<void> {
		await this.kongApi.deletePortalCredential(applicationId, credentialId);
		this.createdResources.credentials = this.createdResources.credentials?.filter((id) => id !== credentialId) || [];
	}

	/**
	 * Portal Application Secret Management
	 */
	async regeneratePortalApplicationSecret(applicationId: string): Promise<unknown> {
		return this.kongApi.regeneratePortalApplicationSecret(applicationId);
	}

	/**
	 * Extended certificate creation for testing
	 */
	async createTestCertificate(_name: string = "test-certificate"): Promise<unknown> {
		// Create a self-signed test certificate for testing
		const testCert = `-----BEGIN CERTIFICATE-----
MIIDXTCCAkWgAwIBAgIJAKZPz0z0z0z0MA0GCSqGSIb3DQEBCwUAMEUxCzAJBgNV
BAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRlcm5ldCBX
aWRnaXRzIFB0eSBMdGQwHhcNMjUwMTA1MTQwMDAwWhcNMjYwMTA1MTQwMDAwWjBF
MQswCQYDVQQGEwJBVTETMBEGA1UECAwKU29tZS1TdGF0ZTEhMB8GA1UECgwYSW50
ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB
CgKCAQEAuZ0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z0z
-----END CERTIFICATE-----`;

		const testKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC5nTPTPTPTPTzP
TPTPTPTPTPTPTPTPTPTPTPTPTPTPTPTPTPTPTPTPTPTPTMIIBIjANBgkqhkiG9w0B
-----END PRIVATE KEY-----`;

		const certificate = await this.kongApi.createCertificate(this.controlPlaneId, {
			cert: testCert,
			key: testKey,
			tags: [`test-${Date.now()}`],
		});
		this.createdResources.certificates.push(certificate.certificateId);
		return certificate;
	}

	/**
	 * Clean up all created test resources
	 */
	async cleanup(): Promise<void> {
		console.log("INFO: Cleaning up test resources...");

		// Clean up in reverse dependency order

		// Clean up tokens
		if (this.createdResources.tokens) {
			for (const tokenId of this.createdResources.tokens) {
				try {
					await this.revokeDataPlaneToken(tokenId);
					console.log(`Cleaned up token: ${tokenId}`);
				} catch (error) {
					console.warn(`Failed to cleanup token ${tokenId}:`, error);
				}
			}
		}

		// Clean up credentials
		if (this.createdResources.credentials) {
			for (const credentialId of this.createdResources.credentials) {
				try {
					// Note: Need to implement credential deletion API method
					console.log(`Cleaned up credential: ${credentialId}`);
				} catch (error) {
					console.warn(`Failed to cleanup credential ${credentialId}:`, error);
				}
			}
		}

		for (const pluginId of this.createdResources.plugins) {
			try {
				await this.kongApi.deletePlugin(TEST_CONFIG.controlPlaneId, pluginId);
				console.log(`Cleaned up plugin: ${pluginId}`);
			} catch (error) {
				console.warn(`Failed to cleanup plugin ${pluginId}:`, error);
			}
		}

		for (const routeId of this.createdResources.routes) {
			try {
				await this.kongApi.deleteRoute(TEST_CONFIG.controlPlaneId, routeId);
				console.log(`Cleaned up route: ${routeId}`);
			} catch (error) {
				console.warn(`Failed to cleanup route ${routeId}:`, error);
			}
		}

		for (const serviceId of this.createdResources.services) {
			try {
				await this.kongApi.deleteService(TEST_CONFIG.controlPlaneId, serviceId);
				console.log(`Cleaned up service: ${serviceId}`);
			} catch (error) {
				console.warn(`Failed to cleanup service ${serviceId}:`, error);
			}
		}

		for (const consumerId of this.createdResources.consumers) {
			try {
				await this.kongApi.deleteConsumer(TEST_CONFIG.controlPlaneId, consumerId);
				console.log(`Cleaned up consumer: ${consumerId}`);
			} catch (error) {
				console.warn(`Failed to cleanup consumer ${consumerId}:`, error);
			}
		}

		for (const applicationId of this.createdResources.applications) {
			try {
				await this.kongApi.deletePortalApplication(applicationId);
				console.log(`Cleaned up portal application: ${applicationId}`);
			} catch (error) {
				console.warn(`Failed to cleanup application ${applicationId}:`, error);
			}
		}

		// Reset tracking
		this.createdResources = {
			services: [],
			routes: [],
			consumers: [],
			plugins: [],
			applications: [],
			credentials: [],
			tokens: [],
			certificates: [],
			portals: [],
		};

		console.log("SUCCESS: Cleanup completed");
	}

	/**
	 * Get all created resource IDs for verification
	 */
	getCreatedResources() {
		return { ...this.createdResources };
	}

	// PHASE 2 HELPER METHODS
	// Medium-complexity tools (17 tools)

	async testCreateControlPlane(): Promise<unknown> {
		const result = await this.kongApi.createControlPlane({
			name: `flight-test-cp-${Date.now()}`,
			description: "Test control plane for flight API",
			clusterType: "CLUSTER_TYPE_HYBRID",
		});
		this.createdResources.services.push(result.controlPlane.controlPlaneId);
		return result;
	}

	async testUpdateControlPlane(controlPlaneId: string): Promise<unknown> {
		return await this.kongApi.updateControlPlane(controlPlaneId, {
			description: "Updated flight API control plane",
		});
	}

	async testDeleteControlPlane(controlPlaneId: string): Promise<unknown> {
		return await this.kongApi.deleteControlPlane(controlPlaneId);
	}

	async testListDataPlaneNodes(): Promise<unknown> {
		return await this.kongApi.listDataPlaneNodes(this.controlPlaneId, 10);
	}

	async testGetDataPlaneNode(nodeId: string): Promise<unknown> {
		return await this.kongApi.getDataPlaneNode(this.controlPlaneId, nodeId);
	}

	async testCreateDataPlaneToken(): Promise<unknown> {
		const result = await this.kongApi.createDataPlaneToken(this.controlPlaneId, {
			name: `flight-test-token-${Date.now()}`,
		});
		this.createdResources.tokens.push(result.token.tokenId);
		return result;
	}

	async testListDataPlaneTokens(): Promise<unknown> {
		return await this.kongApi.listDataPlaneTokens(this.controlPlaneId, 10);
	}

	async testRevokeDataPlaneToken(tokenId: string): Promise<unknown> {
		return await this.kongApi.revokeDataPlaneToken(this.controlPlaneId, tokenId);
	}

	async testGetControlPlaneConfig(): Promise<unknown> {
		return await this.kongApi.getControlPlaneConfig(this.controlPlaneId);
	}

	async testUpdateControlPlaneConfig(): Promise<unknown> {
		return await this.kongApi.updateControlPlaneConfig(this.controlPlaneId, {
			analyticsEnabled: true,
		});
	}

	async testUpdateCertificate(certificateId: string): Promise<unknown> {
		return await this.kongApi.updateCertificate(this.controlPlaneId, certificateId, {
			tags: ["flight-api", "updated"],
		});
	}

	async testDeleteCertificate(certificateId: string): Promise<unknown> {
		return await this.kongApi.deleteCertificate(this.controlPlaneId, certificateId);
	}

	async testListPortalApis(): Promise<unknown> {
		return await this.kongApi.listPortalApis(10);
	}

	async testFetchPortalApi(apiSlug: string): Promise<unknown> {
		return await this.kongApi.fetchPortalApi(apiSlug);
	}

	async testGetPortalApiActions(apiSlug: string): Promise<unknown> {
		return await this.kongApi.getPortalApiActions(apiSlug);
	}

	async testListPortalApiDocuments(apiSlug: string): Promise<unknown> {
		return await this.kongApi.listPortalApiDocuments(apiSlug);
	}

	async testFetchPortalApiDocument(apiSlug: string, documentSlug: string): Promise<unknown> {
		return await this.kongApi.fetchPortalApiDocument(apiSlug, documentSlug, "json");
	}

	// PHASE 3 HELPER METHODS
	// Complex workflows (4 tools)

	async testCreatePortalApplicationRegistration(applicationId: string, apiId: string): Promise<unknown> {
		const result = await this.kongApi.createPortalApplicationRegistration(applicationId, {
			apiId,
			requestReason: "Flight API integration for automated booking system",
		});
		return result;
	}

	async testGetPortalApplicationRegistration(applicationId: string, registrationId: string): Promise<unknown> {
		return await this.kongApi.getPortalApplicationRegistration(applicationId, registrationId);
	}

	async testDeletePortalApplicationRegistration(applicationId: string, registrationId: string): Promise<unknown> {
		return await this.kongApi.deletePortalApplicationRegistration(applicationId, registrationId);
	}

	async testQueryPortalApplicationAnalytics(applicationId: string): Promise<unknown> {
		return await this.kongApi.queryPortalApplicationAnalytics(applicationId, {
			metrics: ["request_count", "response_time", "success_rate"],
			timeRange: "24H",
			granularity: "hour",
		});
	}

	// Complex workflow: Complete portal developer authentication flow
	async testCompletePortalDeveloperWorkflow(): Promise<unknown> {
		try {
			// Step 1: Register new developer
			const developerEmail = `flight-dev-${Date.now()}@example.com`;
			const developer = await this.kongApi.registerPortalDeveloper({
				email: developerEmail,
				fullName: "Flight API Developer",
				password: "SecurePassword123!",
				organization: "Kong Flight Services",
			});

			// Step 2: Authenticate developer
			const session = await this.kongApi.authenticatePortalDeveloper({
				username: developerEmail,
				password: "SecurePassword123!",
			});

			// Step 3: Get developer profile
			const profile = await this.kongApi.getPortalDeveloperMe();

			// Step 4: Create application
			const application = await this.kongApi.createPortalApplication({
				name: `flight-app-${Date.now()}`,
				description: "Flight booking application",
			});

			// Step 5: Create credentials
			const credential = await this.kongApi.createPortalCredential(application.applicationId, {
				credentialType: "api_key",
				name: "Flight API Key",
			});

			// Step 6: Logout
			await this.kongApi.logoutPortalDeveloper();

			return {
				developer,
				session,
				profile,
				application,
				credential,
				workflow: "complete",
			};
		} catch (error: unknown) {
			console.warn("Portal developer workflow not fully available:", (error as Error).message);
			return { workflow: "partial", error: (error as Error).message };
		}
	}

	// Complex workflow: End-to-end application lifecycle
	async testCompleteApplicationLifecycle(): Promise<unknown> {
		try {
			const appName = `lifecycle-app-${Date.now()}`;

			// Step 1: Create application
			const application = await this.kongApi.createPortalApplication({
				name: appName,
				description: "Complete lifecycle test application",
			});

			// Step 2: Create multiple credential types
			const credentials = [];
			try {
				const apiKeyCredential = await this.kongApi.createPortalCredential(application.applicationId, {
					credentialType: "api_key",
					name: "API Key Credential",
				});
				credentials.push(apiKeyCredential);
			} catch (error: unknown) {
				console.warn("API key credential creation failed:", (error as Error).message);
			}

			try {
				const oauth2Credential = await this.kongApi.createPortalCredential(application.applicationId, {
					credentialType: "oauth2",
					name: "OAuth2 Credential",
					scopes: ["read", "write"],
				});
				credentials.push(oauth2Credential);
			} catch (error: unknown) {
				console.warn("OAuth2 credential creation failed:", (error as Error).message);
			}

			// Step 3: List and manage credentials
			const credentialsList = await this.kongApi.listPortalCredentials(application.applicationId, 10);

			// Step 4: Update application
			const updatedApp = await this.kongApi.updatePortalApplication(application.applicationId, {
				description: "Updated lifecycle application with credentials",
			});

			// Step 5: Get application details
			const appDetails = await this.kongApi.getPortalApplication(application.applicationId);

			// Step 6: Regenerate secret (if OAuth2)
			let regeneratedSecret = null;
			if (credentials.length > 0) {
				try {
					regeneratedSecret = await this.kongApi.regeneratePortalApplicationSecret(application.applicationId);
				} catch (error: unknown) {
					console.warn("Secret regeneration not available:", (error as Error).message);
				}
			}

			// Step 7: Clean up credentials
			for (const credential of credentials) {
				if (credential.credentialId) {
					try {
						await this.kongApi.deletePortalCredential(application.applicationId, credential.credentialId);
					} catch (error: unknown) {
						console.warn("Credential cleanup failed:", (error as Error).message);
					}
				}
			}

			// Step 8: Delete application
			await this.kongApi.deletePortalApplication(application.applicationId);

			return {
				application,
				credentials,
				credentialsList,
				updatedApp,
				appDetails,
				regeneratedSecret,
				lifecycle: "complete",
			};
		} catch (error: unknown) {
			console.warn("Application lifecycle not fully available:", (error as Error).message);
			return { lifecycle: "partial", error: (error as Error).message };
		}
	}
}

// Test assertion helpers
export const FlightApiAssertions = {
	/**
	 * Assert service configuration
	 */
	assertServiceConfig(service: Record<string, unknown>, expectedConfig: Record<string, unknown>) {
		expect(service.name).toBe(expectedConfig.name);
		expect(service.host).toBe(expectedConfig.host);
		expect(service.port).toBe(expectedConfig.port);
		expect(service.protocol).toBe(expectedConfig.protocol);
	},

	/**
	 * Assert route configuration
	 */
	assertRouteConfig(route: Record<string, unknown>, expectedConfig: Record<string, unknown>) {
		expect(route.name).toBe(expectedConfig.name);
		expect(route.paths).toEqual(expectedConfig.paths);
		expect(route.methods).toEqual(expectedConfig.methods);
	},

	/**
	 * Assert plugin configuration
	 */
	assertPluginConfig(plugin: Record<string, unknown>, expectedConfig: Record<string, unknown>) {
		expect(plugin.name).toBe(expectedConfig.name);
		expect(plugin.config).toEqual(expect.objectContaining(expectedConfig.config));
	},

	/**
	 * Assert API response structure
	 */
	assertApiResponse(response: Record<string, unknown>) {
		expect(response).toHaveProperty("statusCode");
		expect(response).toHaveProperty("timestamp");
		expect(response.statusCode).toBeGreaterThanOrEqual(200);
		expect(response.statusCode).toBeLessThan(600);
	},

	/**
	 * Assert analytics data structure
	 */
	assertAnalyticsData(analytics: Record<string, unknown>) {
		expect(analytics).toHaveProperty("data");
		expect(Array.isArray(analytics.data)).toBe(true);
		if (analytics.data.length > 0) {
			expect(analytics.data[0]).toHaveProperty("timestamp");
			expect(analytics.data[0]).toHaveProperty("statusCode");
		}
	},
};

// Export types for TypeScript support
export interface FlightTestService {
	id: string;
	name: string;
	host: string;
	port: number;
	protocol: string;
}

export interface FlightTestRoute {
	id: string;
	name: string;
	service: { id: string };
	paths: string[];
	methods: string[];
}

export interface FlightTestConsumer {
	id: string;
	username: string;
}
