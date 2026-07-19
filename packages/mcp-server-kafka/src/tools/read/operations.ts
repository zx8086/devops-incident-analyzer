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

// SIO-1159: an empty consume result is returned as an annotated object, not a bare [].
// Run 270378e0 read a bare [] from a 1M-message topic and (wrongly) concluded the
// serialization format was unreadable -- the real cause was the default "latest" start
// offset, which makes historical backlog invisible. The note names the actual cause
// and the recovery path so the LLM does not have to guess.
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
	const timeoutMs = params.timeoutMs ?? config.kafka.consumeTimeoutMs;
	const messages = await service.consumeMessages({
		topic: params.topic,
		maxMessages: params.maxMessages ?? config.kafka.consumeMaxMessages,
		timeoutMs,
		fromBeginning: params.fromBeginning,
	});
	if (messages.length > 0) return messages;
	const mode = params.fromBeginning ? "earliest" : "latest";
	return {
		messages: [],
		consumed: 0,
		mode,
		timeoutMs,
		note:
			mode === "latest"
				? `0 messages arrived within ${timeoutMs}ms. The ephemeral consumer starts at the LATEST offset, so existing backlog is invisible -- an empty result does NOT mean the topic is empty. To inspect backlog, retry with fromBeginning: true or read a specific offset with kafka_get_message_by_offset.`
				: `0 messages read from the beginning within ${timeoutMs}ms. The topic may be empty, or the fetch did not complete in time -- verify with kafka_describe_topic offsets before concluding the topic is empty.`,
	};
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
