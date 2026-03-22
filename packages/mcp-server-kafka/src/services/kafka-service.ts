// src/services/kafka-service.ts

import type { Admin, Message } from "@platformatic/kafka";
import {
  type ConfigDescription,
  ConfigResourceTypes,
  type ListedOffsetsTopic,
  ListOffsetTimestamps,
} from "@platformatic/kafka";
import type { KafkaClientManager } from "./client-manager.ts";

// @platformatic/kafka doesn't support partitionIndex=-1 (all partitions) in listOffsets.
async function getPartitionIndices(admin: Admin, topicName: string): Promise<number[]> {
  const metadata = await new Promise<{
    topics: Map<string, { partitions: Record<number, unknown> }>;
  }>((resolve, reject) => {
    (
      admin as unknown as {
        metadata: (
          opts: { topics: string[] },
          cb: (err: Error | null, data: unknown) => void,
        ) => void;
      }
    ).metadata({ topics: [topicName] }, (err, data) =>
      err
        ? reject(err)
        : resolve(data as { topics: Map<string, { partitions: Record<number, unknown> }> }),
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
        metadata: (
          opts: { topics?: string[] },
          cb: (err: Error | null, data: unknown) => void,
        ) => void;
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

export class KafkaService {
  constructor(private readonly clientManager: KafkaClientManager) {}

  async listTopics(filter?: string): Promise<{ name: string }[]> {
    return this.clientManager.withAdmin(async (admin) => {
      const topics = await admin.listTopics();

      let filtered = topics;
      if (filter) {
        const regex = new RegExp(filter);
        filtered = topics.filter((t) => regex.test(t));
      }

      return filtered.map((name) => ({ name }));
    });
  }

  async describeTopic(topicName: string): Promise<{
    name: string;
    offsets: ListedOffsetsTopic | null;
    configs: ConfigDescription | null;
  }> {
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
          const latestPartition = latestTopic?.partitions.find(
            (lp) => lp.partitionIndex === p.partitionIndex,
          );
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

  async getMessageByOffset(
    topic: string,
    partition: number,
    offset: number,
  ): Promise<{
    topic: string;
    partition: number;
    offset: string;
    key: string | null;
    value: string | null;
    timestamp: string;
    headers: Record<string, string>;
  } | null> {
    const groupId = `mcp-seek-${crypto.randomUUID()}`;
    const consumer = await this.clientManager.createConsumer(groupId);

    try {
      const stream = await consumer.consume({
        topics: [topic],
        offsets: [{ topic, partition, offset: BigInt(offset) }],
        mode: "manual",
        autocommit: false,
        maxFetches: 1,
      });

      const deadline = Date.now() + 15_000;

      for await (const msg of stream as AsyncIterable<Message<Buffer, Buffer, Buffer, Buffer>>) {
        const formatted = formatMessage(msg);
        if (msg.partition === partition && msg.offset === BigInt(offset)) {
          await stream.close();
          return formatted;
        }
        if (msg.offset > BigInt(offset) || Date.now() >= deadline) {
          break;
        }
      }

      await stream.close();
      return null;
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

function formatMessage(msg: Message<Buffer, Buffer, Buffer, Buffer>): {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  timestamp: string;
  headers: Record<string, string>;
} {
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
