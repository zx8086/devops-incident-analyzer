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
//
// SIO-1335: a batch that arrives non-empty but short of maxMessages because timeoutMs
// fired mid-scan is just as ambiguous as the empty case -- it reads identically to a
// scan that legitimately drained the whole window. Annotate that case too instead of
// returning a bare array, so a bounded scan (e.g. the SIO-1201 business-key lookup)
// can tell "confirmed not found in this window" apart from "cut short, unconfirmed".
// SIO-1363: fromBeginning takes precedence over timestamp when both are set,
// matching the service layer's precedence (kafka-service.ts consumeMessages).
function deriveConsumeMode(params: { fromBeginning?: boolean; timestamp?: number }): "earliest" | "latest" | "seek" {
	if (params.fromBeginning) return "earliest";
	if (params.timestamp !== undefined) return "seek";
	return "latest";
}

export async function consumeMessages(
	service: KafkaService,
	config: AppConfig,
	params: {
		topic: string;
		maxMessages?: number;
		timeoutMs?: number;
		fromBeginning?: boolean;
		timestamp?: number;
	},
) {
	const timeoutMs = params.timeoutMs ?? config.kafka.consumeTimeoutMs;
	const maxMessages = params.maxMessages ?? config.kafka.consumeMaxMessages;
	const { messages, timedOut } = await service.consumeMessages({
		topic: params.topic,
		maxMessages,
		timeoutMs,
		fromBeginning: params.fromBeginning,
		timestamp: params.timestamp,
	});
	const mode = deriveConsumeMode(params);

	if (messages.length === 0) {
		const note =
			mode === "latest"
				? `0 messages arrived within ${timeoutMs}ms. The ephemeral consumer starts at the LATEST offset, so existing backlog is invisible -- an empty result does NOT mean the topic is empty. To inspect backlog, retry with fromBeginning: true or read a specific offset with kafka_get_message_by_offset.`
				: mode === "seek"
					? `0 messages read from the timestamp-seeked offset (timestamp: ${params.timestamp}) within ${timeoutMs}ms. This means no message was found at or after that timestamp within the scan window -- a stronger negative than a fromBeginning/latest scan, but still bounded by maxMessages/timeoutMs, not exhaustive. Verify with kafka_get_topic_offsets({ topic, timestamp }) to confirm the seek landed where expected.`
					: `0 messages read from the beginning within ${timeoutMs}ms. The topic may be empty, or the fetch did not complete in time -- verify with kafka_describe_topic offsets before concluding the topic is empty.`;
		return {
			messages: [],
			consumed: 0,
			mode,
			timeoutMs,
			note,
		};
	}

	if (timedOut && messages.length < maxMessages) {
		return {
			messages,
			consumed: messages.length,
			mode,
			timeoutMs,
			note: `Scan stopped after ${timeoutMs}ms with ${messages.length}/${maxMessages} messages read -- this is a partial (timeout-truncated) result, not a completed scan of the requested window. Do not conclude a business key or pattern is absent from the topic based on this batch alone; retry with a larger timeoutMs or narrow the scan.`,
		};
	}

	return messages;
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
