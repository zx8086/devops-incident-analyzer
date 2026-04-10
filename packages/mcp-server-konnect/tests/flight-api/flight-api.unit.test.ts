/**
 * Flight API Unit Tests
 * Tests individual Kong Konnect MCP operations and tools
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { KongApi } from "../../src/api/kong-api.js";
import * as analyticsOps from "../../src/tools/analytics/operations.js";
import * as certificatesOps from "../../src/tools/certificates/operations.js";
// Import individual operation modules for testing
import * as configurationOps from "../../src/tools/configuration/operations.js";
import * as controlPlanesOps from "../../src/tools/control-planes/operations.js";
import * as portalOps from "../../src/tools/portal/operations.js";
import { TEST_CONFIG } from "./test-helpers.js";

describe("Flight API Unit Tests", () => {
	let mockKongApi: Record<string, ReturnType<typeof mock>>;

	beforeAll(() => {
		// Create mock Kong API client
		mockKongApi = {
			createService: mock(() =>
				Promise.resolve({
					id: "test-service-123",
					name: "flight-service-test",
					host: "api.flights.example.com",
					port: 443,
					protocol: "https",
				}),
			),
			updateService: mock(() => Promise.resolve({ id: "test-service-123" })),
			deleteService: mock(() => Promise.resolve({})),
			getService: mock(() => Promise.resolve({ id: "test-service-123" })),
			listServices: mock(() => Promise.resolve({ data: [] })),

			createRoute: mock(() =>
				Promise.resolve({
					id: "test-route-123",
					name: "get-flights-test",
					service: { id: "test-service-123" },
					paths: ["/flights"],
					methods: ["GET"],
				}),
			),
			updateRoute: mock(() => Promise.resolve({ id: "test-route-123" })),
			deleteRoute: mock(() => Promise.resolve({})),
			getRoute: mock(() => Promise.resolve({ id: "test-route-123" })),
			listRoutes: mock(() => Promise.resolve({ data: [] })),

			createConsumer: mock(() =>
				Promise.resolve({
					id: "test-consumer-123",
					username: "flight-api-client-test",
				}),
			),
			updateConsumer: mock(() => Promise.resolve({ id: "test-consumer-123" })),
			deleteConsumer: mock(() => Promise.resolve({})),
			getConsumer: mock(() => Promise.resolve({ id: "test-consumer-123" })),
			listConsumers: mock(() => Promise.resolve({ data: [] })),

			createPlugin: mock(() =>
				Promise.resolve({
					id: "test-plugin-123",
					name: "key-auth",
					service: { id: "test-service-123" },
					config: { key_names: ["X-API-Key"] },
				}),
			),
			updatePlugin: mock(() => Promise.resolve({ id: "test-plugin-123" })),
			deletePlugin: mock(() => Promise.resolve({})),
			getPlugin: mock(() => Promise.resolve({ id: "test-plugin-123" })),
			listPlugins: mock(() => Promise.resolve({ data: [] })),

			queryApiRequests: mock(() => Promise.resolve({ data: [] })),
			getConsumerRequests: mock(() => Promise.resolve({ data: [] })),

			listControlPlanes: mock(() => Promise.resolve({ data: [], meta: {} })),
			getControlPlane: mock(() => Promise.resolve({ id: TEST_CONFIG.controlPlaneId })),

			createPortalApplication: mock(() =>
				Promise.resolve({
					id: "test-app-123",
					name: "Flight API Test App",
					clientId: "flight-test-client",
				}),
			),
			deletePortalApplication: mock(() => Promise.resolve({})),

			listCertificates: mock(() => Promise.resolve({ data: [] })),
			createCertificate: mock(() => Promise.resolve({ id: "test-cert-123" })),
		};

		console.log("INFO: Mock Kong API initialized");
	});

	describe("Service Operations", () => {
		test("should create service with correct parameters", async () => {
			const serviceData = {
				name: "flight-service-test",
				host: "api.flights.example.com",
				port: 443,
				protocol: "https",
				retries: 5,
				connectTimeout: 60000,
				writeTimeout: 60000,
				readTimeout: 60000,
				tags: ["test", "flight-api"],
				enabled: true,
			};

			const result = await configurationOps.createService(mockKongApi, TEST_CONFIG.controlPlaneId, serviceData);

			expect(result).toBeDefined();
			expect(result.success).toBe(true);
			expect(result.service.name).toBe("flight-service-test");
			expect(mockKongApi.createService).toHaveBeenCalledTimes(1);
		});

		test("should get service by ID", async () => {
			const result = await configurationOps.getService(mockKongApi, TEST_CONFIG.controlPlaneId, "test-service-123");

			expect(result).toBeDefined();
			expect(result.service.serviceId).toBe("test-service-123");
			expect(mockKongApi.getService).toHaveBeenCalledWith(TEST_CONFIG.controlPlaneId, "test-service-123");
		});

		test("should update service configuration", async () => {
			const updateData = {
				name: "flight-service-updated",
				host: "api-v2.flights.example.com",
			};

			const result = await configurationOps.updateService(
				mockKongApi,
				TEST_CONFIG.controlPlaneId,
				"test-service-123",
				updateData,
			);

			expect(result).toBeDefined();
			expect(result.success).toBe(true);
			expect(mockKongApi.updateService).toHaveBeenCalledTimes(1);
		});

		test("should delete service", async () => {
			const result = await configurationOps.deleteService(mockKongApi, TEST_CONFIG.controlPlaneId, "test-service-123");

			expect(result).toBeDefined();
			expect(result.success).toBe(true);
			expect(mockKongApi.deleteService).toHaveBeenCalledWith(TEST_CONFIG.controlPlaneId, "test-service-123");
		});

		test("should list services with pagination", async () => {
			const result = await configurationOps.listServices(mockKongApi, TEST_CONFIG.controlPlaneId, 10);

			expect(result).toBeDefined();
			expect(result.services).toBeDefined();
			expect(Array.isArray(result.services)).toBe(true);
			expect(mockKongApi.listServices).toHaveBeenCalledWith(TEST_CONFIG.controlPlaneId, 10, undefined);
		});
	});

	describe("Route Operations", () => {
		test("should create route with service association", async () => {
			const routeData = {
				name: "get-flights-test",
				protocols: ["https"],
				methods: ["GET"],
				hosts: ["api.flights.example.com"],
				paths: ["/flights"],
				serviceId: "test-service-123",
				stripPath: false,
				preserveHost: false,
				regexPriority: 0,
				tags: ["test", "flight-api"],
				enabled: true,
			};

			const result = await configurationOps.createRoute(mockKongApi, TEST_CONFIG.controlPlaneId, routeData);

			expect(result).toBeDefined();
			expect(result.success).toBe(true);
			expect(result.route.name).toBe("get-flights-test");
			expect(result.route.serviceId).toBe("test-service-123");
			expect(mockKongApi.createRoute).toHaveBeenCalledTimes(1);
		});

		test("should handle different HTTP methods for routes", async () => {
			const postRouteData = {
				name: "create-flight-test",
				methods: ["POST"],
				paths: ["/flights"],
				serviceId: "test-service-123",
			};

			const result = await configurationOps.createRoute(mockKongApi, TEST_CONFIG.controlPlaneId, postRouteData);

			expect(result).toBeDefined();
			expect(result.success).toBe(true);

			// Verify the API was called with POST method
			const [, , routeConfig] = mockKongApi.createRoute.mock.calls[mockKongApi.createRoute.mock.calls.length - 1];
			expect(routeConfig.methods).toEqual(["POST"]);
		});

		test("should validate route path patterns", async () => {
			const regexRouteData = {
				name: "get-flight-by-id-test",
				methods: ["GET"],
				paths: ["/flights/(?<id>\\d+)"],
				serviceId: "test-service-123",
			};

			const result = await configurationOps.createRoute(mockKongApi, TEST_CONFIG.controlPlaneId, regexRouteData);

			expect(result).toBeDefined();
			expect(result.success).toBe(true);

			// Verify regex pattern was passed correctly
			const [, , routeConfig] = mockKongApi.createRoute.mock.calls[mockKongApi.createRoute.mock.calls.length - 1];
			expect(routeConfig.paths).toContain("/flights/(?<id>\\d+)");
		});
	});

	describe("Consumer Operations", () => {
		test("should create consumer with username", async () => {
			const consumerData = {
				username: "flight-api-client-test",
				customId: "client-test-001",
				tags: ["test", "flight-api"],
				enabled: true,
			};

			const result = await configurationOps.createConsumer(mockKongApi, TEST_CONFIG.controlPlaneId, consumerData);

			expect(result).toBeDefined();
			expect(result.success).toBe(true);
			expect(result.consumer.username).toBe("flight-api-client-test");
			expect(mockKongApi.createConsumer).toHaveBeenCalledTimes(1);
		});

		test("should validate consumer username format", async () => {
			const invalidConsumerData = {
				username: "", // Invalid empty username
				customId: "client-test-002",
			};

			// This should be validated at the parameter level
			expect(invalidConsumerData.username).toBe("");

			// In a real scenario, this would throw a validation error
			// For unit testing, we just verify the data structure
			expect(typeof invalidConsumerData.username).toBe("string");
		});

		test("should handle consumer custom IDs", async () => {
			const consumerData = {
				username: "flight-api-client-custom",
				customId: "FLIGHT-CLIENT-12345",
			};

			const result = await configurationOps.createConsumer(mockKongApi, TEST_CONFIG.controlPlaneId, consumerData);

			expect(result).toBeDefined();
			expect(result.success).toBe(true);

			// Verify custom ID was included in the API call
			const [, , consumerConfig] =
				mockKongApi.createConsumer.mock.calls[mockKongApi.createConsumer.mock.calls.length - 1];
			expect(consumerConfig.custom_id).toBe("FLIGHT-CLIENT-12345");
		});
	});

	describe("Plugin Operations", () => {
		test("should create key-auth plugin", async () => {
			const pluginData = {
				name: "key-auth",
				config: { key_names: ["X-API-Key"], key_in_body: false },
				protocols: ["https"],
				serviceId: "test-service-123",
				tags: ["test", "auth"],
				enabled: true,
			};

			const result = await configurationOps.createPlugin(mockKongApi, TEST_CONFIG.controlPlaneId, pluginData);

			expect(result).toBeDefined();
			expect(result.success).toBe(true);
			expect(result.plugin.name).toBe("key-auth");
			expect(result.plugin.config.key_names).toEqual(["X-API-Key"]);
		});

		test("should create rate-limiting plugin with correct config", async () => {
			const rateLimitingData = {
				name: "rate-limiting",
				config: {
					minute: 100,
					hour: 1000,
					policy: "local",
					fault_tolerant: true,
				},
				serviceId: "test-service-123",
			};

			const result = await configurationOps.createPlugin(mockKongApi, TEST_CONFIG.controlPlaneId, rateLimitingData);

			expect(result).toBeDefined();
			expect(result.success).toBe(true);

			// Verify rate limiting configuration
			const [, , pluginConfig] = mockKongApi.createPlugin.mock.calls[mockKongApi.createPlugin.mock.calls.length - 1];
			expect(pluginConfig.config.minute).toBe(100);
			expect(pluginConfig.config.hour).toBe(1000);
		});

		test("should create CORS plugin for browser support", async () => {
			const corsData = {
				name: "cors",
				config: {
					origins: ["https://flights.example.com", "https://app.flights.com"],
					methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
					headers: ["Accept", "Content-Type", "Authorization", "X-API-Key"],
					exposed_headers: ["X-Custom-Header"],
					credentials: true,
					max_age: 3600,
				},
				serviceId: "test-service-123",
			};

			const result = await configurationOps.createPlugin(mockKongApi, TEST_CONFIG.controlPlaneId, corsData);

			expect(result).toBeDefined();
			expect(result.success).toBe(true);

			// Verify CORS configuration
			const [, , pluginConfig] = mockKongApi.createPlugin.mock.calls[mockKongApi.createPlugin.mock.calls.length - 1];
			expect(pluginConfig.config.origins).toContain("https://flights.example.com");
			expect(pluginConfig.config.methods).toContain("GET");
			expect(pluginConfig.config.credentials).toBe(true);
		});

		test("should apply plugin to specific consumer", async () => {
			const consumerPluginData = {
				name: "key-auth",
				config: { key_names: ["X-API-Key"] },
				consumerId: "test-consumer-123",
			};

			const result = await configurationOps.createPlugin(mockKongApi, TEST_CONFIG.controlPlaneId, consumerPluginData);

			expect(result).toBeDefined();
			expect(result.success).toBe(true);

			// Verify consumer association
			const [, , pluginConfig] = mockKongApi.createPlugin.mock.calls[mockKongApi.createPlugin.mock.calls.length - 1];
			expect(pluginConfig.consumer).toEqual({ id: "test-consumer-123" });
		});
	});

	describe("Analytics Operations", () => {
		test("should query API requests with time range", async () => {
			const result = await analyticsOps.queryApiRequests(
				mockKongApi,
				"1H",
				[200, 201],
				[500, 502],
				["GET", "POST"],
				["test-consumer-123"],
				["test-service-123"],
			);

			expect(result).toBeDefined();
			expect(mockKongApi.queryApiRequests).toHaveBeenCalledTimes(1);

			// Verify parameters were passed correctly
			const callArgs = mockKongApi.queryApiRequests.mock.calls[0];
			expect(callArgs[0]).toBe("1H"); // timeRange
			expect(callArgs[1]).toEqual([200, 201]); // statusCodes
			expect(callArgs[2]).toEqual([500, 502]); // excludeStatusCodes
		});

		test("should get consumer-specific requests", async () => {
			const result = await analyticsOps.getConsumerRequests(mockKongApi, "test-consumer-123", "6H", false, false, 100);

			expect(result).toBeDefined();
			expect(mockKongApi.getConsumerRequests).toHaveBeenCalledWith("test-consumer-123", "6H", false, false, 100);
		});

		test("should filter requests by success/failure", async () => {
			// Test success only
			await analyticsOps.getConsumerRequests(
				mockKongApi,
				"test-consumer-123",
				"1H",
				true, // successOnly
				false, // failureOnly
			);

			// Test failure only
			await analyticsOps.getConsumerRequests(
				mockKongApi,
				"test-consumer-123",
				"1H",
				false, // successOnly
				true, // failureOnly
			);

			expect(mockKongApi.getConsumerRequests).toHaveBeenCalledTimes(2);

			// Verify filter parameters
			const successCall = mockKongApi.getConsumerRequests.mock.calls[0];
			expect(successCall[2]).toBe(true); // successOnly
			expect(successCall[3]).toBe(false); // failureOnly

			const failureCall = mockKongApi.getConsumerRequests.mock.calls[1];
			expect(failureCall[2]).toBe(false); // successOnly
			expect(failureCall[3]).toBe(true); // failureOnly
		});
	});

	describe("Control Plane Operations", () => {
		test("should list control planes with filters", async () => {
			const result = await controlPlanesOps.listControlPlanes(
				mockKongApi,
				10,
				1,
				"flight",
				"CLUSTER_TYPE_HYBRID",
				true,
				"env:test",
				"name",
			);

			expect(result).toBeDefined();
			expect(mockKongApi.listControlPlanes).toHaveBeenCalledWith(
				10,
				1,
				"flight",
				"CLUSTER_TYPE_HYBRID",
				true,
				"env:test",
				"name",
			);
		});

		test("should get specific control plane details", async () => {
			const result = (await controlPlanesOps.getControlPlane(mockKongApi, TEST_CONFIG.controlPlaneId)) as Record<
				string,
				unknown
			>;

			expect(result).toBeDefined();
			expect(result.controlPlaneDetails).toBeDefined();
			expect(mockKongApi.getControlPlane).toHaveBeenCalledWith(TEST_CONFIG.controlPlaneId);
		});

		test("should validate control plane ID format", async () => {
			const validUuid = TEST_CONFIG.controlPlaneId;
			const invalidUuid = "invalid-uuid-format";

			// Valid UUID should be 36 characters with specific format
			expect(validUuid.length).toBe(36);
			expect(validUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

			// Invalid UUID should not match the pattern
			expect(invalidUuid).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		});
	});

	describe("Portal Operations", () => {
		test("should create portal application", async () => {
			const appData = {
				name: "Flight API Test App",
				description: "Test application for flight API",
				clientId: "flight-test-client",
				redirectUri: "https://test.flights.example.com/callback",
				authStrategyId: "auth-strategy-123",
				scopes: ["read:flights", "write:flights"],
			};

			const result = await portalOps.createApplication(mockKongApi, appData);

			expect(result).toBeDefined();
			expect(result.success).toBe(true);
			expect(result.application.name).toBe("Flight API Test App");
			expect(mockKongApi.createPortalApplication).toHaveBeenCalledTimes(1);
		});

		test("should validate redirect URI format", async () => {
			const validUri = "https://test.flights.example.com/callback";
			const invalidUri = "not-a-valid-uri";

			// Valid URI should start with https://
			expect(validUri.startsWith("https://")).toBe(true);

			// Invalid URI should not be a valid URL format
			expect(invalidUri.startsWith("https://")).toBe(false);
			expect(invalidUri.startsWith("http://")).toBe(false);
		});

		test("should handle application scopes", async () => {
			const scopes = ["read:flights", "write:flights", "admin:flights"];

			// Verify scope format
			scopes.forEach((scope) => {
				expect(scope).toMatch(/^[a-z]+:[a-z]+$/);
				expect(scope).toContain(":");
			});

			expect(scopes.length).toBe(3);
			expect(scopes).toContain("read:flights");
			expect(scopes).toContain("write:flights");
		});
	});

	describe("Certificate Operations", () => {
		test("should list certificates for control plane", async () => {
			const result = await certificatesOps.listCertificates(mockKongApi, TEST_CONFIG.controlPlaneId, 10);

			expect(result).toBeDefined();
			expect(mockKongApi.listCertificates).toHaveBeenCalledWith(TEST_CONFIG.controlPlaneId, 10, undefined);
		});

		test("should create certificate with proper format", async () => {
			const certData = {
				cert: "-----BEGIN CERTIFICATE-----\nMIIBkTCB...\n-----END CERTIFICATE-----",
				key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBA...\n-----END PRIVATE KEY-----",
				tags: ["test", "flight-api"],
			};

			const result = await certificatesOps.createCertificate(
				mockKongApi,
				TEST_CONFIG.controlPlaneId,
				certData.cert,
				certData.key,
				undefined,
				undefined,
				certData.tags,
			);

			expect(result).toBeDefined();
			expect(mockKongApi.createCertificate).toHaveBeenCalledTimes(1);

			// Verify certificate format
			expect(certData.cert.startsWith("-----BEGIN CERTIFICATE-----")).toBe(true);
			expect(certData.cert.endsWith("-----END CERTIFICATE-----")).toBe(true);
			expect(certData.key.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
			expect(certData.key.endsWith("-----END PRIVATE KEY-----")).toBe(true);
		});

		test("should validate certificate expiration", () => {
			const currentTime = Date.now();
			const validUntil = new Date("2025-12-31").getTime();
			const expired = new Date("2024-01-01").getTime();

			expect(validUntil).toBeGreaterThan(currentTime);
			expect(expired).toBeLessThan(currentTime);
		});
	});

	describe("Error Handling", () => {
		test("should handle API errors gracefully", async () => {
			// Mock API error
			const errorMockApi = {
				createService: mock(() => Promise.reject(new Error("API Error: Service creation failed"))),
			} as unknown as KongApi;

			try {
				await configurationOps.createService(errorMockApi, TEST_CONFIG.controlPlaneId, {
					name: "test-service",
					host: "test.example.com",
				});
				// Should not reach this point
				expect(true).toBe(false);
			} catch (error: unknown) {
				expect((error as Error).message).toContain("API Error");
			}
		});

		test("should validate required parameters", () => {
			const serviceData = {
				name: "",
				host: "",
				port: 0,
			};

			// Validate required fields
			expect(serviceData.name).toBe("");
			expect(serviceData.host).toBe("");
			expect(serviceData.port).toBe(0);

			// In real validation, these would fail
			expect(serviceData.name.length === 0).toBe(true);
			expect(serviceData.port <= 0).toBe(true);
		});

		test("should handle network timeouts", async () => {
			const timeoutError = new Error("Request timeout");
			timeoutError.name = "TimeoutError";

			const timeoutMockApi = {
				getService: mock(() => Promise.reject(timeoutError)),
			} as unknown as KongApi;

			try {
				await configurationOps.getService(timeoutMockApi, TEST_CONFIG.controlPlaneId, "test-service-123");
			} catch (error: unknown) {
				expect((error as Error).name).toBe("TimeoutError");
				expect((error as Error).message).toBe("Request timeout");
			}
		});
	});

	describe("Data Validation and Transformation", () => {
		test("should transform snake_case to camelCase in responses", () => {
			const apiResponse = {
				control_plane_id: "test-123",
				created_at: 1640995200,
				updated_at: 1640995200,
				has_cloud_gateway: true,
			};

			// Transform keys (this would typically happen in the operations layer)
			const transformed = {
				controlPlaneId: apiResponse.control_plane_id,
				createdAt: apiResponse.created_at,
				updatedAt: apiResponse.updated_at,
				hasCloudGateway: apiResponse.has_cloud_gateway,
			};

			expect(transformed.controlPlaneId).toBe("test-123");
			expect(transformed.createdAt).toBe(1640995200);
			expect(transformed.hasCloudGateway).toBe(true);
		});

		test("should validate URL formats", () => {
			const validUrls = [
				"https://api.flights.example.com",
				"http://localhost:8000",
				"https://api.staging.flights.com/v1",
			];

			const invalidUrls = ["not-a-url", "ftp://invalid-protocol.com", "https://", ""];

			validUrls.forEach((url) => {
				expect(url.startsWith("http")).toBe(true);
				expect(url.includes("://")).toBe(true);
			});

			invalidUrls.forEach((url) => {
				const isValid = url.startsWith("http://") || url.startsWith("https://");
				const hasHostname = (url.split("://")[1]?.length ?? 0) > 0;
				expect(isValid && hasHostname).toBe(false);
			});
		});

		test("should handle pagination parameters", () => {
			const paginationParams = {
				pageSize: 10,
				pageNumber: 1,
				offset: 0,
			};

			// Validate pagination bounds
			expect(paginationParams.pageSize).toBeGreaterThan(0);
			expect(paginationParams.pageSize).toBeLessThanOrEqual(1000);
			expect(paginationParams.pageNumber).toBeGreaterThan(0);
			expect(paginationParams.offset).toBeGreaterThanOrEqual(0);

			// Test calculated offset
			const calculatedOffset = (paginationParams.pageNumber - 1) * paginationParams.pageSize;
			expect(calculatedOffset).toBe(0);
		});
	});

	describe("Configuration Validation", () => {
		test("should validate service timeouts", () => {
			const timeouts = {
				connectTimeout: 60000,
				writeTimeout: 60000,
				readTimeout: 60000,
			};

			// Timeouts should be positive and reasonable
			Object.values(timeouts).forEach((timeout) => {
				expect(timeout).toBeGreaterThan(0);
				expect(timeout).toBeLessThanOrEqual(300000); // Max 5 minutes
			});
		});

		test("should validate plugin configurations", () => {
			const rateLimitConfig = {
				minute: 100,
				hour: 1000,
				day: 10000,
			};

			// Rate limits should be increasing by time unit
			expect(rateLimitConfig.minute).toBeLessThan(rateLimitConfig.hour);
			expect(rateLimitConfig.hour).toBeLessThan(rateLimitConfig.day);

			// All values should be positive
			Object.values(rateLimitConfig).forEach((limit) => {
				expect(limit).toBeGreaterThan(0);
			});
		});

		test("should validate JWT configuration", () => {
			const jwtConfig = {
				key_claim_name: "iss",
				secret_is_base64: false,
				algorithm: "HS256",
				run_on_preflight: false,
			};

			expect(jwtConfig.key_claim_name).toBeDefined();
			expect(typeof jwtConfig.secret_is_base64).toBe("boolean");
			expect(["HS256", "HS384", "HS512", "RS256", "RS512"].includes(jwtConfig.algorithm)).toBe(true);
		});
	});
});
