import type { MCPTool, ToolHandler } from "../registry.js";
import * as configurationOps from "./operations.js";
import type {
	CreateConsumerArgs,
	CreatePluginArgs,
	CreateRouteArgs,
	CreateServiceArgs,
	GetConsumerArgs,
	GetPluginArgs,
	GetRouteArgs,
	GetServiceArgs,
	ListConsumersArgs,
	ListPluginSchemasArgs,
	ListPluginsArgs,
	ListRoutesArgs,
	ListServicesArgs,
	UpdateConsumerArgs,
} from "./parameters.js";
import * as parameters from "./parameters.js";
import * as prompts from "./prompts.js";

// Mirrors the legacy server.ts switch default branch -- update/delete variants
// for service, route, consumer, plugin were intentionally not dispatched
// ("MOVED TO BLOCKED OPERATIONS"). Preserve that behaviour at the closure level
// rather than silently wiring them through.
const blockedOperationHandler =
	(method: string): ToolHandler =>
	async () => {
		throw new Error(`Unknown tool method: ${method}`);
	};

export const configurationTools = (): MCPTool[] => [
	{
		method: "list_services",
		name: "List Services",
		description: prompts.listServicesPrompt(),
		parameters: parameters.listServicesParameters,
		category: "configuration",
		handler: async (args: ListServicesArgs, { api }) =>
			configurationOps.listServices(api, args.controlPlaneId, args.size, args.offset),
	},
	{
		method: "list_routes",
		name: "List Routes",
		description: prompts.listRoutesPrompt(),
		parameters: parameters.listRoutesParameters,
		category: "configuration",
		handler: async (args: ListRoutesArgs, { api }) =>
			configurationOps.listRoutes(api, args.controlPlaneId, args.size, args.offset),
	},
	{
		method: "list_consumers",
		name: "List Consumers",
		description: prompts.listConsumersPrompt(),
		parameters: parameters.listConsumersParameters,
		category: "configuration",
		handler: async (args: ListConsumersArgs, { api }) =>
			configurationOps.listConsumers(api, args.controlPlaneId, args.size, args.offset),
	},
	{
		method: "list_plugins",
		name: "List Plugins",
		description: prompts.listPluginsPrompt(),
		parameters: parameters.listPluginsParameters,
		category: "configuration",
		handler: async (args: ListPluginsArgs, { api }) =>
			configurationOps.listPlugins(api, args.controlPlaneId, args.size, args.offset),
	},

	{
		method: "create_service",
		name: "Create Service",
		description: prompts.createServicePrompt(),
		parameters: parameters.createServiceParameters,
		category: "configuration",
		handler: async (args: CreateServiceArgs, { api, extra }) =>
			configurationOps.createService(
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
			),
	},
	{
		method: "get_service",
		name: "Get Service",
		description: prompts.getServicePrompt(),
		parameters: parameters.getServiceParameters,
		category: "configuration",
		handler: async (args: GetServiceArgs, { api }) =>
			configurationOps.getService(api, args.controlPlaneId, args.serviceId),
	},
	{
		method: "update_service",
		name: "Update Service",
		description: prompts.updateServicePrompt(),
		parameters: parameters.updateServiceParameters,
		category: "configuration",
		handler: blockedOperationHandler("update_service"),
	},
	{
		method: "delete_service",
		name: "Delete Service",
		description: prompts.deleteServicePrompt(),
		parameters: parameters.deleteServiceParameters,
		category: "configuration",
		handler: blockedOperationHandler("delete_service"),
	},

	{
		method: "create_route",
		name: "Create Route",
		description: prompts.createRoutePrompt(),
		parameters: parameters.createRouteParameters,
		category: "configuration",
		handler: async (args: CreateRouteArgs, { api, extra }) =>
			configurationOps.createRoute(
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
			),
	},
	{
		method: "get_route",
		name: "Get Route",
		description: prompts.getRoutePrompt(),
		parameters: parameters.getRouteParameters,
		category: "configuration",
		handler: async (args: GetRouteArgs, { api }) => configurationOps.getRoute(api, args.controlPlaneId, args.routeId),
	},
	{
		method: "update_route",
		name: "Update Route",
		description: prompts.updateRoutePrompt(),
		parameters: parameters.updateRouteParameters,
		category: "configuration",
		handler: blockedOperationHandler("update_route"),
	},
	{
		method: "delete_route",
		name: "Delete Route",
		description: prompts.deleteRoutePrompt(),
		parameters: parameters.deleteRouteParameters,
		category: "configuration",
		handler: blockedOperationHandler("delete_route"),
	},

	{
		method: "create_consumer",
		name: "Create Consumer",
		description: prompts.createConsumerPrompt(),
		parameters: parameters.createConsumerParameters,
		category: "configuration",
		handler: async (args: CreateConsumerArgs, { api, extra }) =>
			configurationOps.createConsumer(
				api,
				args.controlPlaneId,
				{
					username: args.username,
					customId: args.customId,
					tags: args.tags,
					enabled: args.enabled,
				},
				extra,
			),
	},
	{
		method: "get_consumer",
		name: "Get Consumer",
		description: prompts.getConsumerPrompt(),
		parameters: parameters.getConsumerParameters,
		category: "configuration",
		handler: async (args: GetConsumerArgs, { api }) =>
			configurationOps.getConsumer(api, args.controlPlaneId, args.consumerId),
	},
	{
		method: "update_consumer",
		name: "Update Consumer",
		description: prompts.updateConsumerPrompt(),
		parameters: parameters.updateConsumerParameters,
		category: "configuration",
		handler: async (args: UpdateConsumerArgs, { api }) =>
			configurationOps.updateConsumer(api, args.controlPlaneId, args.consumerId, {
				username: args.username,
				customId: args.customId,
				tags: args.tags,
				enabled: args.enabled,
			}),
	},
	{
		method: "delete_consumer",
		name: "Delete Consumer",
		description: prompts.deleteConsumerPrompt(),
		parameters: parameters.deleteConsumerParameters,
		category: "configuration",
		handler: blockedOperationHandler("delete_consumer"),
	},

	{
		method: "create_plugin",
		name: "Create Plugin",
		description: prompts.createPluginPrompt(),
		parameters: parameters.createPluginParameters,
		category: "configuration",
		handler: async (args: CreatePluginArgs, { api, extra }) =>
			configurationOps.createPlugin(
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
			),
	},
	{
		method: "get_plugin",
		name: "Get Plugin",
		description: prompts.getPluginPrompt(),
		parameters: parameters.getPluginParameters,
		category: "configuration",
		handler: async (args: GetPluginArgs, { api }) =>
			configurationOps.getPlugin(api, args.controlPlaneId, args.pluginId),
	},
	{
		method: "update_plugin",
		name: "Update Plugin",
		description: prompts.updatePluginPrompt(),
		parameters: parameters.updatePluginParameters,
		category: "configuration",
		handler: blockedOperationHandler("update_plugin"),
	},
	{
		method: "delete_plugin",
		name: "Delete Plugin",
		description: prompts.deletePluginPrompt(),
		parameters: parameters.deletePluginParameters,
		category: "configuration",
		handler: blockedOperationHandler("delete_plugin"),
	},
	{
		method: "list_plugin_schemas",
		name: "List Plugin Schemas",
		description: prompts.listPluginSchemasPrompt(),
		parameters: parameters.listPluginSchemasParameters,
		category: "configuration",
		handler: async (args: ListPluginSchemasArgs, { api }) =>
			configurationOps.listPluginSchemas(api, args.controlPlaneId),
	},
];
