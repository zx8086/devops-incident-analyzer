// src/tools/read/operations.ts

import { buildToolErrorEnvelope, type ToolErrorEnvelope } from "@devops-agent/shared";
import type { AppConfig } from "../../config/schemas.ts";
import { InvalidFilterError } from "../../lib/filter.ts";
import type { KafkaService } from "../../services/kafka-service.ts";

// SIO-1105: a caller-supplied `filter` is a documented regex, but LLM callers often pass a raw
// name fragment carrying regex metacharacters (e.g. "foo(?bar"). Rather than let the invalid
// pattern surface as a raw -32603, translate the typed InvalidFilterError into the SIO-1087
// structured envelope. `not-found` is the non-degrading kind (category "not-found") whose semantics
// -- "nothing matched" -- fit a malformed filter that can select no topics/groups, so
// isDegradingCategory() keeps it out of the degraded-subagent confidence cap. Returned on a
// status:"success" result so the agent reads it structurally, never as -32603.
function invalidFilterEnvelope(err: InvalidFilterError, resource: "topics" | "consumer groups"): ToolErrorEnvelope {
	return buildToolErrorEnvelope({
		kind: "not-found",
		message: `No ${resource} matched: the 'filter' is not a valid regular expression (${err.reason}).`,
		advice: `The 'filter' argument is a regex. ${JSON.stringify(err.filter)} is invalid. Use 'prefix' for a literal name prefix, or escape regex metacharacters (( ) ? [ ] \\ etc.) in 'filter'.`,
	});
}

export async function listTopics(
	service: KafkaService,
	params: { filter?: string; prefix?: string; limit?: number; offset?: number },
): Promise<Awaited<ReturnType<KafkaService["listTopicsPaged"]>> | ToolErrorEnvelope> {
	try {
		return await service.listTopicsPaged({
			filter: params.filter,
			prefix: params.prefix,
			limit: params.limit ?? 100,
			offset: params.offset ?? 0,
		});
	} catch (error) {
		if (error instanceof InvalidFilterError) return invalidFilterEnvelope(error, "topics");
		throw error;
	}
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

export async function listConsumerGroups(
	service: KafkaService,
	params: { filter?: string; states?: string[] },
): Promise<Awaited<ReturnType<KafkaService["listConsumerGroups"]>> | ToolErrorEnvelope> {
	try {
		return await service.listConsumerGroups(params.filter, params.states);
	} catch (error) {
		if (error instanceof InvalidFilterError) return invalidFilterEnvelope(error, "consumer groups");
		throw error;
	}
}

export async function listDlqTopics(
	service: KafkaService,
	params: { windowMs?: number; skipDelta?: boolean; filter?: string },
) {
	return service.listDlqTopics({ windowMs: params.windowMs, skipDelta: params.skipDelta, filter: params.filter });
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
