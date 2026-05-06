// src/tools/configuration/operations.ts
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import type { KongApi } from "../../api/kong-api.js";
import { createContextLogger } from "../../utils/logger.js";
import { extractDeploymentContext, generateTags } from "../../utils/simple-elicitation.js";

const log = createContextLogger("tools");

/**
 * List services for a specific control plane
 */
export async function listServices(api: KongApi, controlPlaneId: string, size = 100, offset?: string) {
	log.debug({ controlPlaneId }, "Listing services");
	const result = await api.listServices(controlPlaneId, size, offset);

	// SIO-663: derive applied-pagination metadata from observed result, not request.
	// Kong silently caps `size` at 100 upstream; echoing the requested value misled callers.
	const actualCount = result.data.length;
	const effectiveSize = Math.min(size, actualCount);
	const capped = size > actualCount && actualCount === 100;

	// Transform the response to have consistent field names
	return {
		metadata: {
			controlPlaneId: controlPlaneId,
			requestedSize: size,
			effectiveSize,
			actualCount,
			capped,
			offset: offset || null,
			nextOffset: result.offset,
			totalCount: result.total,
		},
		services: result.data.map((service) => ({
			serviceId: service.id,
			name: service.name,
			host: service.host,
			port: service.port,
			protocol: service.protocol,
			path: service.path,
			retries: service.retries,
			connectTimeout: service.connect_timeout,
			writeTimeout: service.write_timeout,
			readTimeout: service.read_timeout,
			tags: service.tags,
			clientCertificate: service.client_certificate,
			tlsVerify: service.tls_verify,
			tlsVerifyDepth: service.tls_verify_depth,
			caCertificates: service.ca_certificates,
			enabled: service.enabled,
			metadata: {
				createdAt: service.created_at,
				updatedAt: service.updated_at,
			},
		})),
		relatedTools: [
			"Use list-routes to find routes that point to these services",
			"Use list-plugins to see plugins configured for these services",
		],
	};
}

/**
 * Create a new service in a control plane with simple elicitation
 */
export async function createService(
	api: KongApi,
	controlPlaneId: string,
	serviceData: {
		name: string;
		host: string;
		port?: number;
		protocol?: string;
		path?: string;
		retries?: number;
		connectTimeout?: number;
		writeTimeout?: number;
		readTimeout?: number;
		tags?: string[];
		enabled?: boolean;
	},
	// biome-ignore lint/suspicious/noExplicitAny: MCP RequestHandlerExtra generics are passthrough request/transport types; consumers don't constrain them.
	extra?: RequestHandlerExtra<any, any>,
) {
	log.debug({ controlPlaneId, name: serviceData.name, host: serviceData.host }, "Creating service");
	// Validate minimum required data
	if (!serviceData.name || !serviceData.host) {
		throw new Error("Service name and host are required");
	}

	// Check if deployment context is missing from tags
	const contextCheck = extractDeploymentContext(serviceData.tags);

	if (contextCheck.missing.length > 0) {
		if (extra?.sendRequest) {
			// Follow MCP elicitation specification exactly
			try {
				const elicitationResponse = await extra.sendRequest(
					{
						method: "elicitation/create",
						params: {
							message: `Please provide deployment context for service "${serviceData.name}":`,
							requestedSchema: {
								type: "object",
								properties: {
									domain: {
										type: "string",
										title: "Domain",
										description: "What domain does this service belong to?",
									},
									environment: {
										type: "string",
										title: "Environment",
										description: "What environment is this for?",
									},
									team: {
										type: "string",
										title: "Team",
										description: "Which team owns this service?",
									},
								},
								required: ["domain", "environment", "team"],
							},
						},
					},
					// Response schema as per specification
					z.object({
						action: z.enum(["accept", "decline", "cancel"]),
						content: z
							.object({
								domain: z.string(),
								environment: z.string(),
								team: z.string(),
							})
							.optional(),
					}),
				);

				if (elicitationResponse.action === "accept" && elicitationResponse.content) {
					// Generate complete tag structure with user-provided context
					const completeTags = generateTags(elicitationResponse.content, "service", serviceData.name);
					serviceData.tags = completeTags;
				} else if (elicitationResponse.action === "decline") {
					throw new Error(`Service creation declined by user. Please provide deployment tags manually.`);
				} else {
					// Cancelled
					throw new Error(`Service creation cancelled by user. Please provide deployment tags manually.`);
				}
			} catch (_error) {
				// Elicitation failed - fall back to error with instructions
				throw new Error(
					`Service creation requires deployment tags. Missing: ${contextCheck.missing.join(", ")}. Use mcp__kong-konnect__analyze_migration_context to analyze your configuration and mcp__kong-konnect__create_elicitation_session to gather missing information.`,
				);
			}
		} else {
			// No elicitation support - throw error with instructions
			throw new Error(
				`Service creation requires deployment tags. Missing: ${contextCheck.missing.join(", ")}. Use mcp__kong-konnect__analyze_migration_context to analyze your configuration and mcp__kong-konnect__create_elicitation_session to gather missing information.`,
			);
		}
	}
	const requestData = {
		name: serviceData.name,
		host: serviceData.host,
		port: serviceData.port || 80,
		protocol: serviceData.protocol || "http",
		path: serviceData.path,
		retries: serviceData.retries || 5,
		connect_timeout: serviceData.connectTimeout || 60000,
		write_timeout: serviceData.writeTimeout || 60000,
		read_timeout: serviceData.readTimeout || 60000,
		tags: serviceData.tags,
		enabled: serviceData.enabled ?? true,
	};

	const result = await api.createService(controlPlaneId, requestData);

	return {
		success: true,
		service: {
			serviceId: result.id,
			name: result.name,
			host: result.host,
			port: result.port,
			protocol: result.protocol,
			path: result.path,
			retries: result.retries,
			connectTimeout: result.connect_timeout,
			writeTimeout: result.write_timeout,
			readTimeout: result.read_timeout,
			tags: result.tags,
			enabled: result.enabled,
			metadata: {
				createdAt: result.created_at,
				updatedAt: result.updated_at,
			},
		},
		message: `Service '${result.name}' created successfully with ID: ${result.id}`,
		relatedTools: [
			"Use create-route to create routes that point to this service",
			"Use list-services to see all services in this control plane",
			"Use create-plugin to add plugins to this service",
		],
	};
}

/**
 * Get detailed information about a specific service
 */
export async function getService(api: KongApi, controlPlaneId: string, serviceId: string) {
	log.debug({ controlPlaneId, serviceId }, "Getting service");
	const result = await api.getService(controlPlaneId, serviceId);

	return {
		service: {
			serviceId: result.id,
			name: result.name,
			host: result.host,
			port: result.port,
			protocol: result.protocol,
			path: result.path,
			retries: result.retries,
			connectTimeout: result.connect_timeout,
			writeTimeout: result.write_timeout,
			readTimeout: result.read_timeout,
			tags: result.tags,
			clientCertificate: result.client_certificate,
			tlsVerify: result.tls_verify,
			tlsVerifyDepth: result.tls_verify_depth,
			caCertificates: result.ca_certificates,
			enabled: result.enabled,
			metadata: {
				createdAt: result.created_at,
				updatedAt: result.updated_at,
			},
		},
		relatedTools: [
			"Use list-routes to find routes that point to this service",
			"Use list-plugins to see plugins configured for this service",
			"Use update-service to modify this service's configuration",
		],
	};
}

/**
 * Update an existing service
 */
export async function updateService(
	api: KongApi,
	controlPlaneId: string,
	serviceId: string,
	serviceData: {
		name?: string;
		host?: string;
		port?: number;
		protocol?: string;
		path?: string;
		retries?: number;
		connectTimeout?: number;
		writeTimeout?: number;
		readTimeout?: number;
		tags?: string[];
		enabled?: boolean;
	},
) {
	log.debug({ controlPlaneId, serviceId }, "Updating service");
	const requestData: Record<string, unknown> = {};

	if (serviceData.name !== undefined) requestData.name = serviceData.name;
	if (serviceData.host !== undefined) requestData.host = serviceData.host;
	if (serviceData.port !== undefined) requestData.port = serviceData.port;
	if (serviceData.protocol !== undefined) requestData.protocol = serviceData.protocol;
	if (serviceData.path !== undefined) requestData.path = serviceData.path;
	if (serviceData.retries !== undefined) requestData.retries = serviceData.retries;
	if (serviceData.connectTimeout !== undefined) requestData.connect_timeout = serviceData.connectTimeout;
	if (serviceData.writeTimeout !== undefined) requestData.write_timeout = serviceData.writeTimeout;
	if (serviceData.readTimeout !== undefined) requestData.read_timeout = serviceData.readTimeout;
	if (serviceData.tags !== undefined) requestData.tags = serviceData.tags;
	if (serviceData.enabled !== undefined) requestData.enabled = serviceData.enabled;

	const result = await api.updateService(controlPlaneId, serviceId, requestData);

	return {
		success: true,
		service: {
			serviceId: result.id,
			name: result.name,
			host: result.host,
			port: result.port,
			protocol: result.protocol,
			path: result.path,
			retries: result.retries,
			connectTimeout: result.connect_timeout,
			writeTimeout: result.write_timeout,
			readTimeout: result.read_timeout,
			tags: result.tags,
			enabled: result.enabled,
			metadata: {
				createdAt: result.created_at,
				updatedAt: result.updated_at,
			},
		},
		message: `Service '${result.name}' updated successfully`,
		relatedTools: [
			"Use get-service to see the updated service details",
			"Use list-routes to see routes affected by this change",
		],
	};
}

/**
 * Delete a service from a control plane
 */
export async function deleteService(api: KongApi, controlPlaneId: string, serviceId: string) {
	log.debug({ controlPlaneId, serviceId }, "Deleting service");
	await api.deleteService(controlPlaneId, serviceId);

	return {
		success: true,
		message: `Service ${serviceId} deleted successfully`,
		warning: "All routes pointing to this service have been orphaned and may need to be updated or deleted",
		relatedTools: [
			"Use list-routes to check for orphaned routes",
			"Use list-services to see remaining services in this control plane",
		],
	};
}

/**
 * List routes for a specific control plane
 */
export async function listRoutes(api: KongApi, controlPlaneId: string, size = 100, offset?: string) {
	log.debug({ controlPlaneId }, "Listing routes");
	const result = await api.listRoutes(controlPlaneId, size, offset);

	// SIO-663: applied-pagination metadata derived from observed result; Kong caps `size` at 100.
	const actualCount = result.data.length;
	const effectiveSize = Math.min(size, actualCount);
	const capped = size > actualCount && actualCount === 100;

	// Transform the response to have consistent field names
	return {
		metadata: {
			controlPlaneId: controlPlaneId,
			requestedSize: size,
			effectiveSize,
			actualCount,
			capped,
			offset: offset || null,
			nextOffset: result.offset,
			totalCount: result.total,
		},
		routes: result.data.map((route) => ({
			routeId: route.id,
			name: route.name,
			protocols: route.protocols,
			methods: route.methods,
			hosts: route.hosts,
			paths: route.paths,
			https_redirect_status_code: route.https_redirect_status_code,
			regex_priority: route.regex_priority,
			stripPath: route.strip_path,
			preserveHost: route.preserve_host,
			requestBuffering: route.request_buffering,
			responseBuffering: route.response_buffering,
			tags: route.tags,
			serviceId: route.service?.id,
			enabled: route.enabled,
			metadata: {
				createdAt: route.created_at,
				updatedAt: route.updated_at,
			},
		})),
		relatedTools: [
			"Use query-api-requests with specific routeIds to analyze traffic",
			"Use list-services to find details about the services these routes connect to",
			"Use list-plugins to see plugins configured for these routes",
		],
	};
}

/**
 * Create a new route in a control plane
 */
export async function createRoute(
	api: KongApi,
	controlPlaneId: string,
	routeData: {
		name?: string;
		protocols?: string[];
		methods?: string[];
		hosts?: string[];
		paths?: string[];
		serviceId?: string;
		stripPath?: boolean;
		preserveHost?: boolean;
		regexPriority?: number;
		tags?: string[];
	},
	// biome-ignore lint/suspicious/noExplicitAny: MCP RequestHandlerExtra generics are passthrough request/transport types; consumers don't constrain them.
	extra?: RequestHandlerExtra<any, any>,
) {
	log.debug({ controlPlaneId, name: routeData.name || null }, "Creating route");
	// Check if deployment context is missing from tags
	const contextCheck = extractDeploymentContext(routeData.tags);

	if (contextCheck.missing.length > 0) {
		if (extra?.sendRequest) {
			// Follow MCP elicitation specification exactly
			try {
				const elicitationResponse = await extra.sendRequest(
					{
						method: "elicitation/create",
						params: {
							message: `Please provide deployment context for route "${routeData.name || "unnamed"}":`,
							requestedSchema: {
								type: "object",
								properties: {
									domain: {
										type: "string",
										title: "Domain",
										description: "What domain does this route belong to?",
									},
									environment: {
										type: "string",
										title: "Environment",
										description: "What environment is this for?",
									},
									team: {
										type: "string",
										title: "Team",
										description: "Which team owns this route?",
									},
								},
								required: ["domain", "environment", "team"],
							},
						},
					},
					// Response schema as per specification
					z.object({
						action: z.enum(["accept", "decline", "cancel"]),
						content: z
							.object({
								domain: z.string(),
								environment: z.string(),
								team: z.string(),
							})
							.optional(),
					}),
				);

				if (elicitationResponse.action === "accept" && elicitationResponse.content) {
					// Generate complete tag structure with user-provided context
					const completeTags = generateTags(elicitationResponse.content, "route", routeData.name);
					routeData.tags = completeTags;
				} else if (elicitationResponse.action === "decline") {
					throw new Error(`Route creation declined by user. Please provide deployment tags manually.`);
				} else {
					// Cancelled
					throw new Error(`Route creation cancelled by user. Please provide deployment tags manually.`);
				}
			} catch (_error) {
				// Elicitation failed - fall back to error with instructions
				throw new Error(
					`Route creation requires deployment tags. Missing: ${contextCheck.missing.join(", ")}. Use mcp__kong-konnect__analyze_migration_context to analyze your configuration and mcp__kong-konnect__create_elicitation_session to gather missing information.`,
				);
			}
		} else {
			// No elicitation support - throw error with instructions
			throw new Error(
				`Route creation requires deployment tags. Missing: ${contextCheck.missing.join(", ")}. Use mcp__kong-konnect__analyze_migration_context to analyze your configuration and mcp__kong-konnect__create_elicitation_session to gather missing information.`,
			);
		}
	}
	const requestData: Record<string, unknown> = {
		protocols: routeData.protocols || ["http", "https"],
		strip_path: routeData.stripPath ?? true,
		preserve_host: routeData.preserveHost ?? false,
		regex_priority: routeData.regexPriority || 0,
	};

	if (routeData.name) requestData.name = routeData.name;
	if (routeData.methods) requestData.methods = routeData.methods;
	if (routeData.hosts) requestData.hosts = routeData.hosts;
	if (routeData.paths) requestData.paths = routeData.paths;
	if (routeData.serviceId) requestData.service = { id: routeData.serviceId };
	if (routeData.tags) requestData.tags = routeData.tags;

	const result = await api.createRoute(controlPlaneId, requestData);

	return {
		success: true,
		route: {
			routeId: result.id,
			name: result.name,
			protocols: result.protocols,
			methods: result.methods,
			hosts: result.hosts,
			paths: result.paths,
			stripPath: result.strip_path,
			preserveHost: result.preserve_host,
			regexPriority: result.regex_priority,
			serviceId: result.service?.id,
			tags: result.tags,
			metadata: {
				createdAt: result.created_at,
				updatedAt: result.updated_at,
			},
		},
		message: `Route created successfully with ID: ${result.id}`,
		relatedTools: [
			"Use list-routes to see all routes in this control plane",
			"Use create-plugin to add plugins to this route",
			"Use query-api-requests to monitor traffic on this route",
		],
	};
}

/**
 * Get detailed information about a specific route
 */
export async function getRoute(api: KongApi, controlPlaneId: string, routeId: string) {
	log.debug({ controlPlaneId, routeId }, "Getting route");
	const result = await api.getRoute(controlPlaneId, routeId);

	return {
		route: {
			routeId: result.id,
			name: result.name,
			protocols: result.protocols,
			methods: result.methods,
			hosts: result.hosts,
			paths: result.paths,
			stripPath: result.strip_path,
			preserveHost: result.preserve_host,
			regexPriority: result.regex_priority,
			serviceId: result.service?.id,
			tags: result.tags,
			enabled: result.enabled,
			metadata: {
				createdAt: result.created_at,
				updatedAt: result.updated_at,
			},
		},
		relatedTools: [
			"Use list-plugins to see plugins configured for this route",
			"Use update-route to modify this route's configuration",
			"Use query-api-requests to analyze traffic on this route",
		],
	};
}

/**
 * Update an existing route
 */
export async function updateRoute(
	api: KongApi,
	controlPlaneId: string,
	routeId: string,
	routeData: {
		name?: string;
		protocols?: string[];
		methods?: string[];
		hosts?: string[];
		paths?: string[];
		serviceId?: string;
		stripPath?: boolean;
		preserveHost?: boolean;
		regexPriority?: number;
		tags?: string[];
		enabled?: boolean;
	},
) {
	log.debug({ controlPlaneId, routeId }, "Updating route");
	const requestData: Record<string, unknown> = {};

	if (routeData.name !== undefined) requestData.name = routeData.name;
	if (routeData.protocols !== undefined) requestData.protocols = routeData.protocols;
	if (routeData.methods !== undefined) requestData.methods = routeData.methods;
	if (routeData.hosts !== undefined) requestData.hosts = routeData.hosts;
	if (routeData.paths !== undefined) requestData.paths = routeData.paths;
	if (routeData.serviceId !== undefined) requestData.service = { id: routeData.serviceId };
	if (routeData.stripPath !== undefined) requestData.strip_path = routeData.stripPath;
	if (routeData.preserveHost !== undefined) requestData.preserve_host = routeData.preserveHost;
	if (routeData.regexPriority !== undefined) requestData.regex_priority = routeData.regexPriority;
	if (routeData.tags !== undefined) requestData.tags = routeData.tags;
	if (routeData.enabled !== undefined) requestData.enabled = routeData.enabled;

	const result = await api.updateRoute(controlPlaneId, routeId, requestData);

	return {
		success: true,
		route: {
			routeId: result.id,
			name: result.name,
			protocols: result.protocols,
			methods: result.methods,
			hosts: result.hosts,
			paths: result.paths,
			stripPath: result.strip_path,
			preserveHost: result.preserve_host,
			regexPriority: result.regex_priority,
			serviceId: result.service?.id,
			tags: result.tags,
			enabled: result.enabled,
			metadata: {
				createdAt: result.created_at,
				updatedAt: result.updated_at,
			},
		},
		message: `Route updated successfully`,
		relatedTools: [
			"Use get-route to see the updated route details",
			"Use query-api-requests to monitor changes in traffic patterns",
		],
	};
}

/**
 * Delete a route from a control plane
 */
export async function deleteRoute(api: KongApi, controlPlaneId: string, routeId: string) {
	log.debug({ controlPlaneId, routeId }, "Deleting route");
	await api.deleteRoute(controlPlaneId, routeId);

	return {
		success: true,
		message: `Route ${routeId} deleted successfully`,
		relatedTools: [
			"Use list-routes to see remaining routes in this control plane",
			"Use list-services to check service configurations",
		],
	};
}

/**
 * List consumers for a specific control plane
 */
export async function listConsumers(api: KongApi, controlPlaneId: string, size = 100, offset?: string) {
	log.debug({ controlPlaneId }, "Listing consumers");
	const result = await api.listConsumers(controlPlaneId, size, offset);

	// SIO-663: applied-pagination metadata derived from observed result; Kong caps `size` at 100.
	const actualCount = result.data.length;
	const effectiveSize = Math.min(size, actualCount);
	const capped = size > actualCount && actualCount === 100;

	// Transform the response to have consistent field names
	return {
		metadata: {
			controlPlaneId: controlPlaneId,
			requestedSize: size,
			effectiveSize,
			actualCount,
			capped,
			offset: offset || null,
			nextOffset: result.offset,
			totalCount: result.total,
		},
		consumers: result.data.map((consumer) => ({
			consumerId: consumer.id,
			username: consumer.username,
			customId: consumer.custom_id,
			tags: consumer.tags,
			enabled: consumer.enabled,
			metadata: {
				createdAt: consumer.created_at,
				updatedAt: consumer.updated_at,
			},
		})),
		relatedTools: [
			"Use get-consumer-requests to analyze traffic for a specific consumer",
			"Use list-plugins to see plugins configured for these consumers",
			"Use query-api-requests to identify consumers with high error rates",
		],
	};
}

/**
 * Create a new consumer in a control plane
 */
export async function createConsumer(
	api: KongApi,
	controlPlaneId: string,
	consumerData: {
		username?: string;
		customId?: string;
		tags?: string[];
		enabled?: boolean;
	},
	// biome-ignore lint/suspicious/noExplicitAny: MCP RequestHandlerExtra generics are passthrough request/transport types; consumers don't constrain them.
	extra?: RequestHandlerExtra<any, any>,
) {
	log.debug({ controlPlaneId, username: consumerData.username || null }, "Creating consumer");
	// Check if deployment context is missing from tags
	const contextCheck = extractDeploymentContext(consumerData.tags);

	if (contextCheck.missing.length > 0) {
		if (extra?.sendRequest) {
			// Follow MCP elicitation specification exactly
			try {
				const elicitationResponse = await extra.sendRequest(
					{
						method: "elicitation/create",
						params: {
							message: `Please provide deployment context for consumer "${consumerData.username || consumerData.customId || "unnamed"}":`,
							requestedSchema: {
								type: "object",
								properties: {
									domain: {
										type: "string",
										title: "Domain",
										description: "What domain does this consumer belong to?",
									},
									environment: {
										type: "string",
										title: "Environment",
										description: "What environment is this for?",
									},
									team: {
										type: "string",
										title: "Team",
										description: "Which team owns this consumer?",
									},
								},
								required: ["domain", "environment", "team"],
							},
						},
					},
					// Response schema as per specification
					z.object({
						action: z.enum(["accept", "decline", "cancel"]),
						content: z
							.object({
								domain: z.string(),
								environment: z.string(),
								team: z.string(),
							})
							.optional(),
					}),
				);

				if (elicitationResponse.action === "accept" && elicitationResponse.content) {
					// Generate complete tag structure with user-provided context
					const completeTags = generateTags(
						elicitationResponse.content,
						"consumer",
						consumerData.username || consumerData.customId,
					);
					consumerData.tags = completeTags;
				} else if (elicitationResponse.action === "decline") {
					throw new Error(`Consumer creation declined by user. Please provide deployment tags manually.`);
				} else {
					// Cancelled
					throw new Error(`Consumer creation cancelled by user. Please provide deployment tags manually.`);
				}
			} catch (_error) {
				// Elicitation failed - fall back to error with instructions
				throw new Error(
					`Consumer creation requires deployment tags. Missing: ${contextCheck.missing.join(", ")}. Use mcp__kong-konnect__analyze_migration_context to analyze your configuration and mcp__kong-konnect__create_elicitation_session to gather missing information.`,
				);
			}
		} else {
			// No elicitation support - throw error with instructions
			throw new Error(
				`Consumer creation requires deployment tags. Missing: ${contextCheck.missing.join(", ")}. Use mcp__kong-konnect__analyze_migration_context to analyze your configuration and mcp__kong-konnect__create_elicitation_session to gather missing information.`,
			);
		}
	}
	const requestData: Record<string, unknown> = {};

	if (consumerData.username) requestData.username = consumerData.username;
	if (consumerData.customId) requestData.custom_id = consumerData.customId;
	if (consumerData.tags) requestData.tags = consumerData.tags;

	const result = await api.createConsumer(controlPlaneId, requestData);

	return {
		success: true,
		consumer: {
			consumerId: result.id,
			username: result.username,
			customId: result.custom_id,
			tags: result.tags,
			enabled: result.enabled,
			metadata: {
				createdAt: result.created_at,
				updatedAt: result.updated_at,
			},
		},
		message: `Consumer created successfully with ID: ${result.id}`,
		relatedTools: [
			"Use list-consumers to see all consumers in this control plane",
			"Use create-plugin to add authentication plugins for this consumer",
		],
	};
}

/**
 * Get detailed information about a specific consumer
 */
export async function getConsumer(api: KongApi, controlPlaneId: string, consumerId: string) {
	log.debug({ controlPlaneId, consumerId }, "Getting consumer");
	const result = await api.getConsumer(controlPlaneId, consumerId);

	return {
		consumer: {
			consumerId: result.id,
			username: result.username,
			customId: result.custom_id,
			tags: result.tags,
			enabled: result.enabled,
			metadata: {
				createdAt: result.created_at,
				updatedAt: result.updated_at,
			},
		},
		relatedTools: [
			"Use get-consumer-requests to analyze this consumer's API usage",
			"Use list-plugins to see plugins configured for this consumer",
			"Use update-consumer to modify this consumer's configuration",
		],
	};
}

/**
 * Update an existing consumer
 */
export async function updateConsumer(
	api: KongApi,
	controlPlaneId: string,
	consumerId: string,
	consumerData: {
		username?: string;
		customId?: string;
		tags?: string[];
		enabled?: boolean;
	},
) {
	log.debug({ controlPlaneId, consumerId }, "Updating consumer");
	const requestData: Record<string, unknown> = {};

	if (consumerData.username !== undefined) requestData.username = consumerData.username;
	if (consumerData.customId !== undefined) requestData.custom_id = consumerData.customId;
	if (consumerData.tags !== undefined) requestData.tags = consumerData.tags;
	if (consumerData.enabled !== undefined) requestData.enabled = consumerData.enabled;

	const result = await api.updateConsumer(controlPlaneId, consumerId, requestData);

	return {
		success: true,
		consumer: {
			consumerId: result.id,
			username: result.username,
			customId: result.custom_id,
			tags: result.tags,
			enabled: result.enabled,
			metadata: {
				createdAt: result.created_at,
				updatedAt: result.updated_at,
			},
		},
		message: `Consumer updated successfully`,
		relatedTools: [
			"Use get-consumer to see the updated consumer details",
			"Use get-consumer-requests to monitor this consumer's activity",
		],
	};
}

/**
 * Delete a consumer from a control plane
 */
export async function deleteConsumer(api: KongApi, controlPlaneId: string, consumerId: string) {
	log.debug({ controlPlaneId, consumerId }, "Deleting consumer");
	await api.deleteConsumer(controlPlaneId, consumerId);

	return {
		success: true,
		message: `Consumer ${consumerId} deleted successfully`,
		warning: "All credentials and plugins associated with this consumer have been removed",
		relatedTools: ["Use list-consumers to see remaining consumers in this control plane"],
	};
}

/**
 * List plugins for a specific control plane
 */
export async function listPlugins(api: KongApi, controlPlaneId: string, size = 100, offset?: string) {
	log.debug({ controlPlaneId }, "Listing plugins");
	const result = await api.listPlugins(controlPlaneId, size, offset);

	// SIO-663: applied-pagination metadata derived from observed result; Kong caps `size` at 100.
	const actualCount = result.data.length;
	const effectiveSize = Math.min(size, actualCount);
	const capped = size > actualCount && actualCount === 100;

	// Transform the response to have consistent field names
	return {
		metadata: {
			controlPlaneId: controlPlaneId,
			requestedSize: size,
			effectiveSize,
			actualCount,
			capped,
			offset: offset || null,
			nextOffset: result.offset,
			totalCount: result.total,
		},
		plugins: result.data.map((plugin) => ({
			pluginId: plugin.id,
			name: plugin.name,
			enabled: plugin.enabled,
			config: plugin.config,
			protocols: plugin.protocols,
			tags: plugin.tags,
			scoping: {
				consumerId: plugin.consumer?.id,
				serviceId: plugin.service?.id,
				routeId: plugin.route?.id,
				global: !plugin.consumer && !plugin.service && !plugin.route,
			},
			metadata: {
				createdAt: plugin.created_at,
				updatedAt: plugin.updated_at,
			},
		})),
		relatedTools: [
			"Use list-services and list-routes to find entities these plugins are applied to",
			"Use query-api-requests to analyze traffic affected by these plugins",
		],
	};
}

/**
 * Create a new plugin in a control plane
 */
export async function createPlugin(
	api: KongApi,
	controlPlaneId: string,
	pluginData: {
		name: string;
		config?: Record<string, unknown>;
		protocols?: string[];
		consumerId?: string;
		serviceId?: string;
		routeId?: string;
		tags?: string[];
		enabled?: boolean;
	},
	// biome-ignore lint/suspicious/noExplicitAny: MCP RequestHandlerExtra generics are passthrough request/transport types; consumers don't constrain them.
	extra?: RequestHandlerExtra<any, any>,
) {
	log.debug({ controlPlaneId, name: pluginData.name }, "Creating plugin");
	// Check if deployment context is missing from tags
	const contextCheck = extractDeploymentContext(pluginData.tags);

	if (contextCheck.missing.length > 0) {
		if (extra?.sendRequest) {
			// Follow MCP elicitation specification exactly
			try {
				const elicitationResponse = await extra.sendRequest(
					{
						method: "elicitation/create",
						params: {
							message: `Please provide deployment context for plugin "${pluginData.name}":`,
							requestedSchema: {
								type: "object",
								properties: {
									domain: {
										type: "string",
										title: "Domain",
										description: "What domain does this plugin belong to?",
									},
									environment: {
										type: "string",
										title: "Environment",
										description: "What environment is this for?",
									},
									team: {
										type: "string",
										title: "Team",
										description: "Which team owns this plugin?",
									},
								},
								required: ["domain", "environment", "team"],
							},
						},
					},
					// Response schema as per specification
					z.object({
						action: z.enum(["accept", "decline", "cancel"]),
						content: z
							.object({
								domain: z.string(),
								environment: z.string(),
								team: z.string(),
							})
							.optional(),
					}),
				);

				if (elicitationResponse.action === "accept" && elicitationResponse.content) {
					// Generate complete tag structure with user-provided context
					const completeTags = generateTags(elicitationResponse.content, "plugin", pluginData.name);
					pluginData.tags = completeTags;
				} else if (elicitationResponse.action === "decline") {
					throw new Error(`Plugin creation declined by user. Please provide deployment tags manually.`);
				} else {
					// Cancelled
					throw new Error(`Plugin creation cancelled by user. Please provide deployment tags manually.`);
				}
			} catch (_error) {
				// Elicitation failed - fall back to error with instructions
				throw new Error(
					`Plugin creation requires deployment tags. Missing: ${contextCheck.missing.join(", ")}. Use mcp__kong-konnect__analyze_migration_context to analyze your configuration and mcp__kong-konnect__create_elicitation_session to gather missing information.`,
				);
			}
		} else {
			// No elicitation support - throw error with instructions
			throw new Error(
				`Plugin creation requires deployment tags. Missing: ${contextCheck.missing.join(", ")}. Use mcp__kong-konnect__analyze_migration_context to analyze your configuration and mcp__kong-konnect__create_elicitation_session to gather missing information.`,
			);
		}
	}
	const requestData: Record<string, unknown> = {
		name: pluginData.name,
		enabled: pluginData.enabled ?? true,
	};

	if (pluginData.config) requestData.config = pluginData.config;
	if (pluginData.protocols) requestData.protocols = pluginData.protocols;
	if (pluginData.consumerId) requestData.consumer = { id: pluginData.consumerId };
	if (pluginData.serviceId) requestData.service = { id: pluginData.serviceId };
	if (pluginData.routeId) requestData.route = { id: pluginData.routeId };
	if (pluginData.tags) requestData.tags = pluginData.tags;

	const result = await api.createPlugin(controlPlaneId, requestData);

	return {
		success: true,
		plugin: {
			pluginId: result.id,
			name: result.name,
			enabled: result.enabled,
			config: result.config,
			protocols: result.protocols,
			tags: result.tags,
			scoping: {
				consumerId: result.consumer?.id,
				serviceId: result.service?.id,
				routeId: result.route?.id,
				global: !result.consumer && !result.service && !result.route,
			},
			metadata: {
				createdAt: result.created_at,
				updatedAt: result.updated_at,
			},
		},
		message: `Plugin '${result.name}' created successfully with ID: ${result.id}`,
		relatedTools: [
			"Use list-plugins to see all plugins in this control plane",
			"Use query-api-requests to monitor the impact of this plugin",
		],
	};
}

/**
 * Get detailed information about a specific plugin
 */
export async function getPlugin(api: KongApi, controlPlaneId: string, pluginId: string) {
	log.debug({ controlPlaneId, pluginId }, "Getting plugin");
	const result = await api.getPlugin(controlPlaneId, pluginId);

	return {
		plugin: {
			pluginId: result.id,
			name: result.name,
			enabled: result.enabled,
			config: result.config,
			protocols: result.protocols,
			tags: result.tags,
			scoping: {
				consumerId: result.consumer?.id,
				serviceId: result.service?.id,
				routeId: result.route?.id,
				global: !result.consumer && !result.service && !result.route,
			},
			metadata: {
				createdAt: result.created_at,
				updatedAt: result.updated_at,
			},
		},
		relatedTools: [
			"Use update-plugin to modify this plugin's configuration",
			"Use list-plugin-schemas to see configuration options",
		],
	};
}

/**
 * Update an existing plugin
 */
export async function updatePlugin(
	api: KongApi,
	controlPlaneId: string,
	pluginId: string,
	pluginData: {
		name?: string;
		config?: Record<string, unknown>;
		protocols?: string[];
		consumerId?: string;
		serviceId?: string;
		routeId?: string;
		tags?: string[];
		enabled?: boolean;
	},
) {
	log.debug({ controlPlaneId, pluginId }, "Updating plugin");
	const requestData: Record<string, unknown> = {};

	if (pluginData.name !== undefined) requestData.name = pluginData.name;
	if (pluginData.config !== undefined) requestData.config = pluginData.config;
	if (pluginData.protocols !== undefined) requestData.protocols = pluginData.protocols;
	if (pluginData.consumerId !== undefined) requestData.consumer = { id: pluginData.consumerId };
	if (pluginData.serviceId !== undefined) requestData.service = { id: pluginData.serviceId };
	if (pluginData.routeId !== undefined) requestData.route = { id: pluginData.routeId };
	if (pluginData.tags !== undefined) requestData.tags = pluginData.tags;
	if (pluginData.enabled !== undefined) requestData.enabled = pluginData.enabled;

	const result = await api.updatePlugin(controlPlaneId, pluginId, requestData);

	return {
		success: true,
		plugin: {
			pluginId: result.id,
			name: result.name,
			enabled: result.enabled,
			config: result.config,
			protocols: result.protocols,
			tags: result.tags,
			scoping: {
				consumerId: result.consumer?.id,
				serviceId: result.service?.id,
				routeId: result.route?.id,
				global: !result.consumer && !result.service && !result.route,
			},
			metadata: {
				createdAt: result.created_at,
				updatedAt: result.updated_at,
			},
		},
		message: `Plugin '${result.name}' updated successfully`,
		relatedTools: [
			"Use get-plugin to see the updated plugin details",
			"Use query-api-requests to monitor the plugin's impact",
		],
	};
}

/**
 * Delete a plugin from a control plane
 */
export async function deletePlugin(api: KongApi, controlPlaneId: string, pluginId: string) {
	log.debug({ controlPlaneId, pluginId }, "Deleting plugin");
	await api.deletePlugin(controlPlaneId, pluginId);

	return {
		success: true,
		message: `Plugin ${pluginId} deleted successfully`,
		relatedTools: ["Use list-plugins to see remaining plugins in this control plane"],
	};
}

/**
 * List all available plugin schemas
 */
export async function listPluginSchemas(api: KongApi, controlPlaneId: string) {
	log.debug({ controlPlaneId }, "Listing plugin schemas");
	const result = await api.listPluginSchemas(controlPlaneId);

	return {
		schemas: result.data
			? result.data.map((schema) => ({
					name: schema.name,
					description: schema.description,
					fields: schema.fields,
					required: schema.required,
					examples: schema.examples,
				}))
			: result,
		relatedTools: [
			"Use create-plugin to create plugins using these schemas",
			"Use list-plugins to see currently configured plugins",
		],
	};
}
