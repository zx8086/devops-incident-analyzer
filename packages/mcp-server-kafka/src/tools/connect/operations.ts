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
