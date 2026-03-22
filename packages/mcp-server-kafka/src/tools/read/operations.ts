// src/tools/read/operations.ts

import type { AppConfig } from "../../config/schemas.ts";
import type { KafkaService } from "../../services/kafka-service.ts";

export async function listTopics(service: KafkaService, params: { filter?: string }) {
  return service.listTopics(params.filter);
}

export async function describeTopic(service: KafkaService, params: { topic: string }) {
  return service.describeTopic(params.topic);
}

export async function getTopicOffsets(
  service: KafkaService,
  params: { topic: string; timestamp?: number },
) {
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

export async function listConsumerGroups(
  service: KafkaService,
  params: { filter?: string; states?: string[] },
) {
  return service.listConsumerGroups(params.filter, params.states);
}

export async function describeConsumerGroup(service: KafkaService, params: { groupId: string }) {
  return service.describeConsumerGroup(params.groupId);
}

export async function getClusterInfo(service: KafkaService) {
  return service.getClusterInfo();
}
