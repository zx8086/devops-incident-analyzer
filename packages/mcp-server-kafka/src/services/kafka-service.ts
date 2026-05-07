// src/services/kafka-service.ts

import type { Admin, Message } from "@platformatic/kafka";
import {
	type ConfigDescription,
	ConfigResourceTypes,
	type ListedOffsetsTopic,
	ListOffsetTimestamps,
	MultipleErrors,
} from "@platformatic/kafka";
import type { DlqTopic } from "../config/schemas.ts";
import { logger } from "../utils/logger.ts";
import type { KafkaClientManager } from "./client-manager.ts";

// Kafka protocol error codes most likely to surface from a Fetch RPC
// (KIP-580 / kafka-clients). Used to classify ResponseError children
// instead of letting MCP return a generic -32603 with the raw library
// string "API Fetch(v16) error".
const KAFKA_ERROR_NAMES: Record<number, string> = {
	1: "OFFSET_OUT_OF_RANGE",
	3: "UNKNOWN_TOPIC_OR_PARTITION",
	5: "LEADER_NOT_AVAILABLE",
	6: "NOT_LEADER_OR_FOLLOWER",
	7: "REQUEST_TIMED_OUT",
	9: "REPLICA_NOT_AVAILABLE",
	13: "NETWORK_EXCEPTION",
	16: "NOT_COORDINATOR",
	17: "INVALID_TOPIC_EXCEPTION",
	29: "TOPIC_AUTHORIZATION_FAILED",
	30: "GROUP_AUTHORIZATION_FAILED",
	31: "CLUSTER_AUTHORIZATION_FAILED",
	35: "UNSUPPORTED_VERSION",
	74: "FENCED_LEADER_EPOCH",
	75: "UNKNOWN_LEADER_EPOCH",
	100: "UNKNOWN_TOPIC_ID",
};

interface ClassifiedKafkaError {
	kafkaErrorCode: number | null;
	kafkaErrorName: string | null;
	message: string;
}

function classifyKafkaError(err: unknown): ClassifiedKafkaError {
	const message = err instanceof Error ? err.message : String(err);
	if (!(err instanceof MultipleErrors)) {
		return { kafkaErrorCode: null, kafkaErrorName: null, message };
	}
	for (const child of err.errors) {
		const code = (child as { errorCode?: number }).errorCode;
		if (typeof code === "number" && code !== 0) {
			return {
				kafkaErrorCode: code,
				kafkaErrorName: KAFKA_ERROR_NAMES[code] ?? null,
				message,
			};
		}
	}
	return { kafkaErrorCode: null, kafkaErrorName: null, message };
}

async function getPartitionOffsetBounds(
	admin: Admin,
	topic: string,
	partition: number,
): Promise<{ earliest: bigint; latest: bigint } | null> {
	const result = (await admin.listOffsets({
		topics: [
			{
				name: topic,
				partitions: [
					{ partitionIndex: partition, timestamp: ListOffsetTimestamps.EARLIEST },
					{ partitionIndex: partition, timestamp: ListOffsetTimestamps.LATEST },
				],
			},
		],
	})) as unknown as Array<{
		name: string;
		partitions: Array<{ partitionIndex: number; timestamp: bigint; offset: bigint }>;
	}>;
	const topicResult = result.find((t) => t.name === topic);
	if (!topicResult) return null;
	const earliestPart = topicResult.partitions.find((p) => p.timestamp === ListOffsetTimestamps.EARLIEST);
	const latestPart = topicResult.partitions.find((p) => p.timestamp === ListOffsetTimestamps.LATEST);
	if (!earliestPart || !latestPart) return null;
	return { earliest: earliestPart.offset, latest: latestPart.offset };
}

// @platformatic/kafka doesn't support partitionIndex=-1 (all partitions) in listOffsets.
async function getPartitionIndices(admin: Admin, topicName: string): Promise<number[]> {
	const metadata = await new Promise<{
		topics: Map<string, { partitions: Record<number, unknown> }>;
	}>((resolve, reject) => {
		(
			admin as unknown as {
				metadata: (opts: { topics: string[] }, cb: (err: Error | null, data: unknown) => void) => void;
			}
		).metadata({ topics: [topicName] }, (err, data) =>
			err ? reject(err) : resolve(data as { topics: Map<string, { partitions: Record<number, unknown> }> }),
		);
	});
	const topicMeta = metadata.topics.get(topicName);
	if (!topicMeta) return [0];
	return Object.keys(topicMeta.partitions).map(Number);
}

async function getClusterMetadata(admin: Admin): Promise<{
	brokers: Map<number, { host: string; port: number; rack?: string }>;
	controllerId: number;
	topics: Map<string, { partitions: Record<number, unknown> }>;
}> {
	return new Promise((resolve, reject) => {
		(
			admin as unknown as {
				metadata: (opts: { topics?: string[] }, cb: (err: Error | null, data: unknown) => void) => void;
			}
		).metadata({}, (err, data) =>
			err
				? reject(err)
				: resolve(
						data as {
							brokers: Map<number, { host: string; port: number; rack?: string }>;
							controllerId: number;
							topics: Map<string, { partitions: Record<number, unknown> }>;
						},
					),
		);
	});
}

const DLQ_PATTERNS = [/-dlq$/, /^dlt-/, /-dead-letter$/, /^dead-letter-/, /\.DLQ$/];

// Number of DLQ topics sampled concurrently per batch to avoid overloading brokers.
const DLQ_PARALLEL_BATCH_SIZE = 20;

export interface ListDlqTopicsOptions {
	skipDelta?: boolean;
	windowMs?: number;
}

export interface ConsumeMessagesOptions {
	topic: string;
	maxMessages: number;
	timeoutMs: number;
	fromBeginning?: boolean;
}

export interface ProduceMessageInput {
	key?: string;
	value: string;
	headers?: Record<string, string>;
	partition?: number;
}

export interface CreateTopicInput {
	name: string;
	partitions?: number;
	replicas?: number;
	configs?: Record<string, string>;
}

export interface ResetOffsetsInput {
	groupId: string;
	topic: string;
	strategy: "earliest" | "latest" | "timestamp";
	timestamp?: number;
}

export interface FormattedMessage {
	topic: string;
	partition: number;
	offset: string;
	key: string | null;
	value: string | null;
	timestamp: string;
	headers: Record<string, string>;
}

export type GetMessageByOffsetResult =
	| { status: "ok"; message: FormattedMessage }
	| {
			status: "out_of_range";
			topic: string;
			partition: number;
			requestedOffset: string;
			earliestOffset: string;
			latestOffset: string;
			message: string;
	  }
	| {
			status: "error";
			code: "PARTITION_NOT_FOUND" | "TIMEOUT" | "BROKER_ERROR";
			kafkaErrorCode?: number | null;
			kafkaErrorName?: string | null;
			message: string;
	  };

async function sampleOneDlqTopic(clientManager: KafkaClientManager, name: string): Promise<number> {
	return clientManager.withAdmin(async (admin) => {
		const partitions = await getPartitionIndices(admin, name);
		let total = 0;
		for (const partition of partitions) {
			const bounds = await getPartitionOffsetBounds(admin, name, partition);
			if (bounds) {
				total += Number(bounds.latest - bounds.earliest);
			}
		}
		return total;
	});
}

async function sampleDlqOffsets(clientManager: KafkaClientManager, names: string[]): Promise<Map<string, number>> {
	const result = new Map<string, number>();

	for (let i = 0; i < names.length; i += DLQ_PARALLEL_BATCH_SIZE) {
		const batch = names.slice(i, i + DLQ_PARALLEL_BATCH_SIZE);
		const settled = await Promise.allSettled(batch.map((name) => sampleOneDlqTopic(clientManager, name)));
		for (let j = 0; j < batch.length; j++) {
			const outcome = settled[j];
			if (outcome?.status === "fulfilled") {
				result.set(batch[j] as string, outcome.value);
			}
			// Rejected outcomes are intentionally omitted so the caller can detect null delta.
		}
	}

	return result;
}

export class KafkaService {
	constructor(private readonly clientManager: KafkaClientManager) {}

	async listTopics(filter?: string): Promise<{ name: string }[]> {
		logger.debug({ filter: filter || null }, "Listing topics");
		return this.clientManager.withAdmin(async (admin) => {
			const topics = await admin.listTopics();

			let filtered = topics;
			if (filter) {
				const regex = new RegExp(filter);
				filtered = topics.filter((t) => regex.test(t));
			}

			logger.debug({ count: filtered.length }, "Topics listed");
			return filtered.map((name) => ({ name }));
		});
	}

	async listDlqTopics(options?: ListDlqTopicsOptions): Promise<DlqTopic[]> {
		logger.debug({ options: options ?? null }, "Listing DLQ topics");

		const allTopics = await this.listTopics();
		const dlqNames = allTopics.map((t) => t.name).filter((name) => DLQ_PATTERNS.some((p) => p.test(name)));

		if (dlqNames.length === 0) {
			return [];
		}

		const firstSample = await sampleDlqOffsets(this.clientManager, dlqNames);

		if (options?.skipDelta === true) {
			return dlqNames.map((name) => ({
				name,
				totalMessages: firstSample.get(name) ?? 0,
				recentDelta: null,
			}));
		}

		const windowMs = options?.windowMs ?? 30_000;
		await new Promise<void>((resolve) => setTimeout(resolve, windowMs));

		const secondSample = await sampleDlqOffsets(this.clientManager, dlqNames);

		return dlqNames.map((name) => {
			const first = firstSample.get(name);
			const second = secondSample.get(name);
			const totalMessages = first ?? 0;
			// recentDelta is null only when the second sample entirely failed for this topic.
			const recentDelta = second !== undefined ? second - (first ?? 0) : null;
			return { name, totalMessages, recentDelta };
		});
	}

	async describeTopic(topicName: string): Promise<{
		name: string;
		offsets: ListedOffsetsTopic | null;
		configs: ConfigDescription | null;
	}> {
		logger.debug({ topicName }, "Describing topic");
		return this.clientManager.withAdmin(async (admin) => {
			const partitions = await getPartitionIndices(admin, topicName);
			const [offsets, configDescriptions] = await Promise.all([
				admin
					.listOffsets({
						topics: [
							{
								name: topicName,
								partitions: partitions.map((i) => ({
									partitionIndex: i,
									timestamp: ListOffsetTimestamps.LATEST,
								})),
							},
						],
					})
					.catch(() => null),
				admin
					.describeConfigs({
						resources: [{ resourceType: ConfigResourceTypes.TOPIC, resourceName: topicName }],
					})
					.catch(() => null),
			]);

			const topicOffsets = offsets?.find((t) => t.name === topicName) ?? null;
			const topicConfigs = configDescriptions?.[0] ?? null;

			return {
				name: topicName,
				offsets: topicOffsets,
				configs: topicConfigs,
			};
		});
	}

	async getTopicOffsets(topicName: string, timestamp?: number): Promise<ListedOffsetsTopic | null> {
		logger.debug({ topicName, timestamp: timestamp ?? null }, "Getting topic offsets");
		return this.clientManager.withAdmin(async (admin) => {
			const ts = timestamp !== undefined ? BigInt(timestamp) : ListOffsetTimestamps.LATEST;
			const partitions = await getPartitionIndices(admin, topicName);

			const result = await admin.listOffsets({
				topics: [
					{
						name: topicName,
						partitions: partitions.map((i) => ({ partitionIndex: i, timestamp: ts })),
					},
				],
			});

			return result.find((t) => t.name === topicName) ?? null;
		});
	}

	async consumeMessages(options: ConsumeMessagesOptions): Promise<
		Array<{
			topic: string;
			partition: number;
			offset: string;
			key: string | null;
			value: string | null;
			timestamp: string;
			headers: Record<string, string>;
		}>
	> {
		logger.debug(
			{
				topic: options.topic,
				maxMessages: options.maxMessages,
				timeoutMs: options.timeoutMs,
			},
			"Consuming messages",
		);
		const groupId = `mcp-consume-${crypto.randomUUID()}`;
		const consumer = await this.clientManager.createConsumer(groupId);
		const messages: Array<{
			topic: string;
			partition: number;
			offset: string;
			key: string | null;
			value: string | null;
			timestamp: string;
			headers: Record<string, string>;
		}> = [];

		try {
			const mode = options.fromBeginning ? "earliest" : "latest";
			const stream = await consumer.consume({
				topics: [options.topic],
				mode,
				autocommit: false,
				maxFetches: 1,
			});

			const deadline = Date.now() + options.timeoutMs;

			for await (const msg of stream as AsyncIterable<Message<Buffer, Buffer, Buffer, Buffer>>) {
				messages.push(formatMessage(msg));

				if (messages.length >= options.maxMessages || Date.now() >= deadline) {
					break;
				}
			}

			await stream.close();
		} finally {
			if (!consumer.closed) {
				await consumer.close().catch(() => {});
			}
		}

		return messages;
	}

	async listConsumerGroups(
		filter?: string,
		states?: string[],
	): Promise<Array<{ id: string; state: string; groupType: string; protocolType: string }>> {
		logger.debug({ filter: filter || null, states: states || null }, "Listing consumer groups");
		return this.clientManager.withAdmin(async (admin) => {
			const groupsMap = await admin.listGroups({
				states: states as Parameters<typeof admin.listGroups>[0] extends infer T
					? T extends { states?: infer S }
						? S
						: never
					: never,
			});

			let groups = Array.from(groupsMap.values());

			if (filter) {
				const regex = new RegExp(filter);
				groups = groups.filter((g) => regex.test(g.id));
			}

			return groups.map((g) => ({
				id: g.id,
				state: g.state,
				groupType: g.groupType,
				protocolType: g.protocolType,
			}));
		});
	}

	async describeConsumerGroup(groupId: string): Promise<{
		groupId: string;
		state: string;
		protocol: string;
		members: Array<{
			id: string;
			clientId: string;
			clientHost: string;
		}>;
		offsets: Array<{
			topic: string;
			partitions: Array<{
				partition: number;
				committedOffset: string;
				lag?: string;
			}>;
		}>;
	}> {
		logger.debug({ groupId }, "Describing consumer group");
		return this.clientManager.withAdmin(async (admin) => {
			const [groupsMap, offsetGroups] = await Promise.all([
				admin.describeGroups({ groups: [groupId] }),
				admin.listConsumerGroupOffsets({ groups: [groupId] }).catch(() => []),
			]);

			const group = groupsMap.get(groupId);
			if (!group) {
				throw new Error(`Consumer group '${groupId}' not found`);
			}

			const members = Array.from(group.members.values()).map((m) => ({
				id: m.id,
				clientId: m.clientId,
				clientHost: m.clientHost,
			}));

			const offsetGroup = offsetGroups.find((g) => g.groupId === groupId);
			const offsets =
				offsetGroup?.topics.map((t) => ({
					topic: t.name,
					partitions: t.partitions.map((p) => ({
						partition: p.partitionIndex,
						committedOffset: p.committedOffset.toString(),
					})),
				})) ?? [];

			return {
				groupId,
				state: group.state,
				protocol: group.protocol,
				members,
				offsets,
			};
		});
	}

	async getClusterInfo(): Promise<Record<string, unknown>> {
		logger.debug("Getting cluster info");
		const provider = this.clientManager.getProvider();

		const [topics, providerMetadata] = await Promise.all([
			this.clientManager.withAdmin((admin) => admin.listTopics()).catch(() => [] as string[]),
			provider.getClusterMetadata?.().catch(() => ({})) ?? Promise.resolve({}),
		]);

		return {
			provider: provider.type,
			providerName: provider.name,
			topicCount: topics.length,
			topics,
			...providerMetadata,
		};
	}

	async getConsumerGroupLag(groupId: string): Promise<{
		groupId: string;
		topics: Array<{
			topic: string;
			partitions: Array<{
				partition: number;
				committedOffset: string;
				latestOffset: string;
				lag: string;
			}>;
			totalLag: string;
		}>;
		totalLag: string;
	}> {
		logger.debug({ groupId }, "Getting consumer group lag");
		return this.clientManager.withAdmin(async (admin) => {
			const offsetGroups = await admin.listConsumerGroupOffsets({ groups: [groupId] });
			const offsetGroup = offsetGroups.find((g) => g.groupId === groupId);

			if (!offsetGroup || offsetGroup.topics.length === 0) {
				return { groupId, topics: [], totalLag: "0" };
			}

			let grandTotalLag = BigInt(0);
			const topicResults: Array<{
				topic: string;
				partitions: Array<{
					partition: number;
					committedOffset: string;
					latestOffset: string;
					lag: string;
				}>;
				totalLag: string;
			}> = [];

			for (const topic of offsetGroup.topics) {
				const latestOffsets = await admin.listOffsets({
					topics: [
						{
							name: topic.name,
							partitions: topic.partitions.map((p) => ({
								partitionIndex: p.partitionIndex,
								timestamp: ListOffsetTimestamps.LATEST,
							})),
						},
					],
				});

				const latestTopic = latestOffsets.find((t) => t.name === topic.name);
				let topicTotalLag = BigInt(0);

				const partitionResults = topic.partitions.map((p) => {
					const latestPartition = latestTopic?.partitions.find((lp) => lp.partitionIndex === p.partitionIndex);
					const committed = p.committedOffset;
					const latest = latestPartition?.offset ?? BigInt(0);
					const lag = committed >= BigInt(0) && latest > committed ? latest - committed : BigInt(0);
					topicTotalLag += lag;

					return {
						partition: p.partitionIndex,
						committedOffset: committed.toString(),
						latestOffset: latest.toString(),
						lag: lag.toString(),
					};
				});

				grandTotalLag += topicTotalLag;
				topicResults.push({
					topic: topic.name,
					partitions: partitionResults,
					totalLag: topicTotalLag.toString(),
				});
			}

			return {
				groupId,
				topics: topicResults,
				totalLag: grandTotalLag.toString(),
			};
		});
	}

	async describeCluster(): Promise<{
		brokers: Array<{
			id: number;
			host: string;
			port: number;
			rack?: string;
			isController: boolean;
		}>;
		controllerId: number;
		brokerCount: number;
		topicCount: number;
		provider: string;
	}> {
		logger.debug("Describing cluster");
		const provider = this.clientManager.getProvider();

		return this.clientManager.withAdmin(async (admin) => {
			const metadata = await getClusterMetadata(admin);

			const brokers = Array.from(metadata.brokers.entries()).map(([id, info]) => ({
				id,
				host: info.host,
				port: info.port,
				rack: info.rack,
				isController: id === metadata.controllerId,
			}));

			return {
				brokers,
				controllerId: metadata.controllerId,
				brokerCount: brokers.length,
				topicCount: metadata.topics.size,
				provider: provider.type,
			};
		});
	}

	async getMessageByOffset(topic: string, partition: number, offset: number): Promise<GetMessageByOffsetResult> {
		logger.debug({ topic, partition, offset }, "Getting message by offset");
		const requestedOffset = BigInt(offset);

		const bounds = await this.clientManager.withAdmin((admin) => getPartitionOffsetBounds(admin, topic, partition));
		if (!bounds) {
			return {
				status: "error",
				code: "PARTITION_NOT_FOUND",
				message: `Partition ${partition} of topic '${topic}' not found in broker metadata.`,
			};
		}
		if (requestedOffset < bounds.earliest || requestedOffset >= bounds.latest) {
			return {
				status: "out_of_range",
				topic,
				partition,
				requestedOffset: requestedOffset.toString(),
				earliestOffset: bounds.earliest.toString(),
				latestOffset: bounds.latest.toString(),
				message:
					requestedOffset < bounds.earliest
						? "Offset is older than the partition log start (likely deleted by retention)."
						: "Offset is at or beyond the high watermark (no message has been produced at this offset yet).",
			};
		}

		const groupId = `mcp-seek-${crypto.randomUUID()}`;
		const consumer = await this.clientManager.createConsumer(groupId);

		try {
			const stream = await consumer.consume({
				topics: [topic],
				offsets: [{ topic, partition, offset: requestedOffset }],
				mode: "manual",
				autocommit: false,
				maxFetches: 1,
			});

			const deadline = Date.now() + 15_000;

			for await (const msg of stream as AsyncIterable<Message<Buffer, Buffer, Buffer, Buffer>>) {
				const formatted = formatMessage(msg);
				if (msg.partition === partition && msg.offset === requestedOffset) {
					await stream.close();
					return { status: "ok", message: formatted };
				}
				if (msg.offset > requestedOffset || Date.now() >= deadline) {
					break;
				}
			}

			await stream.close();
			return {
				status: "error",
				code: "TIMEOUT",
				message: `No message at offset ${offset} of ${topic}:${partition} within 15s deadline (consumer drained without finding the requested offset).`,
			};
		} catch (err) {
			const classified = classifyKafkaError(err);
			return {
				status: "error",
				code: "BROKER_ERROR",
				kafkaErrorCode: classified.kafkaErrorCode,
				kafkaErrorName: classified.kafkaErrorName,
				message: classified.message,
			};
		} finally {
			if (!consumer.closed) {
				await consumer.close().catch(() => {});
			}
		}
	}

	async produceMessage(
		topic: string,
		messages: ProduceMessageInput[],
		acks?: number,
	): Promise<{ offsets: Array<{ topic: string; partition: number; offset: string }> }> {
		logger.debug({ topic, messageCount: messages.length }, "Producing messages");
		const producer = await this.clientManager.getProducer();

		const kafkaMessages = messages.map((m) => ({
			topic,
			key: m.key ? Buffer.from(m.key) : undefined,
			value: Buffer.from(m.value),
			partition: m.partition,
			headers: m.headers
				? new Map(Object.entries(m.headers).map(([k, v]) => [Buffer.from(k), Buffer.from(v)]))
				: undefined,
		}));

		const result = await producer.send({
			messages: kafkaMessages,
			acks,
		});

		return {
			offsets:
				result.offsets?.map((o) => ({
					topic: o.topic,
					partition: o.partition,
					offset: o.offset.toString(),
				})) ?? [],
		};
	}

	async createTopic(input: CreateTopicInput): Promise<{
		name: string;
		partitions: number;
		replicas: number;
	}> {
		logger.debug(
			{
				name: input.name,
				partitions: input.partitions ?? 1,
				replicas: input.replicas ?? 1,
			},
			"Creating topic",
		);
		return this.clientManager.withAdmin(async (admin) => {
			const configs = input.configs
				? Object.entries(input.configs).map(([name, value]) => ({ name, value }))
				: undefined;

			const result = await admin.createTopics({
				topics: [input.name],
				partitions: input.partitions ?? 1,
				replicas: input.replicas ?? 1,
				configs,
			});

			const created = result[0];
			return {
				name: created?.name ?? input.name,
				partitions: created?.partitions ?? input.partitions ?? 1,
				replicas: created?.replicas ?? input.replicas ?? 1,
			};
		});
	}

	async alterTopicConfig(
		topicName: string,
		configs: Record<string, string>,
	): Promise<{ topic: string; updatedConfigs: Record<string, string> }> {
		logger.debug({ topicName, configCount: Object.keys(configs).length }, "Altering topic config");
		return this.clientManager.withAdmin(async (admin) => {
			await admin.alterConfigs({
				resources: [
					{
						resourceType: ConfigResourceTypes.TOPIC,
						resourceName: topicName,
						configs: Object.entries(configs).map(([name, value]) => ({
							name,
							value,
						})),
					},
				],
			});

			return { topic: topicName, updatedConfigs: configs };
		});
	}

	async deleteTopic(topicName: string): Promise<{ deleted: string }> {
		logger.debug({ topicName }, "Deleting topic");
		return this.clientManager.withAdmin(async (admin) => {
			const topics = await admin.listTopics();
			if (!topics.includes(topicName)) {
				throw new Error(`Topic '${topicName}' does not exist`);
			}

			await admin.deleteTopics({ topics: [topicName] });
			return { deleted: topicName };
		});
	}

	async resetConsumerGroupOffsets(
		input: ResetOffsetsInput,
	): Promise<{ groupId: string; topic: string; strategy: string }> {
		logger.debug(
			{
				groupId: input.groupId,
				topic: input.topic,
				strategy: input.strategy,
			},
			"Resetting consumer group offsets",
		);
		return this.clientManager.withAdmin(async (admin) => {
			const groups = await admin.describeGroups({ groups: [input.groupId] });
			const group = groups.get(input.groupId);
			if (group && group.state !== "EMPTY") {
				throw new Error(
					`Consumer group '${input.groupId}' must be in EMPTY state to reset offsets (current: ${group.state})`,
				);
			}

			let targetTimestamp: bigint;
			switch (input.strategy) {
				case "earliest":
					targetTimestamp = ListOffsetTimestamps.EARLIEST;
					break;
				case "latest":
					targetTimestamp = ListOffsetTimestamps.LATEST;
					break;
				case "timestamp":
					if (input.timestamp === undefined) {
						throw new Error("Timestamp is required for 'timestamp' strategy");
					}
					targetTimestamp = BigInt(input.timestamp);
					break;
			}

			const partitions = await getPartitionIndices(admin, input.topic);
			const offsetsResult = await admin.listOffsets({
				topics: [
					{
						name: input.topic,
						partitions: partitions.map((i) => ({ partitionIndex: i, timestamp: targetTimestamp })),
					},
				],
			});

			const topicOffsets = offsetsResult.find((t) => t.name === input.topic);
			if (!topicOffsets) {
				throw new Error(`No offsets found for topic '${input.topic}'`);
			}

			await admin.alterConsumerGroupOffsets({
				groupId: input.groupId,
				topics: [
					{
						name: input.topic,
						partitionOffsets: topicOffsets.partitions.map((p) => ({
							partition: p.partitionIndex,
							offset: p.offset,
						})),
					},
				],
			});

			return {
				groupId: input.groupId,
				topic: input.topic,
				strategy: input.strategy,
			};
		});
	}
}

function formatMessage(msg: Message<Buffer, Buffer, Buffer, Buffer>): FormattedMessage {
	const headers: Record<string, string> = {};
	if (msg.headers) {
		for (const [k, v] of msg.headers) {
			headers[k?.toString() ?? ""] = v?.toString() ?? "";
		}
	}

	return {
		topic: msg.topic,
		partition: msg.partition,
		offset: msg.offset.toString(),
		key: msg.key?.toString() ?? null,
		value: msg.value?.toString() ?? null,
		timestamp: msg.timestamp.toString(),
		headers,
	};
}
