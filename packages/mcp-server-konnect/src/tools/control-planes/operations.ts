// src/tools/control-planes/operations.ts
import type { KongApi } from "../../api/kong-api.js";
import { withErrorContext } from "../../utils/error-handling.js";
import { createContextLogger } from "../../utils/logger.js";

const log = createContextLogger("tools");

/**
 * List all control planes in the organization
 */
export async function listControlPlanes(
	api: KongApi,
	pageSize = 10,
	pageNumber?: number,
	filterName?: string,
	filterClusterType?: string,
	filterCloudGateway?: boolean,
	labels?: string,
	sort?: string,
) {
	log.debug({ pageSize, filterName: filterName || null }, "Listing control planes");
	return withErrorContext(
		"list_control_planes",
		"control-planes",
	)(async () => {
		const result = await api.listControlPlanes(
			pageSize,
			pageNumber,
			filterName,
			filterClusterType,
			filterCloudGateway,
			labels,
			sort,
		);

		// Transform the response to have consistent field names
		return {
			metadata: {
				pageSize: pageSize,
				pageNumber: pageNumber || 1,
				totalPages: result.meta.page_count,
				totalCount: result.meta.total_count,
				filters: {
					name: filterName || null,
					clusterType: filterClusterType || null,
					cloudGateway: filterCloudGateway !== undefined ? filterCloudGateway : null,
					labels: labels || null,
				},
				sort: sort || null,
			},
			controlPlanes: result.data.map((cp: any) => ({
				controlPlaneId: cp.id,
				name: cp.name,
				description: cp.description,
				type: cp.type,
				clusterType: cp.cluster_type,
				controlPlaneEndpoint: cp.control_plane_endpoint,
				telemetryEndpoint: cp.telemetry_endpoint,
				hasCloudGateway: cp.has_cloud_gateway,
				labels: cp.labels,
				metadata: {
					createdAt: cp.created_at,
					updatedAt: cp.updated_at,
				},
			})),
			usage: {
				instructions:
					"Use the controlPlaneId from these results with other tools like list-services, list-data-plane-nodes, etc.",
				pagination: "For more results, increment pageNumber or increase pageSize",
			},
		};
	});
}

/**
 * Get detailed information about a specific control plane
 */
export async function getControlPlane(api: KongApi, controlPlaneId: string) {
	log.debug({ controlPlaneId }, "Getting control plane");
	return withErrorContext(
		"get_control_plane",
		"control-plane",
		controlPlaneId,
	)(async () => {
		const result = await api.getControlPlane(controlPlaneId);

		// For single entity endpoints, the result IS the control plane object directly
		// (not wrapped in a 'data' property like list endpoints)
		const cp = result;
		return {
			controlPlaneDetails: {
				controlPlaneId: cp.id,
				name: cp.name,
				description: cp.description,
				type: cp.type,
				clusterType: cp.cluster_type,
				controlPlaneEndpoint: cp.control_plane_endpoint,
				telemetryEndpoint: cp.telemetry_endpoint,
				hasCloudGateway: cp.has_cloud_gateway,
				labels: cp.labels,
				metadata: {
					createdAt: cp.created_at,
					updatedAt: cp.updated_at,
				},
			},
			relatedTools: [
				"Use list-services to see services configured in this control plane",
				"Use list-routes to see routes configured in this control plane",
				"Use list-certificates to see certificates in this control plane",
				"Use list-upstreams to see upstreams configured in this control plane",
				"Use list-data-plane-nodes to see data plane nodes connected to this control plane",
				"Use query-api-requests to analyze traffic for this control plane",
			],
		};
	});
}

/**
 * List all control planes that are members of a specific group
 */
export async function listControlPlaneGroupMemberships(
	api: KongApi,
	groupId: string,
	pageSize = 10,
	pageAfter?: string,
) {
	log.debug({ groupId, pageSize }, "Listing control plane group memberships");
	return withErrorContext(
		"list_control_plane_group_memberships",
		"control-plane-group",
		groupId,
	)(async () => {
		const result = await api.listControlPlaneGroupMemberships(groupId, pageSize, pageAfter);

		// Transform the response to have consistent field names
		return {
			metadata: {
				groupId: groupId,
				pageSize: pageSize,
				pageAfter: pageAfter || null,
				nextPageAfter: result.meta?.next_page?.after || null,
				totalCount: result.meta?.total_count || 0,
			},
			members: result.data.map((member: any) => ({
				controlPlaneId: member.id,
				name: member.name,
				description: member.description,
				type: member.type,
				clusterType: member.cluster_type,
				membershipStatus: {
					status: member.cp_group_member_status?.status,
					message: member.cp_group_member_status?.message,
					conflicts: member.cp_group_member_status?.conflicts || [],
				},
				metadata: {
					createdAt: member.created_at,
					updatedAt: member.updated_at,
				},
			})),
			relatedTools: [
				"Use get-control-plane-group-status to check for configuration conflicts",
				"Use check-control-plane-group-membership to verify if a specific control plane is a member",
				"Use get-control-plane to get more details about a specific member",
			],
		};
	});
}

/**
 * Check if a control plane is a member of any group
 */
export async function checkControlPlaneGroupMembership(api: KongApi, controlPlaneId: string) {
	log.debug({ controlPlaneId }, "Checking control plane group membership");
	return withErrorContext(
		"check_control_plane_group_membership",
		"control-plane",
		controlPlaneId,
	)(async () => {
		const result = await api.checkControlPlaneGroupMembership(controlPlaneId);

		// For single entity endpoints, the result IS the membership object directly
		const membership = result;
		return {
			controlPlaneId: controlPlaneId,
			groupMembership: {
				isMember: membership.is_member,
				groupId: membership.group_id,
				groupName: membership.group_name,
				status: membership.status,
				message: membership.message,
				conflicts: membership.conflicts || [],
			},
			relatedTools: [
				"Use list-control-plane-group-memberships to see all members of this group",
				"Use get-control-plane to get more details about this control plane",
			],
		};
	});
}

/**
 * Create a new control plane
 */
export async function createControlPlane(
	api: KongApi,
	controlPlaneData: {
		name: string;
		description?: string;
		clusterType?: string;
		cloudGateway?: boolean;
		authType?: string;
		proxyUrls?: string[];
		labels?: Record<string, string>;
	},
) {
	log.debug({ name: controlPlaneData.name }, "Creating control plane");
	return withErrorContext(
		"create_control_plane",
		"control-plane",
	)(async () => {
		const requestData = {
			name: controlPlaneData.name,
			description: controlPlaneData.description,
			cluster_type: controlPlaneData.clusterType || "CLUSTER_TYPE_HYBRID",
			cloud_gateway: controlPlaneData.cloudGateway || false,
			auth_type: controlPlaneData.authType || "pinned_certs",
			proxy_urls: controlPlaneData.proxyUrls,
			labels: controlPlaneData.labels,
		};

		const result = await api.createControlPlane(requestData);

		return {
			success: true,
			controlPlane: {
				controlPlaneId: result.id,
				name: result.name,
				description: result.description,
				config: {
					clusterType: result.cluster_type,
					cloudGateway: result.cloud_gateway,
					authType: result.auth_type,
					proxyUrls: result.proxy_urls,
				},
				status: result.status,
				labels: result.labels || {},
				metadata: {
					createdAt: result.created_at,
					updatedAt: result.updated_at,
				},
			},
			credentials: result.credentials || {},
			message: `Control plane '${result.name}' created successfully with ID: ${result.id}`,
			relatedTools: [
				"Use create-data-plane-token to generate authentication tokens",
				"Use create-service to start configuring your gateway",
				"Use list-data-plane-nodes to monitor node connections",
			],
		};
	});
}

/**
 * Update an existing control plane
 */
export async function updateControlPlane(
	api: KongApi,
	controlPlaneId: string,
	controlPlaneData: {
		name?: string;
		description?: string;
		labels?: Record<string, string>;
	},
) {
	log.debug({ controlPlaneId }, "Updating control plane");
	return withErrorContext(
		"update_control_plane",
		"control-plane",
		controlPlaneId,
	)(async () => {
		const requestData: any = {};

		if (controlPlaneData.name !== undefined) requestData.name = controlPlaneData.name;
		if (controlPlaneData.description !== undefined) requestData.description = controlPlaneData.description;
		if (controlPlaneData.labels !== undefined) requestData.labels = controlPlaneData.labels;

		const result = await api.updateControlPlane(controlPlaneId, requestData);

		return {
			success: true,
			controlPlane: {
				controlPlaneId: result.id,
				name: result.name,
				description: result.description,
				status: result.status,
				labels: result.labels || {},
				metadata: {
					createdAt: result.created_at,
					updatedAt: result.updated_at,
				},
			},
			message: `Control plane '${result.name}' updated successfully`,
			relatedTools: [
				"Use get-control-plane to see all updated details",
				"Use list-control-planes to see the updated control plane in the list",
			],
		};
	});
}

/**
 * Delete a control plane
 */
export async function deleteControlPlane(api: KongApi, controlPlaneId: string) {
	log.debug({ controlPlaneId }, "Deleting control plane");
	return withErrorContext(
		"delete_control_plane",
		"control-plane",
		controlPlaneId,
	)(async () => {
		await api.deleteControlPlane(controlPlaneId);

		return {
			success: true,
			message: `Control plane ${controlPlaneId} deleted successfully`,
			warning: "All services, routes, consumers, plugins, and data plane connections have been permanently removed",
			relatedTools: [
				"Use list-control-planes to see remaining control planes",
				"Use create-control-plane to create a new control plane",
			],
		};
	});
}

/**
 * List data plane nodes for a control plane
 */
export async function listDataPlaneNodes(
	api: KongApi,
	controlPlaneId: string,
	pageSize = 10,
	pageNumber?: number,
	filterStatus?: string,
	filterHostname?: string,
) {
	log.debug({ controlPlaneId, pageSize }, "Listing data plane nodes");
	return withErrorContext(
		"list_data_plane_nodes",
		"control-plane",
		controlPlaneId,
	)(async () => {
		const result = await api.listDataPlaneNodes(controlPlaneId, pageSize, pageNumber, filterStatus, filterHostname);

		return {
			metadata: {
				controlPlaneId: controlPlaneId,
				pagination: {
					pageSize: pageSize,
					pageNumber: pageNumber || 1,
					totalPages: Math.ceil((result.page?.total_count || result.meta?.page?.total_count || 0) / pageSize),
					totalItems: result.page?.total_count || result.meta?.page?.total_count || 0,
				},
				filters: {
					status: filterStatus,
					hostname: filterHostname,
				},
			},
			nodes:
				(result.items || result.data)?.map((node: any) => ({
					nodeId: node.id,
					hostname: node.hostname,
					status: node.connection_state?.is_connected ? "connected" : "disconnected",
					version: node.version,
					lastSeen: node.last_ping || node.last_seen,
					syncStatus: node.sync_status || "synced",
					compatibility: node.compatibility_status?.state || node.compatibility,
					labels: node.labels || {},
					connections: {
						ip: node.ip,
						port: node.port,
						protocol: node.protocol,
					},
					health: {
						status: node.connection_state?.is_connected ? "healthy" : "unhealthy",
						checks: node.health_checks || [],
					},
				})) || [],
			summary: {
				totalNodes: result.page?.total_count || result.meta?.page?.total_count || 0,
				connectedNodes:
					(result.items || result.data)?.filter(
						(n: any) => n.connection_state?.is_connected || n.status === "connected",
					).length || 0,
				disconnectedNodes:
					(result.items || result.data)?.filter(
						(n: any) => !n.connection_state?.is_connected && n.status !== "connected",
					).length || 0,
				overallHealth: result.summary?.health_status || "healthy",
			},
			relatedTools: [
				"Use get-data-plane-node for detailed node information",
				"Use create-data-plane-token to generate authentication tokens",
				"Use list-control-planes to see control plane status",
			],
		};
	});
}

/**
 * Get detailed information about a data plane node
 */
export async function getDataPlaneNode(api: KongApi, controlPlaneId: string, nodeId: string) {
	log.debug({ controlPlaneId, nodeId }, "Getting data plane node");
	return withErrorContext(
		"get_data_plane_node",
		"data-plane-node",
		nodeId,
	)(async () => {
		const result = await api.getDataPlaneNode(controlPlaneId, nodeId);

		return {
			node: {
				nodeId: result.id,
				hostname: result.hostname,
				status: result.status,
				version: result.version,
				configuration: {
					syncedAt: result.config_synced_at,
					version: result.config_version,
					hash: result.config_hash,
				},
				performance: {
					cpuUsage: result.cpu_usage,
					memoryUsage: result.memory_usage,
					requestsPerSecond: result.rps,
				},
				health: {
					status: result.health_status,
					checks: result.health_checks || [],
					lastCheck: result.last_health_check,
				},
				connections: {
					ip: result.ip,
					port: result.port,
					protocol: result.protocol,
					tlsEnabled: result.tls_enabled,
				},
				labels: result.labels || {},
				capabilities: result.capabilities || [],
				lastSync: result.last_sync,
				errors: result.recent_errors || [],
				metadata: {
					registeredAt: result.registered_at,
					updatedAt: result.updated_at,
				},
			},
			relatedTools: [
				"Use list-data-plane-nodes to see other nodes in this control plane",
				"Use get-control-plane-config to check control plane configuration",
			],
		};
	});
}

/**
 * Create a data plane authentication token
 */
export async function createDataPlaneToken(api: KongApi, controlPlaneId: string, name: string, expiresAt?: string) {
	log.debug({ controlPlaneId, name }, "Creating data plane token");
	return withErrorContext(
		"create_data_plane_token",
		"control-plane",
		controlPlaneId,
	)(async () => {
		const requestData = {
			name: name,
			expires_at: expiresAt,
		};

		const result = await api.createDataPlaneToken(controlPlaneId, requestData);

		return {
			success: true,
			token: {
				tokenId: result.id,
				name: result.name,
				token: result.token,
				expiresAt: result.expires_at,
				createdAt: result.created_at,
				status: result.status,
			},
			connectionInfo: {
				controlPlaneEndpoint: result.control_plane_endpoint,
				telemetryEndpoint: result.telemetry_endpoint,
				configHash: result.config_hash,
			},
			message: `Data plane token '${result.name}' created successfully`,
			security: "WARNING: Store the token securely - it cannot be retrieved again",
			relatedTools: [
				"Use list-data-plane-tokens to see all tokens",
				"Use list-data-plane-nodes to monitor node connections",
			],
		};
	});
}

/**
 * List data plane tokens for a control plane
 */
export async function listDataPlaneTokens(api: KongApi, controlPlaneId: string, pageSize = 10, pageNumber?: number) {
	log.debug({ controlPlaneId, pageSize }, "Listing data plane tokens");
	return withErrorContext(
		"list_data_plane_tokens",
		"control-plane",
		controlPlaneId,
	)(async () => {
		const result = await api.listDataPlaneTokens(controlPlaneId, pageSize, pageNumber);

		return {
			metadata: {
				controlPlaneId: controlPlaneId,
				pagination: {
					pageSize: pageSize,
					pageNumber: pageNumber || 1,
					totalPages: result.meta?.page?.total || 1,
					totalItems: result.meta?.page?.total_count || 0,
				},
			},
			tokens:
				result.data?.map((token: any) => ({
					tokenId: token.id,
					name: token.name,
					status: token.status,
					createdAt: token.created_at,
					expiresAt: token.expires_at,
					lastUsed: token.last_used,
					usageCount: token.usage_count || 0,
				})) || [],
			relatedTools: [
				"Use create-data-plane-token to generate new tokens",
				"Use revoke-data-plane-token to revoke tokens",
				"Use list-data-plane-nodes to see which tokens are in use",
			],
		};
	});
}

/**
 * Revoke a data plane token
 */
export async function revokeDataPlaneToken(api: KongApi, controlPlaneId: string, tokenId: string) {
	log.debug({ controlPlaneId, tokenId }, "Revoking data plane token");
	return withErrorContext(
		"revoke_data_plane_token",
		"data-plane-token",
		tokenId,
	)(async () => {
		await api.revokeDataPlaneToken(controlPlaneId, tokenId);

		return {
			success: true,
			message: `Data plane token ${tokenId} revoked successfully`,
			warning: "Nodes using this token will lose connection to the control plane",
			relatedTools: [
				"Use list-data-plane-tokens to see remaining tokens",
				"Use create-data-plane-token to create replacement tokens",
				"Use list-data-plane-nodes to check node connection status",
			],
		};
	});
}

/**
 * Get control plane configuration
 */
export async function getControlPlaneConfig(api: KongApi, controlPlaneId: string) {
	log.debug({ controlPlaneId }, "Getting control plane config");
	return withErrorContext(
		"get_control_plane_config",
		"control-plane",
		controlPlaneId,
	)(async () => {
		const result = await api.getControlPlaneConfig(controlPlaneId);

		return {
			config: {
				proxyUrl: result.proxy_url,
				telemetryUrl: result.telemetry_url,
				authType: result.auth_type,
				cloudGateway: result.cloud_gateway,
				analyticsEnabled: result.analytics_enabled,
				certificates: result.certificates || {},
				endpoints: {
					proxy: result.proxy_endpoint,
					admin: result.admin_endpoint,
					telemetry: result.telemetry_endpoint,
				},
				features: result.enabled_features || [],
				limits: result.limits || {},
				metadata: {
					version: result.config_version,
					updatedAt: result.updated_at,
				},
			},
			relatedTools: [
				"Use update-control-plane-config to modify settings",
				"Use list-data-plane-nodes to see how changes affect nodes",
			],
		};
	});
}

/**
 * Update control plane configuration
 */
export async function updateControlPlaneConfig(
	api: KongApi,
	controlPlaneId: string,
	configData: {
		proxyUrl?: string;
		telemetryUrl?: string;
		authType?: string;
		cloudGateway?: boolean;
		analyticsEnabled?: boolean;
	},
) {
	log.debug({ controlPlaneId }, "Updating control plane config");
	return withErrorContext(
		"update_control_plane_config",
		"control-plane",
		controlPlaneId,
	)(async () => {
		const requestData: any = {};

		if (configData.proxyUrl !== undefined) requestData.proxy_url = configData.proxyUrl;
		if (configData.telemetryUrl !== undefined) requestData.telemetry_url = configData.telemetryUrl;
		if (configData.authType !== undefined) requestData.auth_type = configData.authType;
		if (configData.cloudGateway !== undefined) requestData.cloud_gateway = configData.cloudGateway;
		if (configData.analyticsEnabled !== undefined) requestData.analytics_enabled = configData.analyticsEnabled;

		const result = await api.updateControlPlaneConfig(controlPlaneId, requestData);

		return {
			success: true,
			config: {
				proxyUrl: result.proxy_url,
				telemetryUrl: result.telemetry_url,
				authType: result.auth_type,
				cloudGateway: result.cloud_gateway,
				analyticsEnabled: result.analytics_enabled,
				version: result.config_version,
				updatedAt: result.updated_at,
			},
			message: "Control plane configuration updated successfully",
			warnings: result.warnings || [],
			relatedTools: [
				"Use get-control-plane-config to see all updated settings",
				"Use list-data-plane-nodes to monitor node reconnections",
			],
		};
	});
}
