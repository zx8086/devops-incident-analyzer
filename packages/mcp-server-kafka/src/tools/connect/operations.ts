// src/tools/connect/operations.ts

import type { AppConfig } from "../../config/schemas.ts";
import type { ConnectService } from "../../services/connect-service.ts";
import { type HealthEnvelope, runHealthProbe } from "../shared/health-envelope.ts";

export async function getClusterInfo(service: ConnectService) {
	return service.getClusterInfo();
}

// SIO-742: probe Kafka Connect reachability via the cluster-info endpoint
// (GET /). Returns the version + cluster id as details on success.
export async function healthCheck(service: ConnectService, config: AppConfig): Promise<HealthEnvelope> {
	const endpoint = `${config.connect.url.replace(/\/$/, "")}/`;
	return runHealthProbe("Kafka Connect", endpoint, async () => {
		const info = await service.getClusterInfo();
		return { version: info.version, kafkaClusterId: info.kafka_cluster_id };
	});
}

export async function listConnectors(service: ConnectService) {
	return service.listConnectors();
}

export async function getConnectorStatus(service: ConnectService, params: { name: string }) {
	return service.getConnectorStatus(params.name);
}

export async function getConnectorTaskStatus(service: ConnectService, params: { name: string; taskId: number }) {
	return service.getConnectorTaskStatus(params.name, params.taskId);
}

export async function pauseConnector(service: ConnectService, args: { name: string }) {
	await service.pauseConnector(args.name);
	return { paused: args.name };
}

export async function resumeConnector(service: ConnectService, args: { name: string }) {
	await service.resumeConnector(args.name);
	return { resumed: args.name };
}

export async function restartConnector(
	service: ConnectService,
	args: { name: string; includeTasks?: boolean; onlyFailed?: boolean },
) {
	await service.restartConnector(args.name, {
		includeTasks: args.includeTasks,
		onlyFailed: args.onlyFailed,
	});
	return { restarted: args.name, includeTasks: args.includeTasks ?? false };
}

export async function restartConnectorTask(service: ConnectService, args: { name: string; taskId: number }) {
	await service.restartConnectorTask(args.name, args.taskId);
	return { restarted: args.name, taskId: args.taskId };
}

export async function deleteConnector(service: ConnectService, args: { name: string }) {
	await service.deleteConnector(args.name);
	return { deleted: args.name };
}
