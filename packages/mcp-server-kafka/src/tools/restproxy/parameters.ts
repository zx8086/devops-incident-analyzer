// src/tools/restproxy/parameters.ts
import { z } from "zod";

export const ListTopicsParams = z.object({});

export const GetTopicParams = z.object({
	name: z.string().min(1).describe("Topic name to fetch metadata for"),
});

export const GetPartitionsParams = z.object({
	topic: z.string().min(1).describe("Topic name whose partitions to list"),
});

export const ProduceParams = z.object({
	topic: z.string().min(1).describe("Topic to produce records to"),
	records: z
		.array(
			z.object({
				key: z.unknown().optional().describe("Optional message key (any JSON-serialisable value)"),
				value: z.unknown().describe("Message value (required, any JSON-serialisable value)"),
				partition: z
					.number()
					.int()
					.nonnegative()
					.optional()
					.describe("Optional explicit target partition; omit to let the broker choose"),
			}),
		)
		.min(1)
		.describe("One or more records to produce in a single batch"),
	format: z.enum(["json", "binary"]).optional().describe("Payload encoding format. Defaults to json when omitted"),
});

export const CreateConsumerParams = z.object({
	group: z.string().min(1).describe("Consumer group name to create or join"),
	name: z.string().min(1).optional().describe("Optional explicit instance name; REST Proxy generates one if omitted"),
	format: z
		.enum(["json", "binary"])
		.optional()
		.describe("Deserialization format for consumed records. Defaults to json"),
	autoOffsetReset: z
		.enum(["earliest", "latest"])
		.optional()
		.describe("Where to start consuming when no committed offset exists. Defaults to latest"),
	autoCommitEnable: z
		.boolean()
		.optional()
		.describe("Whether to auto-commit offsets periodically. Defaults to true in REST Proxy"),
});

export const SubscribeParams = z.object({
	group: z.string().min(1).describe("Consumer group name"),
	instance: z.string().min(1).describe("Consumer instance ID returned by restproxy_create_consumer"),
	topics: z.array(z.string().min(1)).min(1).describe("One or more topic names to subscribe to"),
});

export const ConsumeParams = z.object({
	group: z.string().min(1).describe("Consumer group name"),
	instance: z.string().min(1).describe("Consumer instance ID returned by restproxy_create_consumer"),
	timeoutMs: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum milliseconds to wait for records before returning an empty response"),
	maxBytes: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum total response size in bytes across all returned records"),
});

export const CommitOffsetsParams = z.object({
	group: z.string().min(1).describe("Consumer group name"),
	instance: z.string().min(1).describe("Consumer instance ID returned by restproxy_create_consumer"),
	offsets: z
		.array(
			z.object({
				topic: z.string().min(1).describe("Topic name for this offset entry"),
				partition: z.number().int().nonnegative().describe("Partition number"),
				offset: z.number().int().nonnegative().describe("Offset to commit (next-to-be-consumed position)"),
			}),
		)
		.optional()
		.describe("Explicit offsets to commit; omit to commit all offsets consumed in the current session"),
});

export const DeleteConsumerParams = z.object({
	group: z.string().min(1).describe("Consumer group name"),
	instance: z.string().min(1).describe("Consumer instance ID to delete"),
});
