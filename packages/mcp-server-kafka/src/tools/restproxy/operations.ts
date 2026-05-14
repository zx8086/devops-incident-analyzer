// src/tools/restproxy/operations.ts
import type { z } from "zod";
import type { AppConfig } from "../../config/schemas.ts";
import type { RestProxyService } from "../../services/restproxy-service.ts";
import { type HealthEnvelope, runHealthProbe } from "../shared/health-envelope.ts";
import type {
	CommitOffsetsParams,
	ConsumeParams,
	CreateConsumerParams,
	DeleteConsumerParams,
	GetPartitionsParams,
	GetTopicParams,
	ListTopicsParams,
	ProduceParams,
	SubscribeParams,
} from "./parameters.ts";

// SIO-742: probe REST Proxy reachability. Reuses the existing probeReachability
// path so the envelope picks up the same hostname/contentType metadata as
// regular tool errors.
export async function healthCheck(service: RestProxyService, config: AppConfig): Promise<HealthEnvelope> {
	const endpoint = `${config.restproxy.url.replace(/\/$/, "")}/topics`;
	return runHealthProbe("REST Proxy", endpoint, async () => {
		await service.probeReachability();
		return undefined;
	});
}

export async function listTopics(service: RestProxyService, args: z.infer<typeof ListTopicsParams>) {
	return service.listTopicsPaged({
		prefix: args.prefix,
		limit: args.limit ?? 100,
		offset: args.offset ?? 0,
	});
}

export async function getTopic(service: RestProxyService, args: z.infer<typeof GetTopicParams>) {
	return service.getTopic(args.name);
}

export async function getPartitions(service: RestProxyService, args: z.infer<typeof GetPartitionsParams>) {
	return service.getPartitions(args.topic);
}

export async function produce(service: RestProxyService, args: z.infer<typeof ProduceParams>) {
	return service.produceMessages(args.topic, args.records, args.format);
}

export async function createConsumer(service: RestProxyService, args: z.infer<typeof CreateConsumerParams>) {
	return service.createConsumer(args.group, {
		name: args.name,
		format: args.format,
		autoOffsetReset: args.autoOffsetReset,
		autoCommitEnable: args.autoCommitEnable,
	});
}

export async function subscribe(service: RestProxyService, args: z.infer<typeof SubscribeParams>) {
	await service.subscribe(args.group, args.instance, args.topics);
	return { subscribed: { group: args.group, instance: args.instance, topics: args.topics } };
}

export async function consume(service: RestProxyService, args: z.infer<typeof ConsumeParams>) {
	return service.consumeRecords(args.group, args.instance, {
		timeoutMs: args.timeoutMs,
		maxBytes: args.maxBytes,
	});
}

export async function commitOffsets(service: RestProxyService, args: z.infer<typeof CommitOffsetsParams>) {
	await service.commitOffsets(args.group, args.instance, args.offsets);
	return { committed: { group: args.group, instance: args.instance } };
}

export async function deleteConsumer(service: RestProxyService, args: z.infer<typeof DeleteConsumerParams>) {
	await service.deleteConsumer(args.group, args.instance);
	return { deleted: { group: args.group, instance: args.instance } };
}
