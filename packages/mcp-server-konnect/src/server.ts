// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { KongApi } from "./api/kong-api.js";
import type { Config } from "./config/index.js";
import * as analyticsOps from "./tools/analytics/operations.js";
import * as certificatesOps from "./tools/certificates/operations.js";
import * as configurationOps from "./tools/configuration/operations.js";
import * as controlPlanesOps from "./tools/control-planes/operations.js";
import { ElicitationOperations } from "./tools/elicitation-tool.js";
import { enhancedKongTools } from "./tools/enhanced-kong-tools.js";
import * as portalOps from "./tools/portal/operations.js";
import * as portalManagementOps from "./tools/portal-management/operations.js";
import { getAllTools, validateToolRegistry } from "./tools/registry.js";
import { formatError } from "./utils/error-handling.js";
import { createContextLogger } from "./utils/mcp-logger.js";
import { mcpPaginator } from "./utils/pagination.js";
import { ToolPerformanceCollector } from "./utils/tool-tracer.js";
import { traceToolCall } from "./utils/tracing.js";

const log = createContextLogger("server");
const toolsLog = createContextLogger("tools");

export function createKonnectServer(api: KongApi, config: Config): McpServer {
	const server = new McpServer({
		name: "kong-konnect-mcp",
		version: "2.0.0",
		description:
			"Comprehensive Kong Konnect API Gateway management with analytics, configuration, certificates, and more",
	});

	const performanceCollector = new ToolPerformanceCollector();
	const elicitationOps = new ElicitationOperations();

	// Validate tool registry
	const validation = validateToolRegistry();
	if (!validation.isValid) {
		log.fatal({ errors: validation.errors }, "Tool registry validation failed");
		throw new Error(`Invalid tool registry: ${validation.errors.join(", ")}`);
	}

	// Register all tools
	registerTools(server, api, performanceCollector, elicitationOps);

	// Override default tools/list handler to provide pagination
	// TEMPORARILY DISABLED: registerPaginatedToolsList(server);

	return server;
}

// TEMPORARILY DISABLED: This function is not called but kept for future reference.
// Uses low-level server protocol methods not available on McpServer.
function registerPaginatedToolsList(_server: McpServer) {
	const server = _server as unknown as {
		setRequestHandler: (
			schema: { method: string },
			handler: (request: { params?: Record<string, unknown> }) => Promise<unknown>,
		) => void;
	};
	server.setRequestHandler({ method: "tools/list" }, async (request: { params?: Record<string, unknown> }) => {
		const allTools = getAllTools();

		try {
			// Extract pagination parameters (only cursor is in official MCP schema)
			const cursor = request.params?.cursor as string | undefined;

			// Use fixed page size since pageSize isn't in MCP schema
			// Category filtering via custom tools/categories endpoint instead

			toolsLog.debug({ cursor: cursor ? "[CURSOR]" : undefined, totalTools: allTools.length }, "Tools list requested");

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
			const response: Record<string, unknown> = {
				tools: mcpTools,
			};

			// Add nextCursor if more results exist
			if (paginatedResult.nextCursor) {
				response.nextCursor = paginatedResult.nextCursor;
			}

			toolsLog.debug(
				{
					returnedTools: mcpTools.length,
					hasNextPage: !!paginatedResult.nextCursor,
					categories: [...new Set(paginatedResult.items.map((t) => t.category))],
				},
				"Tools list response",
			);

			return response;
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			toolsLog.error(
				{ error: errorMessage, cursor: request.params?.cursor ? "[INVALID]" : undefined },
				"Tools list pagination error",
			);

			// Return error per MCP spec for invalid cursor
			throw {
				code: -32602,
				message: "Invalid params",
				data: { error: errorMessage },
			};
		}
	});

	// Register tools/categories helper method for client navigation
	server.setRequestHandler({ method: "tools/categories" }, async (_request: { params?: Record<string, unknown> }) => {
		const allTools = getAllTools();
		const categories = mcpPaginator.getToolCategories(allTools);

		toolsLog.debug({ categoriesCount: categories.length, categories }, "Tool categories requested");

		return {
			categories: categories.map((category) => ({
				name: category,
				toolCount: allTools.filter((tool) => tool.category === category).length,
			})),
		};
	});
}

function registerTools(
	server: McpServer,
	api: KongApi,
	performanceCollector: ToolPerformanceCollector,
	elicitationOps: ElicitationOperations,
) {
	const allTools = getAllTools();

	log.info("Native MCP elicitation active");
	log.info(
		{ toolCount: allTools.length, categories: [...new Set(allTools.map((t) => t.category))] },
		"Registering tools",
	);

	// Kong modification operations using enhanced MCP elicitation - DISABLED FOR CLAUDE DESKTOP
	const ENHANCED_KONG_OPERATIONS = new Set<string>([
		// 'create_service', 'create_route', 'create_consumer', 'create_plugin'
	]);

	allTools.forEach((tool) => {
		// Check if this is an enhanced Kong operation
		const isEnhancedKongOperation = ENHANCED_KONG_OPERATIONS.has(tool.method);

		let handler: (args: any, extra: RequestHandlerExtra<any, any>) => Promise<any>;

		if (isEnhancedKongOperation) {
			// Use enhanced operation handler with native MCP elicitation
			log.debug({ method: tool.method }, "Registering enhanced operation");
			handler = async (args: any, extra: RequestHandlerExtra<any, any>) => {
				switch (tool.method) {
					case "create_service":
						return await enhancedKongTools.createServiceWithElicitation(api, args, extra);
					case "create_route":
						return await enhancedKongTools.createRouteWithElicitation(api, args, extra);
					case "create_consumer":
						return await enhancedKongTools.createConsumerWithElicitation(api, args, extra);
					case "create_plugin":
						return await enhancedKongTools.createPluginWithElicitation(api, args, extra);
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
								api,
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
								api,
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
								api,
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
							result = await controlPlanesOps.getControlPlane(api, args.controlPlaneId);
							break;

						case "list_control_plane_group_memberships":
							result = await controlPlanesOps.listControlPlaneGroupMemberships(
								api,
								args.groupId,
								args.pageSize,
								args.pageAfter,
							);
							break;

						case "check_control_plane_group_membership":
							result = await controlPlanesOps.checkControlPlaneGroupMembership(api, args.controlPlaneId);
							break;

						// Control Plane CRUD Operations
						case "create_control_plane":
							result = await controlPlanesOps.createControlPlane(api, {
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
							result = await controlPlanesOps.updateControlPlane(api, args.controlPlaneId, {
								name: args.name,
								description: args.description,
								labels: args.labels,
							});
							break;

						case "delete_control_plane":
							result = await controlPlanesOps.deleteControlPlane(api, args.controlPlaneId);
							break;

						// Data Plane Node Management
						case "list_data_plane_nodes":
							result = await controlPlanesOps.listDataPlaneNodes(
								api,
								args.controlPlaneId,
								args.pageSize,
								args.pageNumber,
								args.filterStatus,
								args.filterHostname,
							);
							break;

						case "get_data_plane_node":
							result = await controlPlanesOps.getDataPlaneNode(api, args.controlPlaneId, args.nodeId);
							break;

						// Data Plane Token Management
						case "create_data_plane_token":
							result = await controlPlanesOps.createDataPlaneToken(api, args.controlPlaneId, args.name, args.expiresAt);
							break;

						case "list_data_plane_tokens":
							result = await controlPlanesOps.listDataPlaneTokens(
								api,
								args.controlPlaneId,
								args.pageSize,
								args.pageNumber,
							);
							break;

						case "revoke_data_plane_token":
							result = await controlPlanesOps.revokeDataPlaneToken(api, args.controlPlaneId, args.tokenId);
							break;

						// Control Plane Configuration
						case "get_control_plane_config":
							result = await controlPlanesOps.getControlPlaneConfig(api, args.controlPlaneId);
							break;

						case "update_control_plane_config":
							result = await controlPlanesOps.updateControlPlaneConfig(api, args.controlPlaneId, {
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
							result = await certificatesOps.listCertificates(api, args.controlPlaneId, args.size, args.offset);
							break;

						case "get_certificate":
							result = await certificatesOps.getCertificate(api, args.controlPlaneId, args.certificateId);
							break;

						case "create_certificate":
							result = await certificatesOps.createCertificate(
								api,
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
								api,
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
							result = await certificatesOps.deleteCertificate(api, args.controlPlaneId, args.certificateId);
							break;

						// ===========================
						// Configuration Management Tools
						// ===========================
						// Legacy list operations (backward compatibility)
						case "list_services":
							result = await configurationOps.listServices(api, args.controlPlaneId, args.size, args.offset);
							break;

						case "list_routes":
							result = await configurationOps.listRoutes(api, args.controlPlaneId, args.size, args.offset);
							break;

						case "list_consumers":
							result = await configurationOps.listConsumers(api, args.controlPlaneId, args.size, args.offset);
							break;

						case "list_plugins":
							result = await configurationOps.listPlugins(api, args.controlPlaneId, args.size, args.offset);
							break;

						// Service CRUD operations
						case "create_service":
							result = await configurationOps.createService(
								api,
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
							result = await configurationOps.getService(api, args.controlPlaneId, args.serviceId);
							break;

						// update_service and delete_service MOVED TO BLOCKED OPERATIONS

						// Route CRUD operations
						case "create_route":
							result = await configurationOps.createRoute(
								api,
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
							result = await configurationOps.getRoute(api, args.controlPlaneId, args.routeId);
							break;

						// update_route and delete_route MOVED TO BLOCKED OPERATIONS

						// Consumer CRUD operations
						case "create_consumer":
							result = await configurationOps.createConsumer(
								api,
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
							result = await configurationOps.getConsumer(api, args.controlPlaneId, args.consumerId);
							break;

						case "update_consumer":
							result = await configurationOps.updateConsumer(api, args.controlPlaneId, args.consumerId, {
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
								api,
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
							result = await configurationOps.getPlugin(api, args.controlPlaneId, args.pluginId);
							break;

						// update_plugin and delete_plugin MOVED TO BLOCKED OPERATIONS

						case "list_plugin_schemas":
							result = await configurationOps.listPluginSchemas(api, args.controlPlaneId);
							break;

						// ===========================
						// Portal Management Tools
						// ===========================
						// Portal API Operations
						case "list_portal_apis":
							result = await portalOps.listApis(
								api,
								args.pageSize,
								args.pageNumber,
								args.filterName,
								args.filterStatus,
								args.sort,
							);
							break;

						case "fetch_portal_api":
							result = await portalOps.fetchApi(api, args.apiIdOrSlug);
							break;

						case "get_portal_api_actions":
							result = await portalOps.getApiActions(api, args.apiIdOrSlug);
							break;

						case "list_portal_api_documents":
							result = await portalOps.listApiDocuments(api, args.apiIdOrSlug);
							break;

						case "fetch_portal_api_document":
							result = await portalOps.fetchApiDocument(api, args.apiIdOrSlug, args.documentIdOrSlug, args.format);
							break;

						// Application Management Operations
						case "list_portal_applications":
							result = await portalOps.listApplications(
								api,
								args.portalId,
								args.pageSize,
								args.pageNumber,
								args.filterName,
								args.filterAuthStrategy,
							);
							break;

						case "create_portal_application":
							result = await portalOps.createApplication(api, {
								name: args.name,
								description: args.description,
								clientId: args.clientId,
								redirectUri: args.redirectUri,
								authStrategyId: args.authStrategyId,
								scopes: args.scopes,
							});
							break;

						case "get_portal_application":
							result = await portalOps.getApplication(api, args.applicationId);
							break;

						case "update_portal_application":
							result = await portalOps.updateApplication(api, args.applicationId, {
								name: args.name,
								description: args.description,
								redirectUri: args.redirectUri,
								scopes: args.scopes,
							});
							break;

						case "delete_portal_application":
							result = await portalOps.deleteApplication(api, args.applicationId);
							break;

						// Application Registration Operations
						case "list_portal_application_registrations":
							result = await portalOps.listApplicationRegistrations(
								api,
								args.applicationId,
								args.pageSize,
								args.pageNumber,
								args.filterStatus,
								args.filterApiName,
							);
							break;

						case "create_portal_application_registration":
							result = await portalOps.createApplicationRegistration(api, args.applicationId, {
								apiId: args.apiId,
								apiProductVersionId: args.apiProductVersionId,
								requestReason: args.requestReason,
							});
							break;

						case "get_portal_application_registration":
							result = await portalOps.getApplicationRegistration(api, args.applicationId, args.registrationId);
							break;

						case "delete_portal_application_registration":
							result = await portalOps.deleteApplicationRegistration(api, args.applicationId, args.registrationId);
							break;

						// Credential Management Operations
						case "list_portal_credentials":
							result = await portalOps.listCredentials(api, args.applicationId, args.pageSize, args.pageNumber);
							break;

						case "create_portal_credential":
							result = await portalOps.createCredential(api, args.applicationId, {
								credentialType: args.credentialType,
								name: args.name,
								scopes: args.scopes,
								expiresAt: args.expiresAt,
							});
							break;

						case "update_portal_credential":
							result = await portalOps.updateCredential(api, args.applicationId, args.credentialId, {
								name: args.name,
								scopes: args.scopes,
								expiresAt: args.expiresAt,
							});
							break;

						case "delete_portal_credential":
							result = await portalOps.deleteCredential(api, args.applicationId, args.credentialId);
							break;

						case "regenerate_portal_application_secret":
							result = await portalOps.regenerateApplicationSecret(api, args.applicationId);
							break;

						// Developer Authentication Operations
						case "register_portal_developer":
							result = await portalOps.registerDeveloper(api, {
								email: args.email,
								fullName: args.fullName,
								password: args.password,
								organization: args.organization,
								customAttributes: args.customAttributes,
							});
							break;

						case "authenticate_portal_developer":
							result = await portalOps.authenticate(api, args.username, args.password);
							break;

						case "get_portal_developer_me":
							result = await portalOps.getDeveloperMe(api);
							break;

						case "logout_portal_developer":
							result = await portalOps.logout(api);
							break;

						// Application Analytics Operations
						case "query_portal_application_analytics":
							result = await portalOps.queryApplicationAnalytics(api, args.applicationId, {
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
							result = await portalManagementOps.listPortals(api, args.pageSize, args.pageNumber);
							break;

						case "create_portal":
							result = await portalManagementOps.createPortal(api, args);
							break;

						case "get_portal":
							result = await portalManagementOps.getPortal(api, args.portalId);
							break;

						case "update_portal":
							result = await portalManagementOps.updatePortal(api, args.portalId, args);
							break;

						case "delete_portal":
							result = await portalManagementOps.deletePortal(api, args.portalId);
							break;

						case "list_portal_products":
							result = await portalManagementOps.listPortalProducts(api, args.portalId, args.pageSize, args.pageNumber);
							break;

						case "publish_portal_product":
							result = await portalManagementOps.publishPortalProduct(api, args.portalId, args);
							break;

						case "unpublish_portal_product":
							result = await portalManagementOps.unpublishPortalProduct(api, args.portalId, args.productId);
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
							result = await elicitationOps.analyzeContext(
								args.userMessage,
								args.deckFiles,
								args.deckConfigs,
								args.gitContext,
							);
							break;

						case "create_elicitation_session": {
							const sessionResult = await elicitationOps.createElicitationSession(args.analysisResult, args.context);
							const enhancedResult = sessionResult as Record<string, unknown>;

							// Enhance result for Claude Desktop compatibility
							if (sessionResult.needsUserInput && sessionResult.claudeDesktopPrompt) {
								enhancedResult.content = [
									{
										type: "text",
										text: sessionResult.claudeDesktopPrompt,
									},
								];

								// Add structured guidance for Claude Desktop
								if (sessionResult.directInstructions) {
									enhancedResult.guidance = sessionResult.directInstructions;
								}
							}
							result = enhancedResult;
							break;
						}

						case "process_elicitation_response":
							result = await elicitationOps.processElicitationResponse(args.sessionId, args.requestId, args.response);
							break;

						case "get_session_status":
							result = await elicitationOps.getSessionStatus(args.sessionId);
							break;

						default:
							throw new Error(`Unknown tool method: ${tool.method}`);
					}

					// Record performance metrics
					const duration = Date.now() - startTime;
					performanceCollector.recordToolExecution(`konnect_${tool.method}`, duration, success);

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
					performanceCollector.recordToolExecution(`konnect_${tool.method}`, duration, success);

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
		const prefixedName = `konnect_${tool.method}`;
		const tracedHandler = async (args: any, extra: RequestHandlerExtra<any, any>): Promise<any> => {
			return traceToolCall(prefixedName, () => handler(args, extra));
		};

		// Register the traced tool with appropriate parameters
		const toolParams = (tool as unknown as Record<string, unknown>).inputSchema ?? tool.parameters?.shape ?? {};
		log.debug({ method: prefixedName, category: tool.category }, "Registering tool");
		server.tool(prefixedName, tool.description, toolParams, tracedHandler);
	});
}
