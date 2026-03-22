// src/tools/destructive/operations.ts
import type { KafkaService } from "../../services/kafka-service.ts";

export async function deleteTopic(service: KafkaService, params: { topic: string }) {
	return service.deleteTopic(params.topic);
}

export async function resetConsumerGroupOffsets(
	service: KafkaService,
	params: {
		groupId: string;
		topic: string;
		strategy: "earliest" | "latest" | "timestamp";
		timestamp?: number;
	},
) {
	return service.resetConsumerGroupOffsets(params);
}
