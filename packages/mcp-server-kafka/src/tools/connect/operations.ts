// src/tools/connect/operations.ts

import type { ConnectService } from "../../services/connect-service.ts";

export async function getClusterInfo(service: ConnectService) {
	return service.getClusterInfo();
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
