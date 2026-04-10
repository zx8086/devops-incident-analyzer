export const listControlPlanesPrompt = () => `
List all control planes in your organization with filtering and pagination options.

INPUT:
  - pageSize: Number - Number of control planes per page (1-1000, default: 10)
  - pageNumber: Number (optional) - Page number to retrieve
  - filterName: String (optional) - Filter control planes by name (partial match)
  - filterClusterType: String (optional) - Filter by cluster type
  - filterCloudGateway: Boolean (optional) - Filter by cloud gateway availability
  - labels: String (optional) - Filter by labels (comma-separated key:value pairs)
  - sort: String (optional) - Sort order for results

OUTPUT:
  - metadata: Object - Contains pagination info, filters, and totals
  - controlPlanes: Array - List of control planes with details including:
    - controlPlaneId: String - Unique identifier for the control plane
    - name: String - Display name of the control plane
    - description: String - Description of the control plane
    - type: String - Type of control plane
    - clusterType: String - Cluster type (e.g., HYBRID, SERVERLESS)
    - controlPlaneEndpoint: String - Endpoint for control plane communication
    - telemetryEndpoint: String - Endpoint for telemetry data
    - hasCloudGateway: Boolean - Whether cloud gateway is available
    - labels: Object - Labels associated with the control plane
    - metadata: Object - Creation and update timestamps

USAGE TIPS:
  - Use the controlPlaneId from results with other tools like list-services, list-routes
  - Filter by clusterType to find specific deployment types
  - Use labels to organize and categorize control planes
  - Large organizations should use pagination for better performance
`;

export const getControlPlanePrompt = () => `
Get detailed information about a specific control plane including configuration and endpoints.

INPUT:
  - controlPlaneId: String - ID of the control plane to retrieve (from list-control-planes)

OUTPUT:
  - controlPlaneDetails: Object - Comprehensive control plane information including:
    - controlPlaneId: String - Unique identifier
    - name: String - Display name
    - description: String - Control plane description
    - type: String - Control plane type
    - clusterType: String - Deployment cluster type
    - controlPlaneEndpoint: String - Management endpoint
    - telemetryEndpoint: String - Telemetry collection endpoint
    - hasCloudGateway: Boolean - Cloud gateway availability
    - labels: Object - Associated labels and metadata
    - metadata: Object - Creation and modification timestamps
  - relatedTools: Array - List of related tools for further exploration

NEXT STEPS:
  - Use list-services to explore services in this control plane
  - Use list-routes to see routing configuration
  - Use list-certificates to view SSL/TLS certificates
  - Use list-data-plane-nodes to see connected data plane nodes
  - Use query-api-requests to analyze traffic patterns
`;

export const listControlPlaneGroupMembershipsPrompt = () => `
List all control planes that are members of a specific control plane group.

INPUT:
  - groupId: String - ID of the control plane group (control plane that acts as the group)
  - pageSize: Number - Number of members to return per page (1-1000, default: 10)
  - pageAfter: String (optional) - Cursor for pagination after a specific item

OUTPUT:
  - metadata: Object - Contains group information and pagination details
  - members: Array - List of group member control planes with:
    - controlPlaneId: String - Member control plane identifier
    - name: String - Member control plane name
    - description: String - Member description
    - type: String - Member type
    - clusterType: String - Member cluster type
    - membershipStatus: Object - Group membership status including:
      - status: String - Membership status
      - message: String - Status message
      - conflicts: Array - Any configuration conflicts
    - metadata: Object - Creation and update timestamps
  - relatedTools: Array - Suggested tools for group management

GROUP MANAGEMENT:
  - Monitor membership status to identify configuration issues
  - Check for conflicts that may affect group synchronization
  - Use related tools to manage group configuration consistency
`;

export const checkControlPlaneGroupMembershipPrompt = () => `
Check if a control plane is a member of any group and get membership details.

INPUT:
  - controlPlaneId: String - ID of the control plane to check (from list-control-planes)

OUTPUT:
  - controlPlaneId: String - The checked control plane ID
  - groupMembership: Object - Membership information including:
    - isMember: Boolean - Whether the control plane is a group member
    - groupId: String - ID of the group (if member)
    - groupName: String - Name of the group (if member)
    - status: String - Current membership status
    - message: String - Status message or details
    - conflicts: Array - Any configuration conflicts with the group
  - relatedTools: Array - Tools for further group management

MEMBERSHIP ANALYSIS:
  - Check membership status before making configuration changes
  - Identify conflicts that may prevent group synchronization
  - Use for troubleshooting group-related issues
  - Monitor group health and consistency
`;

export const createControlPlanePrompt = () => `
Create a new Kong control plane with specified configuration.

INPUT:
  - name: String - Control plane name (must be unique)
  - description: String (optional) - Control plane description  
  - clusterType: String - Cluster type: CLUSTER_TYPE_HYBRID, CLUSTER_TYPE_K8S_INGRESS_CONTROLLER, CLUSTER_TYPE_CONTROL_PLANE (default: CLUSTER_TYPE_HYBRID)
  - cloudGateway: Boolean - Enable cloud gateway capability (default: false)
  - authType: String - Authentication type: pki, pinned_certs (default: pinned_certs)
  - proxyUrls: Array (optional) - Custom proxy URLs for the control plane
  - labels: Object (optional) - Key-value labels to associate with the control plane

OUTPUT:
  - success: Boolean - Whether creation succeeded
  - controlPlane: Object - Created control plane details including:
    - controlPlaneId: String - Unique identifier
    - name: String - Control plane name
    - description: String - Description
    - config: Object - Configuration settings including proxy URLs, auth type
    - status: String - Current status (active, inactive)
    - cloudGateway: Boolean - Cloud gateway availability
    - clusterType: String - Cluster type
    - labels: Object - Associated labels
    - metadata: Object - Creation timestamp and other metadata
  - credentials: Object - Initial connection credentials and certificates
  - message: String - Success message with setup instructions
  - relatedTools: Array - Next steps for configuration and node connection

SETUP WORKFLOW:
  1. Create control plane with desired configuration
  2. Generate data plane tokens for node authentication
  3. Configure services, routes, and plugins
  4. Connect data plane nodes using provided credentials
`;

export const updateControlPlanePrompt = () => `
Update an existing control plane's configuration.

INPUT:
  - controlPlaneId: String - Control Plane ID
  - name: String (optional) - New control plane name
  - description: String (optional) - New description
  - labels: Object (optional) - New labels (replaces existing labels)

OUTPUT:
  - success: Boolean - Whether update succeeded
  - controlPlane: Object - Updated control plane details
  - message: String - Success message
  - relatedTools: Array - Tools for further configuration

NOTE: Some configuration options (cluster type, auth type) cannot be changed after creation.
`;

export const deleteControlPlanePrompt = () => `
Delete a control plane and all its associated resources.

INPUT:
  - controlPlaneId: String - Control Plane ID

OUTPUT:
  - success: Boolean - Whether deletion succeeded
  - message: String - Confirmation message
  - warning: String - Important information about deleted resources
  - relatedTools: Array - Tools for creating new control planes

IMPORTANT: This operation permanently deletes:
  - All services, routes, consumers, and plugins
  - All data plane node connections
  - All configuration history and analytics data
  - Cannot be undone
`;

export const listDataPlaneNodesPrompt = () => `
List data plane nodes connected to a control plane.

INPUT:
  - controlPlaneId: String - Control Plane ID
  - pageSize: Number - Nodes per page (1-1000, default: 10)
  - pageNumber: Number (optional) - Page to retrieve
  - filterStatus: String (optional) - Filter by status: connected, disconnected, partially_connected
  - filterHostname: String (optional) - Filter by hostname (partial match)

OUTPUT:
  - metadata: Object - Control plane info and pagination details
  - nodes: Array - List of data plane nodes including:
    - nodeId: String - Unique node identifier
    - hostname: String - Node hostname
    - status: String - Connection status (connected, disconnected, partially_connected)
    - version: String - Kong version running on the node
    - lastSeen: String - Last ping timestamp
    - syncStatus: String - Configuration sync status
    - compatibility: String - Compatibility with control plane
    - labels: Object - Node labels and metadata
    - connections: Object - Connection details (IP, port, protocol)
    - health: Object - Health metrics and status
  - summary: Object - Overall cluster health statistics
  - relatedTools: Array - Tools for node management and troubleshooting

MONITORING USE CASES:
  - Monitor data plane cluster health
  - Identify disconnected or problematic nodes
  - Track configuration sync status across nodes
  - Investigate performance issues
`;

export const getDataPlaneNodePrompt = () => `
Get detailed information about a specific data plane node.

INPUT:
  - controlPlaneId: String - Control Plane ID
  - nodeId: String - Data plane node ID

OUTPUT:
  - node: Object - Complete node information including:
    - nodeId: String - Unique identifier
    - hostname: String - Node hostname
    - status: String - Current connection status
    - version: String - Kong version and build info
    - configuration: Object - Applied configuration details
    - performance: Object - Performance metrics and statistics
    - health: Object - Health checks and status
    - connections: Object - Network connection details
    - labels: Object - Node labels and tags
    - capabilities: Array - Supported features and plugins
    - lastSync: String - Last configuration sync timestamp
    - errors: Array - Recent errors or warnings
    - metadata: Object - Registration and update timestamps
  - relatedTools: Array - Tools for node management and configuration

TROUBLESHOOTING INSIGHTS:
  - Diagnose connection and sync issues
  - Monitor node performance and resource usage
  - Verify configuration consistency
  - Track error patterns and health trends
`;

export const createDataPlaneTokenPrompt = () => `
Create a new data plane token for node authentication.

INPUT:
  - controlPlaneId: String - Control Plane ID
  - name: String - Token name/description
  - expiresAt: String (optional) - Token expiration (ISO 8601 format)

OUTPUT:
  - success: Boolean - Whether creation succeeded
  - token: Object - Created token details including:
    - tokenId: String - Unique token identifier
    - name: String - Token name
    - token: String - Authentication token (shown once)
    - expiresAt: String - Expiration timestamp
    - createdAt: String - Creation timestamp
    - status: String - Token status
  - connectionInfo: Object - Data plane connection configuration
  - message: String - Success message
  - security: String - Important security notice about token storage
  - relatedTools: Array - Tools for token management

SECURITY CONSIDERATIONS:
  - Store token securely - it cannot be retrieved again
  - Use short-lived tokens for enhanced security
  - Rotate tokens regularly
  - Monitor token usage and revoke unused tokens
`;

export const revokeDataPlaneTokenPrompt = () => `
Revoke a data plane authentication token.

INPUT:
  - controlPlaneId: String - Control Plane ID  
  - tokenId: String - Token ID to revoke

OUTPUT:
  - success: Boolean - Whether revocation succeeded
  - message: String - Confirmation message
  - warning: String - Information about affected nodes
  - relatedTools: Array - Tools for creating new tokens

IMPACT: Nodes using this token will lose connection to the control plane.
`;

export const listDataPlaneTokensPrompt = () => `
List data plane authentication tokens for a control plane.

INPUT:
  - controlPlaneId: String - Control Plane ID
  - pageSize: Number - Tokens per page (1-1000, default: 10)
  - pageNumber: Number (optional) - Page to retrieve

OUTPUT:
  - metadata: Object - Control plane info and pagination
  - tokens: Array - List of tokens including:
    - tokenId: String - Unique identifier
    - name: String - Token name/description
    - status: String - Token status (active, expired, revoked)
    - createdAt: String - Creation timestamp
    - expiresAt: String - Expiration timestamp
    - lastUsed: String - Last usage timestamp
    - usageCount: Number - Number of times used
  - relatedTools: Array - Tools for token management

TOKEN MANAGEMENT:
  - Monitor token usage and expiration
  - Identify unused or expired tokens
  - Track token lifecycle for security auditing
  - Plan token rotation strategies
`;

export const getControlPlaneConfigPrompt = () => `
Get detailed configuration for a control plane.

INPUT:
  - controlPlaneId: String - Control Plane ID

OUTPUT:
  - config: Object - Complete control plane configuration including:
    - proxyUrl: String - Proxy endpoint URL
    - telemetryUrl: String - Telemetry/analytics endpoint
    - authType: String - Authentication method (pki, pinned_certs)
    - cloudGateway: Boolean - Cloud gateway status
    - analyticsEnabled: Boolean - Analytics collection status
    - certificates: Object - Authentication certificates
    - endpoints: Object - API and proxy endpoints
    - features: Array - Enabled features and capabilities
    - limits: Object - Resource limits and quotas
    - metadata: Object - Configuration version and timestamps
  - relatedTools: Array - Tools for configuration updates

CONFIGURATION INSIGHTS:
  - Review current control plane settings
  - Verify endpoint configurations
  - Check feature availability and limits
  - Audit security and authentication settings
`;

export const updateControlPlaneConfigPrompt = () => `
Update control plane configuration settings.

INPUT:
  - controlPlaneId: String - Control Plane ID
  - proxyUrl: String (optional) - New proxy URL
  - telemetryUrl: String (optional) - New telemetry endpoint
  - authType: String (optional) - Authentication type: pki, pinned_certs
  - cloudGateway: Boolean (optional) - Enable/disable cloud gateway
  - analyticsEnabled: Boolean (optional) - Enable/disable analytics

OUTPUT:
  - success: Boolean - Whether update succeeded
  - config: Object - Updated configuration
  - message: String - Success message
  - warnings: Array - Any warnings about the changes
  - relatedTools: Array - Tools for verification and monitoring

CONFIGURATION IMPACT:
  - Changes may affect data plane node connectivity
  - Some updates require node reconnection
  - Analytics changes affect data collection
  - Verify changes don't disrupt traffic flow
`;
