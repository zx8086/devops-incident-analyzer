import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { API_REGIONS, KongApi } from "./api/kong-api.js";
import { loadConfiguration } from "./config/index.js";
import { initTelemetry, shutdownTelemetry, type TelemetryConfig } from "./telemetry/telemetry.js";
import * as analyticsOps from "./tools/analytics/operations.js";
import * as certificatesOps from "./tools/certificates/operations.js";
import * as configurationOps from "./tools/configuration/operations.js";
import * as controlPlanesOps from "./tools/control-planes/operations.js";
import { ElicitationOperations } from "./tools/elicitation-tool.js";
import { enhancedKongTools } from "./tools/enhanced-kong-tools.js";
import * as portalOps from "./tools/portal/operations.js";
import * as portalManagementOps from "./tools/portal-management/operations.js";
import { getAllTools, validateToolRegistry } from "./tools/registry.js";
import type { TransportResult } from "./transport/index.ts";
import { createTransport } from "./transport/index.ts";
import { getEnvVar, getEnvVarWithDefault, getRuntimeInfo, initializeEnvironment } from "./utils/env.js";
import { formatError } from "./utils/error-handling.js";
import { mcpLogger } from "./utils/mcp-logger.js";
import { mcpPaginator } from "./utils/pagination.js";
import {
	createSessionContext,
	detectClient,
	generateSessionId,
	getCurrentSession,
	logSessionInfo,
	runWithSession,
} from "./utils/session-manager.js";
import { ToolPerformanceCollector } from "./utils/tool-tracer.js";
import { initializeTracing, isTracingActive, logTracingStatus, traceToolCall } from "./utils/tracing.js";

/**
 * Enhanced MCP server class for Kong Konnect integration with modular architecture
 */
class KongKonnectMcpServer extends McpServer {
	private api: KongApi;
	private performanceCollector: ToolPerformanceCollector;
	private elicitationOps: ElicitationOperations;

	constructor(options: { apiKey?: string; apiRegion?: string } = {}) {
		super({
			name: "kong-konnect-mcp",
			version: "2.0.0",
			description:
				"Comprehensive Kong Konnect API Gateway management with analytics, configuration, certificates, and more",
			capabilities: {
				tools: {},
				elicitation: {},
				logging: {},
			},
		});

		// Initialize the API client with universal environment access
		this.api = new KongApi({
			apiKey: options.apiKey || getEnvVar("KONNECT_ACCESS_TOKEN"),
			apiRegion: options.apiRegion || getEnvVarWithDefault("KONNECT_REGION", API_REGIONS.US),
		});

		// Initialize tracing and performance monitoring
		initializeTracing();
		this.performanceCollector = new ToolPerformanceCollector();
		this.elicitationOps = new ElicitationOperations();

		// MCP logging will be initialized after server setup

		// Log session information for tracing
		this.logMCPSessionInfo();

		// Validate tool registry
		const validation = validateToolRegistry();
		if (!validation.isValid) {
			mcpLogger.critical("server", "Tool registry validation failed", {
				errors: validation.errors,
			});
			throw new Error(`Invalid tool registry: ${validation.errors.join(", ")}`);
		}

		// Log tracing status to stderr (never stdout for MCP servers!)
		logTracingStatus();

		// Register all tools
		this.registerTools();

		// Override default tools/list handler to provide pagination
		// TEMPORARILY DISABLED: this.registerPaginatedToolsList();

		// MCP-compliant logging will be initialized after server creation
	}

	/**
	 * Register paginated tools/list handler per MCP specification
	 */
	private registerPaginatedToolsList() {
		this.setRequestHandler({ method: "tools/list" }, async (request) => {
			const allTools = getAllTools();

			try {
				// Extract pagination parameters (only cursor is in official MCP schema)
				const cursor = request.params?.cursor;

				// Use fixed page size since pageSize isn't in MCP schema
				// Category filtering via custom tools/categories endpoint instead

				mcpLogger.debug("tools", "Tools list requested", {
					cursor: cursor ? "[CURSOR]" : undefined,
					totalTools: allTools.length,
				});

				// Apply pagination (use default page size since not in MCP schema)
				const paginatedResult = mcpPaginator.paginateTools(allTools, {
					cursor,
				});

				// Transform tools to official MCP Tool schema format
				const mcpTools = paginatedResult.items.map((tool) => ({
					name: tool.method,
					description: tool.description,
					inputSchema: {
						type: "object" as const,
						properties: tool.parameters.shape || {},
						required: [],
					},
				}));

				// Prepare response according to MCP spec
				const response: any = {
					tools: mcpTools,
				};

				// Add nextCursor if more results exist
				if (paginatedResult.nextCursor) {
					response.nextCursor = paginatedResult.nextCursor;
				}

				mcpLogger.debug("tools", "Tools list response", {
					returnedTools: mcpTools.length,
					hasNextPage: !!paginatedResult.nextCursor,
					categories: [...new Set(paginatedResult.items.map((t) => t.category))],
				});

				return response;
			} catch (error: any) {
				mcpLogger.error("tools", "Tools list pagination error", {
					error: error.message,
					cursor: request.params?.cursor ? "[INVALID]" : undefined,
				});

				// Return error per MCP spec for invalid cursor
				throw {
					code: -32602,
					message: "Invalid params",
					data: { error: error.message },
				};
			}
		});

		// Register tools/categories helper method for client navigation
		this.setRequestHandler({ method: "tools/categories" }, async (request) => {
			const allTools = getAllTools();
			const categories = mcpPaginator.getToolCategories(allTools);

			mcpLogger.debug("tools", "Tool categories requested", {
				categoriesCount: categories.length,
				categories,
			});

			return {
				categories: categories.map((category) => ({
					name: category,
					toolCount: allTools.filter((tool) => tool.category === category).length,
				})),
			};
		});
	}

	private registerTools() {
		const allTools = getAllTools();

		mcpLogger.notice("server", "Native MCP elicitation active");
		mcpLogger.info("server", "Registering tools", {
			toolCount: allTools.length,
			categories: [...new Set(allTools.map((t) => t.category))],
		});

		// Kong modification operations using enhanced MCP elicitation - DISABLED FOR CLAUDE DESKTOP
		const ENHANCED_KONG_OPERATIONS = new Set([
			// 'create_service', 'create_route', 'create_consumer', 'create_plugin'
		]);

		allTools.forEach((tool) => {
			// Check if this is an enhanced Kong operation
			const isEnhancedKongOperation = ENHANCED_KONG_OPERATIONS.has(tool.method);

			let handler: (args: any, extra: RequestHandlerExtra<any, any>) => Promise<any>;

			if (isEnhancedKongOperation) {
				// Use enhanced operation handler with native MCP elicitation
				mcpLogger.debug("server", "Registering enhanced operation", {
					method: tool.method,
				});
				handler = async (args: any, extra: RequestHandlerExtra<any, any>) => {
					switch (tool.method) {
						case "create_service":
							return await enhancedKongTools.createServiceWithElicitation(this.api, args, extra);
						case "create_route":
							return await enhancedKongTools.createRouteWithElicitation(this.api, args, extra);
						case "create_consumer":
							return await enhancedKongTools.createConsumerWithElicitation(this.api, args, extra);
						case "create_plugin":
							return await enhancedKongTools.createPluginWithElicitation(this.api, args, extra);
						default:
							throw new Error(`Enhanced operation ${tool.method} not implemented`);
					}
				};
			} else {
				// Use original handler logic for non-blocked operations
				handler = async (args: any, extra: RequestHandlerExtra<any, any>) => {
					const startTime = Date.now();
					let success = true;

					try {
						let result;

						// Route to appropriate handler based on method
						switch (tool.method) {
							// ===========================
							// Analytics Tools
							// ===========================
							case "query_api_requests":
								result = await analyticsOps.queryApiRequests(
									this.api,
									args.timeRange,
									args.statusCodes,
									args.excludeStatusCodes,
									args.httpMethods,
									args.consumerIds,
									args.serviceIds,
									args.routeIds,
									args.maxResults,
								);
								break;

							case "get_consumer_requests":
								result = await analyticsOps.getConsumerRequests(
									this.api,
									args.consumerId,
									args.timeRange,
									args.successOnly,
									args.failureOnly,
									args.maxResults,
								);
								break;

							// ===========================
							// Control Planes Tools
							// ===========================
							case "list_control_planes":
								result = await controlPlanesOps.listControlPlanes(
									this.api,
									args.pageSize,
									args.pageNumber,
									args.filterName,
									args.filterClusterType,
									args.filterCloudGateway,
									args.labels,
									args.sort,
								);
								break;

							case "get_control_plane":
								result = await controlPlanesOps.getControlPlane(this.api, args.controlPlaneId);
								break;

							case "list_control_plane_group_memberships":
								result = await controlPlanesOps.listControlPlaneGroupMemberships(
									this.api,
									args.groupId,
									args.pageSize,
									args.pageAfter,
								);
								break;

							case "check_control_plane_group_membership":
								result = await controlPlanesOps.checkControlPlaneGroupMembership(this.api, args.controlPlaneId);
								break;

							// Control Plane CRUD Operations
							case "create_control_plane":
								result = await controlPlanesOps.createControlPlane(this.api, {
									name: args.name,
									description: args.description,
									clusterType: args.clusterType,
									cloudGateway: args.cloudGateway,
									authType: args.authType,
									proxyUrls: args.proxyUrls,
									labels: args.labels,
								});
								break;

							case "update_control_plane":
								result = await controlPlanesOps.updateControlPlane(this.api, args.controlPlaneId, {
									name: args.name,
									description: args.description,
									labels: args.labels,
								});
								break;

							case "delete_control_plane":
								result = await controlPlanesOps.deleteControlPlane(this.api, args.controlPlaneId);
								break;

							// Data Plane Node Management
							case "list_data_plane_nodes":
								result = await controlPlanesOps.listDataPlaneNodes(
									this.api,
									args.controlPlaneId,
									args.pageSize,
									args.pageNumber,
									args.filterStatus,
									args.filterHostname,
								);
								break;

							case "get_data_plane_node":
								result = await controlPlanesOps.getDataPlaneNode(this.api, args.controlPlaneId, args.nodeId);
								break;

							// Data Plane Token Management
							case "create_data_plane_token":
								result = await controlPlanesOps.createDataPlaneToken(
									this.api,
									args.controlPlaneId,
									args.name,
									args.expiresAt,
								);
								break;

							case "list_data_plane_tokens":
								result = await controlPlanesOps.listDataPlaneTokens(
									this.api,
									args.controlPlaneId,
									args.pageSize,
									args.pageNumber,
								);
								break;

							case "revoke_data_plane_token":
								result = await controlPlanesOps.revokeDataPlaneToken(this.api, args.controlPlaneId, args.tokenId);
								break;

							// Control Plane Configuration
							case "get_control_plane_config":
								result = await controlPlanesOps.getControlPlaneConfig(this.api, args.controlPlaneId);
								break;

							case "update_control_plane_config":
								result = await controlPlanesOps.updateControlPlaneConfig(this.api, args.controlPlaneId, {
									proxyUrl: args.proxyUrl,
									telemetryUrl: args.telemetryUrl,
									authType: args.authType,
									cloudGateway: args.cloudGateway,
									analyticsEnabled: args.analyticsEnabled,
								});
								break;

							// ===========================
							// Certificate Management Tools
							// ===========================
							case "list_certificates":
								result = await certificatesOps.listCertificates(this.api, args.controlPlaneId, args.size, args.offset);
								break;

							case "get_certificate":
								result = await certificatesOps.getCertificate(this.api, args.controlPlaneId, args.certificateId);
								break;

							case "create_certificate":
								result = await certificatesOps.createCertificate(
									this.api,
									args.controlPlaneId,
									args.cert,
									args.key,
									args.certAlt,
									args.keyAlt,
									args.tags,
								);
								break;

							case "update_certificate":
								result = await certificatesOps.updateCertificate(
									this.api,
									args.controlPlaneId,
									args.certificateId,
									args.cert,
									args.key,
									args.certAlt,
									args.keyAlt,
									args.tags,
								);
								break;

							case "delete_certificate":
								result = await certificatesOps.deleteCertificate(this.api, args.controlPlaneId, args.certificateId);
								break;

							// ===========================
							// Configuration Management Tools
							// ===========================
							// Legacy list operations (backward compatibility)
							case "list_services":
								result = await configurationOps.listServices(this.api, args.controlPlaneId, args.size, args.offset);
								break;

							case "list_routes":
								result = await configurationOps.listRoutes(this.api, args.controlPlaneId, args.size, args.offset);
								break;

							case "list_consumers":
								result = await configurationOps.listConsumers(this.api, args.controlPlaneId, args.size, args.offset);
								break;

							case "list_plugins":
								result = await configurationOps.listPlugins(this.api, args.controlPlaneId, args.size, args.offset);
								break;

							// Service CRUD operations
							case "create_service":
								result = await configurationOps.createService(
									this.api,
									args.controlPlaneId,
									{
										name: args.name,
										host: args.host,
										port: args.port,
										protocol: args.protocol,
										path: args.path,
										retries: args.retries,
										connectTimeout: args.connectTimeout,
										writeTimeout: args.writeTimeout,
										readTimeout: args.readTimeout,
										tags: args.tags,
										enabled: args.enabled,
									},
									extra,
								);
								break;

							case "get_service":
								result = await configurationOps.getService(this.api, args.controlPlaneId, args.serviceId);
								break;

							// update_service and delete_service MOVED TO BLOCKED OPERATIONS

							// Route CRUD operations
							case "create_route":
								result = await configurationOps.createRoute(
									this.api,
									args.controlPlaneId,
									{
										name: args.name,
										protocols: args.protocols,
										methods: args.methods,
										hosts: args.hosts,
										paths: args.paths,
										serviceId: args.serviceId,
										stripPath: args.stripPath,
										preserveHost: args.preserveHost,
										regexPriority: args.regexPriority,
										tags: args.tags,
									},
									extra,
								);
								break;

							case "get_route":
								result = await configurationOps.getRoute(this.api, args.controlPlaneId, args.routeId);
								break;

							// update_route and delete_route MOVED TO BLOCKED OPERATIONS

							// Consumer CRUD operations
							case "create_consumer":
								result = await configurationOps.createConsumer(
									this.api,
									args.controlPlaneId,
									{
										username: args.username,
										customId: args.customId,
										tags: args.tags,
										enabled: args.enabled,
									},
									extra,
								);
								break;

							case "get_consumer":
								result = await configurationOps.getConsumer(this.api, args.controlPlaneId, args.consumerId);
								break;

							case "update_consumer":
								result = await configurationOps.updateConsumer(this.api, args.controlPlaneId, args.consumerId, {
									username: args.username,
									customId: args.customId,
									tags: args.tags,
									enabled: args.enabled,
								});
								break;

							// delete_consumer MOVED TO BLOCKED OPERATIONS

							// Plugin CRUD operations
							case "create_plugin":
								result = await configurationOps.createPlugin(
									this.api,
									args.controlPlaneId,
									{
										name: args.name,
										config: args.config,
										protocols: args.protocols,
										consumerId: args.consumerId,
										serviceId: args.serviceId,
										routeId: args.routeId,
										tags: args.tags,
										enabled: args.enabled,
									},
									extra,
								);
								break;

							case "get_plugin":
								result = await configurationOps.getPlugin(this.api, args.controlPlaneId, args.pluginId);
								break;

							// update_plugin and delete_plugin MOVED TO BLOCKED OPERATIONS

							case "list_plugin_schemas":
								result = await configurationOps.listPluginSchemas(this.api, args.controlPlaneId);
								break;

							// ===========================
							// Portal Management Tools
							// ===========================
							// Portal API Operations
							case "list_portal_apis":
								result = await portalOps.listApis(
									this.api,
									args.pageSize,
									args.pageNumber,
									args.filterName,
									args.filterStatus,
									args.sort,
								);
								break;

							case "fetch_portal_api":
								result = await portalOps.fetchApi(this.api, args.apiIdOrSlug);
								break;

							case "get_portal_api_actions":
								result = await portalOps.getApiActions(this.api, args.apiIdOrSlug);
								break;

							case "list_portal_api_documents":
								result = await portalOps.listApiDocuments(this.api, args.apiIdOrSlug);
								break;

							case "fetch_portal_api_document":
								result = await portalOps.fetchApiDocument(
									this.api,
									args.apiIdOrSlug,
									args.documentIdOrSlug,
									args.format,
								);
								break;

							// Application Management Operations
							case "list_portal_applications":
								result = await portalOps.listApplications(
									this.api,
									args.portalId,
									args.pageSize,
									args.pageNumber,
									args.filterName,
									args.filterAuthStrategy,
								);
								break;

							case "create_portal_application":
								result = await portalOps.createApplication(this.api, {
									name: args.name,
									description: args.description,
									clientId: args.clientId,
									redirectUri: args.redirectUri,
									authStrategyId: args.authStrategyId,
									scopes: args.scopes,
								});
								break;

							case "get_portal_application":
								result = await portalOps.getApplication(this.api, args.applicationId);
								break;

							case "update_portal_application":
								result = await portalOps.updateApplication(this.api, args.applicationId, {
									name: args.name,
									description: args.description,
									redirectUri: args.redirectUri,
									scopes: args.scopes,
								});
								break;

							case "delete_portal_application":
								result = await portalOps.deleteApplication(this.api, args.applicationId);
								break;

							// Application Registration Operations
							case "list_portal_application_registrations":
								result = await portalOps.listApplicationRegistrations(
									this.api,
									args.applicationId,
									args.pageSize,
									args.pageNumber,
									args.filterStatus,
									args.filterApiName,
								);
								break;

							case "create_portal_application_registration":
								result = await portalOps.createApplicationRegistration(this.api, args.applicationId, {
									apiId: args.apiId,
									apiProductVersionId: args.apiProductVersionId,
									requestReason: args.requestReason,
								});
								break;

							case "get_portal_application_registration":
								result = await portalOps.getApplicationRegistration(this.api, args.applicationId, args.registrationId);
								break;

							case "delete_portal_application_registration":
								result = await portalOps.deleteApplicationRegistration(
									this.api,
									args.applicationId,
									args.registrationId,
								);
								break;

							// Credential Management Operations
							case "list_portal_credentials":
								result = await portalOps.listCredentials(this.api, args.applicationId, args.pageSize, args.pageNumber);
								break;

							case "create_portal_credential":
								result = await portalOps.createCredential(this.api, args.applicationId, {
									credentialType: args.credentialType,
									name: args.name,
									scopes: args.scopes,
									expiresAt: args.expiresAt,
								});
								break;

							case "update_portal_credential":
								result = await portalOps.updateCredential(this.api, args.applicationId, args.credentialId, {
									name: args.name,
									scopes: args.scopes,
									expiresAt: args.expiresAt,
								});
								break;

							case "delete_portal_credential":
								result = await portalOps.deleteCredential(this.api, args.applicationId, args.credentialId);
								break;

							case "regenerate_portal_application_secret":
								result = await portalOps.regenerateApplicationSecret(this.api, args.applicationId);
								break;

							// Developer Authentication Operations
							case "register_portal_developer":
								result = await portalOps.registerDeveloper(this.api, {
									email: args.email,
									fullName: args.fullName,
									password: args.password,
									organization: args.organization,
									customAttributes: args.customAttributes,
								});
								break;

							case "authenticate_portal_developer":
								result = await portalOps.authenticate(this.api, args.username, args.password);
								break;

							case "get_portal_developer_me":
								result = await portalOps.getDeveloperMe(this.api);
								break;

							case "logout_portal_developer":
								result = await portalOps.logout(this.api);
								break;

							// Application Analytics Operations
							case "query_portal_application_analytics":
								result = await portalOps.queryApplicationAnalytics(this.api, args.applicationId, {
									metrics: args.metrics,
									dimensions: args.dimensions,
									timeRange: args.timeRange,
									granularity: args.granularity,
								});
								break;

							// ===========================
							// Portal Management Tools
							// ===========================
							case "list_portals":
								result = await portalManagementOps.listPortals(this.api, args.pageSize, args.pageNumber);
								break;

							case "create_portal":
								result = await portalManagementOps.createPortal(this.api, args);
								break;

							case "get_portal":
								result = await portalManagementOps.getPortal(this.api, args.portalId);
								break;

							case "update_portal":
								result = await portalManagementOps.updatePortal(this.api, args.portalId, args);
								break;

							case "delete_portal":
								result = await portalManagementOps.deletePortal(this.api, args.portalId);
								break;

							case "list_portal_products":
								result = await portalManagementOps.listPortalProducts(
									this.api,
									args.portalId,
									args.pageSize,
									args.pageNumber,
								);
								break;

							case "publish_portal_product":
								result = await portalManagementOps.publishPortalProduct(this.api, args.portalId, args);
								break;

							case "unpublish_portal_product":
								result = await portalManagementOps.unpublishPortalProduct(this.api, args.portalId, args.productId);
								break;

							// ===========================
							// TODO: Add remaining tool categories
							// ===========================
							// Upstream Management Tools
							// Data Plane Tools
							// Credentials Management Tools

							// ===========================
							// Elicitation Tools
							// ===========================
							case "analyze_migration_context":
								result = await this.elicitationOps.analyzeContext(
									args.userMessage,
									args.deckFiles,
									args.deckConfigs,
									args.gitContext,
								);
								break;

							case "create_elicitation_session":
								result = await this.elicitationOps.createElicitationSession(args.analysisResult, args.context);

								// Enhance result for Claude Desktop compatibility
								if (result.needsUserInput && result.claudeDesktopPrompt) {
									result.content = [
										{
											type: "text",
											text: result.claudeDesktopPrompt,
										},
									];

									// Add structured guidance for Claude Desktop
									if (result.directInstructions) {
										result.guidance = result.directInstructions;
									}
								}
								break;

							case "process_elicitation_response":
								result = await this.elicitationOps.processElicitationResponse(
									args.sessionId,
									args.requestId,
									args.response,
								);
								break;

							case "get_session_status":
								result = await this.elicitationOps.getSessionStatus(args.sessionId);
								break;

							default:
								throw new Error(`Unknown tool method: ${tool.method}`);
						}

						// Record performance metrics
						const duration = Date.now() - startTime;
						this.performanceCollector.recordToolExecution(tool.method, duration, success);

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(result, null, 2),
								},
							],
						};
					} catch (error: any) {
						success = false;
						const duration = Date.now() - startTime;
						this.performanceCollector.recordToolExecution(tool.method, duration, success);

						const formattedError = formatError(error);

						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${formattedError}`,
								},
							],
							isError: true,
						};
					}
				};
			}

			// Create traced handler using shared tracing
			const tracedHandler = async (args: any, extra: RequestHandlerExtra<any, any>): Promise<any> => {
				return traceToolCall(tool.method, () => handler(args, extra));
			};

			// Register the traced tool with appropriate parameters
			const toolParams = tool.inputSchema || tool.parameters?.shape || {};
			mcpLogger.debug("server", "Registering tool", { method: tool.method, category: tool.category });
			this.tool(tool.method, tool.description, toolParams, tracedHandler);
		});
	}

	/**
	 * Get performance statistics for all tools
	 */
	getPerformanceStats() {
		return this.performanceCollector.getAllStats();
	}

	/**
	 * Get tracing statistics
	 */
	getTracingStats() {
		return { enabled: isTracingActive(), project: process.env.LANGSMITH_PROJECT || "konnect-mcp-server" };
	}

	/**
	 * Log session information for this MCP server instance
	 */
	private logMCPSessionInfo() {
		mcpLogger.info("session", "MCP server session", {
			serverVersion: "2.0.0",
			runtime: "bun",
			apiRegion: this.api.region || "us",
		});
	}
}

let activeTransport: TransportResult | undefined;

let otelSdk: ReturnType<typeof initTelemetry> = null;

async function main() {
	try {
		// Initialize OTEL telemetry
		const telemetryConfig: TelemetryConfig = {
			enabled: process.env.TELEMETRY_MODE !== undefined,
			serviceName: process.env.OTEL_SERVICE_NAME || "konnect-mcp-server",
			mode: (process.env.TELEMETRY_MODE as "console" | "otlp" | "both") || "console",
			otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318",
		};
		otelSdk = initTelemetry(telemetryConfig);

		// Load and validate configuration with health checks
		mcpLogger.info("config", "Loading configuration");
		const config = await loadConfiguration();

		// Apply log level from configuration to mcpLogger
		mcpLogger.setMinLevelFromConfig(config.application.logLevel);

		// Show runtime information
		const runtimeInfo = getRuntimeInfo();
		mcpLogger.info("runtime", "Runtime information", {
			runtime: runtimeInfo.runtime,
			version: runtimeInfo.version,
			envSource: runtimeInfo.envSource,
		});

		const serverFactory = (): McpServer =>
			new KongKonnectMcpServer({
				apiKey: config.kong.accessToken,
				apiRegion: config.kong.region,
			});

		mcpLogger.startup("server", {
			availableRegions: Object.values(API_REGIONS),
			region: config.kong.region,
			environment: config.application.environment,
			logLevel: config.application.logLevel,
			tracing: config.tracing.enabled,
			monitoring: config.monitoring.enabled,
			transport: config.transport.mode,
			port: config.transport.mode !== "stdio" ? config.transport.port : undefined,
		});

		activeTransport = await createTransport(config, serverFactory);

		mcpLogger.ready("server", {
			transport: config.transport.mode,
			port: config.transport.mode !== "stdio" ? config.transport.port : undefined,
		});
	} catch (error: any) {
		mcpLogger.critical("server", "Failed to start server", {
			error: error.message,
			stack: error.stack,
		});

		// Provide helpful error context
		if (error.message.includes("KONNECT_ACCESS_TOKEN")) {
			mcpLogger.error("config", "Kong access token missing", {
				fix: "Set KONNECT_ACCESS_TOKEN in .env file",
				url: "https://cloud.konghq.com/",
			});
		}

		if (error.message.includes("LANGSMITH_API_KEY")) {
			mcpLogger.error("config", "LangSmith API key missing", {
				fix: "Set LANGSMITH_API_KEY in .env or disable with LANGSMITH_TRACING=false",
			});
		}

		mcpLogger.info("help", "Run configuration health check: bun run config:health");
		process.exit(1);
	}
}

// Handle graceful shutdown
process.on("SIGINT", async () => {
	mcpLogger.notice("server", "Shutting down (SIGINT)");
	if (activeTransport) await activeTransport.closeAll();
	await shutdownTelemetry(otelSdk);
	process.exit(0);
});

process.on("SIGTERM", async () => {
	mcpLogger.notice("server", "Terminating (SIGTERM)");
	if (activeTransport) await activeTransport.closeAll();
	await shutdownTelemetry(otelSdk);
	process.exit(0);
});

process.on("uncaughtException", (error) => {
	mcpLogger.emergency("server", "Uncaught exception", {
		error: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
	});
	process.exit(1);
});

process.on("unhandledRejection", (reason) => {
	mcpLogger.error("server", "Unhandled rejection", {
		reason: reason instanceof Error ? reason.message : String(reason),
		stack: reason instanceof Error ? reason.stack : undefined,
	});
	process.exit(1);
});

// Check if this module is being run directly (ES module compatible)
const isMainModule = process.argv[1] && import.meta.url.includes(process.argv[1]);

if (isMainModule) {
	main().catch((error) => {
		mcpLogger.error("server", "Failed to start Kong Konnect MCP Server", {
			error: error.message,
		});
		process.exit(1);
	});
}
