// src/tools/read/operations.ts

import type { AppConfig } from "../../config/schemas.ts";
import type { KafkaService } from "../../services/kafka-service.ts";

export async function listTopics(
	service: KafkaService,
	params: { filter?: string; prefix?: string; limit?: number; offset?: number },
) {
	return service.listTopicsPaged({
		filter: params.filter,
		prefix: params.prefix,
		limit: params.limit ?? 100,
		offset: params.offset ?? 0,
	});
}

export async function describeTopic(service: KafkaService, params: { topic: string }) {
	return service.describeTopic(params.topic);
}

export async function getTopicOffsets(service: KafkaService, params: { topic: string; timestamp?: number }) {
	return service.getTopicOffsets(params.topic, params.timestamp);
}

export async function consumeMessages(
	service: KafkaService,
	config: AppConfig,
	params: {
		topic: string;
		maxMessages?: number;
		timeoutMs?: number;
		fromBeginning?: boolean;
	},
) {
	return service.consumeMessages({
		topic: params.topic,
		maxMessages: params.maxMessages ?? config.kafka.consumeMaxMessages,
		timeoutMs: params.timeoutMs ?? config.kafka.consumeTimeoutMs,
		fromBeginning: params.fromBeginning,
	});
}

export async function listConsumerGroups(service: KafkaService, params: { filter?: string; states?: string[] }) {
	return service.listConsumerGroups(params.filter, params.states);
}

export async function listDlqTopics(service: KafkaService, params: { windowMs?: number; skipDelta?: boolean }) {
	return service.listDlqTopics({ windowMs: params.windowMs, skipDelta: params.skipDelta });
}

export async function describeConsumerGroup(service: KafkaService, params: { groupId: string }) {
	return service.describeConsumerGroup(params.groupId);
}

export async function getClusterInfo(
	service: KafkaService,
	params: { prefix?: string; limit?: number; offset?: number },
) {
	return service.getClusterInfo({
		prefix: params.prefix,
		limit: params.limit ?? 100,
		offset: params.offset ?? 0,
	});
}
