import type { KongApi } from "../api.js";

/**
 * List services for a specific control plane
 */
export async function listServices(api: KongApi, controlPlaneId: string, size = 100, offset?: string) {
	try {
		const result = await api.listServices(controlPlaneId, size, offset);

		// Transform the response to have consistent field names
		return {
			metadata: {
				controlPlaneId: controlPlaneId,
				size: size,
				offset: offset || null,
				nextOffset: result.offset,
				totalCount: result.total,
			},
			services: result.data.map((service: any) => ({
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
	} catch (error) {
		throw error;
	}
}

/**
 * List routes for a specific control plane
 */
export async function listRoutes(api: KongApi, controlPlaneId: string, size = 100, offset?: string) {
	try {
		const result = await api.listRoutes(controlPlaneId, size, offset);

		// Transform the response to have consistent field names
		return {
			metadata: {
				controlPlaneId: controlPlaneId,
				size: size,
				offset: offset || null,
				nextOffset: result.offset,
				totalCount: result.total,
			},
			routes: result.data.map((route: any) => ({
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
	} catch (error) {
		throw error;
	}
}

/**
 * List consumers for a specific control plane
 */
export async function listConsumers(api: KongApi, controlPlaneId: string, size = 100, offset?: string) {
	try {
		const result = await api.listConsumers(controlPlaneId, size, offset);

		// Transform the response to have consistent field names
		return {
			metadata: {
				controlPlaneId: controlPlaneId,
				size: size,
				offset: offset || null,
				nextOffset: result.offset,
				totalCount: result.total,
			},
			consumers: result.data.map((consumer: any) => ({
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
	} catch (error) {
		throw error;
	}
}

/**
 * List plugins for a specific control plane
 */
export async function listPlugins(api: KongApi, controlPlaneId: string, size = 100, offset?: string) {
	try {
		const result = await api.listPlugins(controlPlaneId, size, offset);

		// Transform the response to have consistent field names
		return {
			metadata: {
				controlPlaneId: controlPlaneId,
				size: size,
				offset: offset || null,
				nextOffset: result.offset,
				totalCount: result.total,
			},
			plugins: result.data.map((plugin: any) => ({
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
	} catch (error) {
		throw error;
	}
}

/**
 * Create a new service in a control plane
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
) {
	try {
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
	} catch (error) {
		throw error;
	}
}

/**
 * Get detailed information about a specific service
 */
export async function getService(api: KongApi, controlPlaneId: string, serviceId: string) {
	try {
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
	} catch (error) {
		throw error;
	}
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
	try {
		const requestData: any = {};

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
	} catch (error) {
		throw error;
	}
}

/**
 * Delete a service from a control plane
 */
export async function deleteService(api: KongApi, controlPlaneId: string, serviceId: string) {
	try {
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
	} catch (error) {
		throw error;
	}
}
