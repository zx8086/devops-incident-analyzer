// src/tools/write/operations.ts
import type { KafkaService } from "../../services/kafka-service.ts";

export async function produceMessage(
  service: KafkaService,
  params: {
    topic: string;
    messages: Array<{
      key?: string;
      value: string;
      headers?: Record<string, string>;
      partition?: number;
    }>;
    acks?: number;
  },
) {
  return service.produceMessage(params.topic, params.messages, params.acks);
}

export async function createTopic(
  service: KafkaService,
  params: {
    name: string;
    partitions?: number;
    replicas?: number;
    configs?: Record<string, string>;
  },
) {
  return service.createTopic(params);
}

export async function alterTopicConfig(
  service: KafkaService,
  params: { topic: string; configs: Record<string, string> },
) {
  return service.alterTopicConfig(params.topic, params.configs);
}
