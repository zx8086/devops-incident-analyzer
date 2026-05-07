import { z } from "zod";

/**
 * Standard pagination size parameter
 */
export const pageSizeSchema = z
	.number()
	.int()
	.min(1)
	.max(1000)
	.default(100)
	.describe("Number of items to return per page");

export const createServiceParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	name: z.string().describe("Service name (must be unique within the control plane)"),
	host: z.string().describe("Hostname or IP address of the upstream service"),
	port: z.number().int().min(1).max(65535).default(80).describe("Port of the upstream service"),
	protocol: z
		.enum(["http", "https", "grpc", "grpcs", "tcp", "tls", "udp"])
		.default("http")
		.describe("Protocol used to communicate with the upstream"),
	path: z.string().optional().describe("Path to be used in requests to the upstream service"),
	retries: z.number().int().min(0).default(5).describe("Number of retries to execute upon failure"),
	connectTimeout: z.number().int().min(1).default(60000).describe("Connection timeout in milliseconds"),
	writeTimeout: z.number().int().min(1).default(60000).describe("Write timeout in milliseconds"),
	readTimeout: z.number().int().min(1).default(60000).describe("Read timeout in milliseconds"),
	tags: z.array(z.string()).optional().describe("Optional list of tags to associate with the service"),
	enabled: z.boolean().default(true).describe("Whether the service is enabled"),
});

export const getServiceParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	serviceId: z.string().describe("Service ID (obtainable from list-services tool)"),
});

export const updateServiceParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	serviceId: z.string().describe("Service ID (obtainable from list-services tool)"),
	name: z.string().optional().describe("Service name (must be unique within the control plane)"),
	host: z.string().optional().describe("Hostname or IP address of the upstream service"),
	port: z.number().int().min(1).max(65535).optional().describe("Port of the upstream service"),
	protocol: z
		.enum(["http", "https", "grpc", "grpcs", "tcp", "tls", "udp"])
		.optional()
		.describe("Protocol used to communicate with the upstream"),
	path: z.string().optional().describe("Path to be used in requests to the upstream service"),
	retries: z.number().int().min(0).optional().describe("Number of retries to execute upon failure"),
	connectTimeout: z.number().int().min(1).optional().describe("Connection timeout in milliseconds"),
	writeTimeout: z.number().int().min(1).optional().describe("Write timeout in milliseconds"),
	readTimeout: z.number().int().min(1).optional().describe("Read timeout in milliseconds"),
	tags: z.array(z.string()).optional().describe("Optional list of tags to associate with the service"),
	enabled: z.boolean().optional().describe("Whether the service is enabled"),
});

export const deleteServiceParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	serviceId: z.string().describe("Service ID (obtainable from list-services tool)"),
});

export const createRouteParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	name: z.string().optional().describe("Route name (must be unique within the control plane)"),
	protocols: z
		.array(z.enum(["http", "https", "grpc", "grpcs", "tcp", "tls", "udp"]))
		.default(["http", "https"])
		.describe("Protocols this route should support"),
	methods: z
		.array(z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "TRACE", "CONNECT"]))
		.optional()
		.describe("HTTP methods this route should match"),
	hosts: z.array(z.string()).optional().describe("Host header values this route should match"),
	paths: z.array(z.string()).optional().describe("Path values this route should match"),
	serviceId: z.string().optional().describe("Service ID this route points to (obtainable from list-services tool)"),
	stripPath: z.boolean().default(true).describe("Whether to strip the matched path from upstream request"),
	preserveHost: z.boolean().default(false).describe("Whether to preserve the original host header"),
	regexPriority: z.number().int().min(0).default(0).describe("Priority for regex-based routes"),
	tags: z.array(z.string()).optional().describe("Optional list of tags to associate with the route"),
});

export const getRouteParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	routeId: z.string().describe("Route ID (obtainable from list-routes tool)"),
});

export const updateRouteParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	routeId: z.string().describe("Route ID (obtainable from list-routes tool)"),
	name: z.string().optional().describe("Route name (must be unique within the control plane)"),
	protocols: z
		.array(z.enum(["http", "https", "grpc", "grpcs", "tcp", "tls", "udp"]))
		.optional()
		.describe("Protocols this route should support"),
	methods: z
		.array(z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "TRACE", "CONNECT"]))
		.optional()
		.describe("HTTP methods this route should match"),
	hosts: z.array(z.string()).optional().describe("Host header values this route should match"),
	paths: z.array(z.string()).optional().describe("Path values this route should match"),
	serviceId: z.string().optional().describe("Service ID this route points to (obtainable from list-services tool)"),
	stripPath: z.boolean().optional().describe("Whether to strip the matched path from upstream request"),
	preserveHost: z.boolean().optional().describe("Whether to preserve the original host header"),
	regexPriority: z.number().int().min(0).optional().describe("Priority for regex-based routes"),
	tags: z.array(z.string()).optional().describe("Optional list of tags to associate with the route"),
	enabled: z.boolean().optional().describe("Whether the route is enabled"),
});

export const deleteRouteParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	routeId: z.string().describe("Route ID (obtainable from list-routes tool)"),
});

export const createConsumerParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	username: z.string().optional().describe("Consumer username (must be unique within the control plane)"),
	customId: z.string().optional().describe("Custom ID for the consumer (must be unique within the control plane)"),
	tags: z.array(z.string()).optional().describe("Optional list of tags to associate with the consumer"),
	enabled: z.boolean().default(true).describe("Whether the consumer is enabled"),
});

export const getConsumerParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	consumerId: z.string().describe("Consumer ID (obtainable from list-consumers tool)"),
});

export const updateConsumerParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	consumerId: z.string().describe("Consumer ID (obtainable from list-consumers tool)"),
	username: z.string().optional().describe("Consumer username (must be unique within the control plane)"),
	customId: z.string().optional().describe("Custom ID for the consumer (must be unique within the control plane)"),
	tags: z.array(z.string()).optional().describe("Optional list of tags to associate with the consumer"),
	enabled: z.boolean().optional().describe("Whether the consumer is enabled"),
});

export const deleteConsumerParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	consumerId: z.string().describe("Consumer ID (obtainable from list-consumers tool)"),
});

// Plugin config is intentionally permissive: each Kong plugin defines its own
// schema, surfaced via list_plugin_schemas. z.unknown() preserves runtime safety
// (no implicit any inference) while still accepting arbitrary plugin shapes.
export const createPluginParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	name: z.string().describe("Plugin name (use list-plugin-schemas to see available plugins)"),
	config: z.record(z.string(), z.unknown()).optional().describe("Plugin configuration object (varies by plugin type)"),
	protocols: z
		.array(z.enum(["grpc", "grpcs", "http", "https", "tcp", "tls", "udp"]))
		.optional()
		.describe("Protocols this plugin should apply to"),
	consumerId: z.string().optional().describe("Consumer ID to apply this plugin to (leave empty for global plugins)"),
	serviceId: z.string().optional().describe("Service ID to apply this plugin to (leave empty for global plugins)"),
	routeId: z.string().optional().describe("Route ID to apply this plugin to (leave empty for global plugins)"),
	tags: z.array(z.string()).optional().describe("Optional list of tags to associate with the plugin"),
	enabled: z.boolean().default(true).describe("Whether the plugin is enabled"),
});

export const getPluginParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	pluginId: z.string().describe("Plugin ID (obtainable from list-plugins tool)"),
});

export const updatePluginParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	pluginId: z.string().describe("Plugin ID (obtainable from list-plugins tool)"),
	name: z.string().optional().describe("Plugin name (use list-plugin-schemas to see available plugins)"),
	config: z.record(z.string(), z.unknown()).optional().describe("Plugin configuration object (varies by plugin type)"),
	protocols: z
		.array(z.enum(["grpc", "grpcs", "http", "https", "tcp", "tls", "udp"]))
		.optional()
		.describe("Protocols this plugin should apply to"),
	consumerId: z.string().optional().describe("Consumer ID to apply this plugin to (leave empty for global plugins)"),
	serviceId: z.string().optional().describe("Service ID to apply this plugin to (leave empty for global plugins)"),
	routeId: z.string().optional().describe("Route ID to apply this plugin to (leave empty for global plugins)"),
	tags: z.array(z.string()).optional().describe("Optional list of tags to associate with the plugin"),
	enabled: z.boolean().optional().describe("Whether the plugin is enabled"),
});

export const deletePluginParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	pluginId: z.string().describe("Plugin ID (obtainable from list-plugins tool)"),
});

export const listPluginSchemasParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
});

export const listServicesParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	size: z.number().int().min(1).max(1000).default(100).describe("Number of services to return"),
	offset: z.string().optional().describe("Offset token for pagination (from previous response)"),
});

export const listRoutesParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	size: z.number().int().min(1).max(1000).default(100).describe("Number of routes to return"),
	offset: z.string().optional().describe("Offset token for pagination (from previous response)"),
});

export const listConsumersParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	size: z.number().int().min(1).max(1000).default(100).describe("Number of consumers to return"),
	offset: z.string().optional().describe("Offset token for pagination (from previous response)"),
});

export const listPluginsParameters = z.object({
	controlPlaneId: z.string().describe("Control Plane ID (obtainable from list-control-planes tool)"),
	size: z.number().int().min(1).max(1000).default(100).describe("Number of plugins to return"),
	offset: z.string().optional().describe("Offset token for pagination (from previous response)"),
});

export type CreateServiceArgs = z.infer<typeof createServiceParameters>;
export type GetServiceArgs = z.infer<typeof getServiceParameters>;
export type UpdateServiceArgs = z.infer<typeof updateServiceParameters>;
export type DeleteServiceArgs = z.infer<typeof deleteServiceParameters>;
export type CreateRouteArgs = z.infer<typeof createRouteParameters>;
export type GetRouteArgs = z.infer<typeof getRouteParameters>;
export type UpdateRouteArgs = z.infer<typeof updateRouteParameters>;
export type DeleteRouteArgs = z.infer<typeof deleteRouteParameters>;
export type CreateConsumerArgs = z.infer<typeof createConsumerParameters>;
export type GetConsumerArgs = z.infer<typeof getConsumerParameters>;
export type UpdateConsumerArgs = z.infer<typeof updateConsumerParameters>;
export type DeleteConsumerArgs = z.infer<typeof deleteConsumerParameters>;
export type CreatePluginArgs = z.infer<typeof createPluginParameters>;
export type GetPluginArgs = z.infer<typeof getPluginParameters>;
export type UpdatePluginArgs = z.infer<typeof updatePluginParameters>;
export type DeletePluginArgs = z.infer<typeof deletePluginParameters>;
export type ListPluginSchemasArgs = z.infer<typeof listPluginSchemasParameters>;
export type ListServicesArgs = z.infer<typeof listServicesParameters>;
export type ListRoutesArgs = z.infer<typeof listRoutesParameters>;
export type ListConsumersArgs = z.infer<typeof listConsumersParameters>;
export type ListPluginsArgs = z.infer<typeof listPluginsParameters>;
