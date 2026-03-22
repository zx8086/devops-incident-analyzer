// src/tools/read/operations-extended.ts

import type { KafkaService } from "../../services/kafka-service.ts";

export async function getConsumerGroupLag(service: KafkaService, params: { groupId: string }) {
	return service.getConsumerGroupLag(params.groupId);
}

export async function describeCluster(service: KafkaService) {
	return service.describeCluster();
}

export async function getMessageByOffset(
	service: KafkaService,
	params: { topic: string; partition: number; offset: number },
) {
	return service.getMessageByOffset(params.topic, params.partition, params.offset);
}
