export const createServicePrompt = () => `
Create a new service in a Kong control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - name: String - Service name (must be unique within control plane)
  - host: String - Hostname or IP address of the upstream service
  - port: Number - Port of the upstream service (default: 80)
  - protocol: String - Protocol to use: http, https, grpc, grpcs, tcp, tls, udp (default: http)
  - path: String (optional) - Path to be used in requests to upstream
  - retries: Number - Number of retries on failure (default: 5)
  - connectTimeout: Number - Connection timeout in ms (default: 60000)
  - writeTimeout: Number - Write timeout in ms (default: 60000)
  - readTimeout: Number - Read timeout in ms (default: 60000)
  - tags: Array (optional) - Tags to associate with the service
  - enabled: Boolean - Whether the service is enabled (default: true)

OUTPUT:
  - success: Boolean - Whether the operation succeeded
  - service: Object - Created service details including serviceId and all configuration
  - message: String - Success message with service ID
  - relatedTools: Array - Suggested next steps and related tools
`;

export const getServicePrompt = () => `
Get detailed information about a specific service.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - serviceId: String - ID of the service to retrieve

OUTPUT:
  - service: Object - Complete service configuration including:
    - serviceId: String - Unique service identifier
    - name: String - Service name
    - host: String - Upstream host
    - port: Number - Upstream port
    - protocol: String - Protocol used
    - path: String - Path prefix
    - retries: Number - Retry configuration
    - timeout settings: Connection, write, and read timeouts
    - security settings: TLS configuration
    - tags: Array - Associated tags
    - enabled: Boolean - Service status
    - metadata: Object - Creation and update timestamps
  - relatedTools: Array - Related operations for this service
`;

export const updateServicePrompt = () => `
Update an existing service configuration.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - serviceId: String - ID of the service to update
  - name: String (optional) - New service name
  - host: String (optional) - New hostname or IP address
  - port: Number (optional) - New port number
  - protocol: String (optional) - New protocol
  - path: String (optional) - New path prefix
  - retries: Number (optional) - New retry count
  - connectTimeout: Number (optional) - New connection timeout
  - writeTimeout: Number (optional) - New write timeout
  - readTimeout: Number (optional) - New read timeout
  - tags: Array (optional) - New tags array
  - enabled: Boolean (optional) - New enabled status

OUTPUT:
  - success: Boolean - Whether the update succeeded
  - service: Object - Updated service configuration
  - message: String - Success message
  - relatedTools: Array - Suggested follow-up actions
`;

export const deleteServicePrompt = () => `
Delete a service from a control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - serviceId: String - ID of the service to delete

OUTPUT:
  - success: Boolean - Whether the deletion succeeded
  - message: String - Confirmation message
  - warning: String - Important information about orphaned routes
  - relatedTools: Array - Recommended cleanup actions
`;

export const createRoutePrompt = () => `
Create a new route in a Kong control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - name: String (optional) - Route name (must be unique within control plane)
  - protocols: Array - Protocols this route supports (default: ["http", "https"])
  - methods: Array (optional) - HTTP methods this route matches
  - hosts: Array (optional) - Host header values this route matches
  - paths: Array (optional) - Path values this route matches
  - serviceId: String (optional) - Service ID this route points to
  - stripPath: Boolean - Strip matched path from upstream (default: true)
  - preserveHost: Boolean - Preserve original host header (default: false)
  - regexPriority: Number - Priority for regex-based routes (default: 0)
  - tags: Array (optional) - Tags to associate with the route
  - enabled: Boolean - Whether the route is enabled (default: true)

OUTPUT:
  - success: Boolean - Whether the operation succeeded
  - route: Object - Created route details including routeId and all configuration
  - message: String - Success message with route ID
  - relatedTools: Array - Suggested next steps and related tools
`;

export const getRoutePrompt = () => `
Get detailed information about a specific route.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - routeId: String - ID of the route to retrieve

OUTPUT:
  - route: Object - Complete route configuration including:
    - routeId: String - Unique route identifier
    - name: String - Route name
    - protocols: Array - Supported protocols
    - methods: Array - HTTP methods matched
    - hosts: Array - Host patterns
    - paths: Array - Path patterns
    - serviceId: String - Associated service ID
    - routing behavior: Strip path and preserve host settings
    - tags: Array - Associated tags
    - enabled: Boolean - Route status
    - metadata: Object - Creation and update timestamps
  - relatedTools: Array - Related operations for this route
`;

export const updateRoutePrompt = () => `
Update an existing route configuration.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - routeId: String - ID of the route to update
  - name: String (optional) - New route name
  - protocols: Array (optional) - New protocols array
  - methods: Array (optional) - New HTTP methods
  - hosts: Array (optional) - New host patterns
  - paths: Array (optional) - New path patterns
  - serviceId: String (optional) - New service ID
  - stripPath: Boolean (optional) - New strip path setting
  - preserveHost: Boolean (optional) - New preserve host setting
  - regexPriority: Number (optional) - New regex priority
  - tags: Array (optional) - New tags array
  - enabled: Boolean (optional) - New enabled status

OUTPUT:
  - success: Boolean - Whether the update succeeded
  - route: Object - Updated route configuration
  - message: String - Success message
  - relatedTools: Array - Suggested follow-up actions
`;

export const deleteRoutePrompt = () => `
Delete a route from a control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - routeId: String - ID of the route to delete

OUTPUT:
  - success: Boolean - Whether the deletion succeeded
  - message: String - Confirmation message
  - relatedTools: Array - Recommended follow-up actions
`;

export const createConsumerPrompt = () => `
Create a new consumer in a Kong control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - username: String (optional) - Consumer username (must be unique)
  - customId: String (optional) - Custom ID (must be unique)
  - tags: Array (optional) - Tags to associate with the consumer
  - enabled: Boolean - Whether the consumer is enabled (default: true)

Note: Either username or customId must be provided.

OUTPUT:
  - success: Boolean - Whether the operation succeeded
  - consumer: Object - Created consumer details including consumerId
  - message: String - Success message with consumer ID
  - relatedTools: Array - Suggested next steps for credential management
`;

export const getConsumerPrompt = () => `
Get detailed information about a specific consumer.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - consumerId: String - ID of the consumer to retrieve

OUTPUT:
  - consumer: Object - Complete consumer configuration including:
    - consumerId: String - Unique consumer identifier
    - username: String - Consumer username
    - customId: String - Custom ID
    - tags: Array - Associated tags
    - enabled: Boolean - Consumer status
    - metadata: Object - Creation and update timestamps
  - relatedTools: Array - Related operations for this consumer
`;

export const updateConsumerPrompt = () => `
Update an existing consumer configuration.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - consumerId: String - ID of the consumer to update
  - username: String (optional) - New username
  - customId: String (optional) - New custom ID
  - tags: Array (optional) - New tags array
  - enabled: Boolean (optional) - New enabled status

OUTPUT:
  - success: Boolean - Whether the update succeeded
  - consumer: Object - Updated consumer configuration
  - message: String - Success message
  - relatedTools: Array - Suggested follow-up actions
`;

export const deleteConsumerPrompt = () => `
Delete a consumer from a control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - consumerId: String - ID of the consumer to delete

OUTPUT:
  - success: Boolean - Whether the deletion succeeded
  - message: String - Confirmation message
  - warning: String - Information about credential cleanup
  - relatedTools: Array - Recommended follow-up actions
`;

export const createPluginPrompt = () => `
Create a new plugin in a Kong control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - name: String - Plugin name (use list-plugin-schemas to see available)
  - config: Object (optional) - Plugin configuration (varies by plugin)
  - protocols: Array (optional) - Protocols this plugin applies to
  - consumerId: String (optional) - Apply to specific consumer (global if empty)
  - serviceId: String (optional) - Apply to specific service (global if empty)
  - routeId: String (optional) - Apply to specific route (global if empty)
  - tags: Array (optional) - Tags to associate with the plugin
  - enabled: Boolean - Whether the plugin is enabled (default: true)

OUTPUT:
  - success: Boolean - Whether the operation succeeded
  - plugin: Object - Created plugin details including pluginId and configuration
  - message: String - Success message with plugin ID
  - relatedTools: Array - Suggested configuration and testing steps
`;

export const getPluginPrompt = () => `
Get detailed information about a specific plugin.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - pluginId: String - ID of the plugin to retrieve

OUTPUT:
  - plugin: Object - Complete plugin configuration including:
    - pluginId: String - Unique plugin identifier
    - name: String - Plugin name
    - config: Object - Plugin configuration
    - protocols: Array - Applicable protocols
    - scoping: Object - Consumer, service, or route scoping
    - tags: Array - Associated tags
    - enabled: Boolean - Plugin status
    - metadata: Object - Creation and update timestamps
  - relatedTools: Array - Related operations for this plugin
`;

export const updatePluginPrompt = () => `
Update an existing plugin configuration.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - pluginId: String - ID of the plugin to update
  - name: String (optional) - New plugin name
  - config: Object (optional) - New plugin configuration
  - protocols: Array (optional) - New protocols array
  - consumerId: String (optional) - New consumer scoping
  - serviceId: String (optional) - New service scoping
  - routeId: String (optional) - New route scoping
  - tags: Array (optional) - New tags array
  - enabled: Boolean (optional) - New enabled status

OUTPUT:
  - success: Boolean - Whether the update succeeded
  - plugin: Object - Updated plugin configuration
  - message: String - Success message
  - relatedTools: Array - Suggested testing and validation steps
`;

export const deletePluginPrompt = () => `
Delete a plugin from a control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - pluginId: String - ID of the plugin to delete

OUTPUT:
  - success: Boolean - Whether the deletion succeeded
  - message: String - Confirmation message
  - relatedTools: Array - Recommended follow-up actions
`;

export const listPluginSchemasPrompt = () => `
List all available plugin schemas in a control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane

OUTPUT:
  - schemas: Array - List of available plugin schemas including:
    - name: String - Plugin name
    - description: String - Plugin description
    - fields: Array - Configuration fields and their types
    - required: Array - Required configuration fields
    - examples: Object - Example configurations
  - relatedTools: Array - Tools for creating and configuring plugins
`;

export const listServicesPrompt = () => `
List all services associated with a control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - size: Number - Number of services to return (1-1000, default: 100)
  - offset: String (optional) - Pagination offset token from previous response

OUTPUT:
  - metadata: Object - Contains controlPlaneId, size, offset, nextOffset, totalCount
  - services: Array - List of services with details for each including:
    - serviceId: String - Unique identifier for the service
    - name: String - Display name of the service
    - host: String - Target host for the service
    - port: Number - Target port for the service
    - protocol: String - Protocol used (http, https, grpc, etc.)
    - path: String - Path prefix for the service
    - retries: Number - Number of retries on failure
    - connectTimeout: Number - Connection timeout in milliseconds
    - writeTimeout: Number - Write timeout in milliseconds
    - readTimeout: Number - Read timeout in milliseconds
    - tags: Array - Tags associated with the service
    - enabled: Boolean - Whether the service is enabled
    - metadata: Object - Creation and update timestamps
  - relatedTools: Array - List of related tools for further analysis
`;

export const listRoutesPrompt = () => `
List all routes associated with a control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - size: Number - Number of routes to return (1-1000, default: 100)
  - offset: String (optional) - Pagination offset token from previous response

OUTPUT:
  - metadata: Object - Contains controlPlaneId, size, offset, nextOffset, totalCount
  - routes: Array - List of routes with details for each including:
    - routeId: String - Unique identifier for the route
    - name: String - Display name of the route
    - protocols: Array - Protocols this route accepts (http, https, grpc, etc.)
    - methods: Array - HTTP methods this route accepts
    - hosts: Array - Hostnames this route matches
    - paths: Array - URL paths this route matches
    - stripPath: Boolean - Whether to strip the matched path prefix
    - preserveHost: Boolean - Whether to preserve the host header
    - serviceId: String - ID of the service this route forwards to
    - enabled: Boolean - Whether the route is enabled
    - tags: Array - Tags associated with the route
    - metadata: Object - Creation and update timestamps
  - relatedTools: Array - List of related tools for traffic analysis
`;

export const listConsumersPrompt = () => `
List all consumers associated with a control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - size: Number - Number of consumers to return (1-1000, default: 100)
  - offset: String (optional) - Pagination offset token from previous response

OUTPUT:
  - metadata: Object - Contains controlPlaneId, size, offset, nextOffset, totalCount
  - consumers: Array - List of consumers with details for each including:
    - consumerId: String - Unique identifier for the consumer
    - username: String - Consumer username
    - customId: String - Custom consumer identifier
    - tags: Array - Tags associated with the consumer
    - enabled: Boolean - Whether the consumer is enabled
    - metadata: Object - Creation and update timestamps
  - relatedTools: Array - List of related tools for consumer analysis
`;

export const listPluginsPrompt = () => `
List all plugins associated with a control plane.

INPUT:
  - controlPlaneId: String - ID of the control plane
  - size: Number - Number of plugins to return (1-1000, default: 100)
  - offset: String (optional) - Pagination offset token from previous response

OUTPUT:
  - metadata: Object - Contains controlPlaneId, size, offset, nextOffset, totalCount
  - plugins: Array - List of plugins with details for each including:
    - pluginId: String - Unique identifier for the plugin
    - name: String - Plugin name
    - enabled: Boolean - Whether the plugin is enabled
    - config: Object - Plugin configuration
    - protocols: Array - Protocols this plugin applies to
    - scoping: Object - Consumer, service, or route scoping information
    - tags: Array - Tags associated with the plugin
    - metadata: Object - Creation and update timestamps
  - relatedTools: Array - List of related tools for plugin management
`;
