// packages/agent/src/correlation/extractors/kafka.ts
import type { KafkaFindings, ToolOutput } from "@devops-agent/shared";
import { z } from "zod";
// SIO-1030: normalize/tokenize/matchesFocus moved to the shared focus-match module
// so every extractor + correlation/rules.ts use one matcher. Kafka's degraded
// pass-through (below) is unchanged; only the name-match loop is now shared.
import { matchesFocus } from "../focus-match.ts";

// SIO-771/772: file-private schemas describe the **tool output** shape (what
// the kafka MCP returns), not the **finding** shape (which lives in
// @devops-agent/shared). Each tool's parser is owned by this extractor.

// SIO-783: kafka-service.ts listConsumerGroups returns a bare Array<{id, state, ...}>.
// Accept either the bare array (production shape) or the {groups: [...]} wrapper
// (back-compat for any callers that wrap).
// Live-verification 2026-05-18: real Confluent/MSK admin API emits state in
// uppercase ("STABLE", "EMPTY", "DEAD", "PREPARING_REBALANCE", ...). Normalize
// at parse so downstream comparisons (extractor pass-through, correlation rules,
// UI dot colour) all see one canonical shape.
const ListConsumerGroupsRowSchema = z.object({
	id: z.string(),
	state: z.string().transform((s) => s.toUpperCase()),
});
const ListConsumerGroupsArraySchema = z.array(z.unknown());
const ListConsumerGroupsWrapperSchema = z.object({ groups: z.array(z.unknown()) });

// SIO-783: kafka-service.ts getConsumerGroupLag returns totalLag as a string ("0",
// "12345"). Accept string or number, coerce to number at parse time. Falls back to
// the raw value when the string isn't numeric (lets safeParse fail cleanly).
const GetConsumerGroupLagSchema = z.object({
	groupId: z.string(),
	totalLag: z.union([z.number(), z.string()]).transform((v, ctx) => {
		const n = typeof v === "number" ? v : Number(v);
		if (!Number.isFinite(n)) {
			ctx.addIssue({ code: "custom", message: "totalLag is not a finite number" });
			return z.NEVER;
		}
		return n;
	}),
});

const ListDlqTopicsRowSchema = z.object({
	name: z.string(),
	totalMessages: z.number(),
	recentDelta: z.number().nullable(),
});

// SIO-1149: fallback DLQ derivation for when kafka_list_dlq_topics fails/times out and
// the sub-agent inspects a DLQ topic directly (the localcore run: 113k-message DLQ,
// dlqTopics:0). Shapes from mcp-server-kafka kafka-service.ts: kafka_describe_topic
// returns { name, offsets: ListedOffsetsTopic|null, configs }; kafka_get_topic_offsets
// returns a bare ListedOffsetsTopic|null. Offsets and timestamps are BIGINTS SERIALIZED
// AS STRINGS (response-builder bigintReplacer); partitions[].timestamp echoes the
// REQUESTED sentinel ("-1" LATEST -- the describe_topic default -- or "-2" EARLIEST).
const OffsetsPartitionSchema = z.object({
	partitionIndex: z.number(),
	timestamp: z.union([z.string(), z.number()]).optional(),
	offset: z.union([z.string(), z.number()]).transform((v, ctx) => {
		const n = Number(v);
		if (!Number.isFinite(n)) {
			ctx.addIssue({ code: "custom", message: "offset is not a finite number" });
			return z.NEVER;
		}
		return n;
	}),
});
const OffsetsTopicSchema = z.object({ name: z.string(), partitions: z.array(OffsetsPartitionSchema) });
const DescribeTopicSchema = z.object({ name: z.string(), offsets: OffsetsTopicSchema.nullable() });
// Broad on purpose: covers the DLQ_ prefix (this incident), -dlq, .DLQ, and dead-letter
// forms. mcp-server-kafka's own DLQ_PATTERNS misses DLQ_-prefixed names (SIO-1150).
const DLQ_NAME_RE = /(^|[._-])dlq([._-]|$)|dead.?letter/i;
const EARLIEST_SENTINEL = "-2";
const LATEST_SENTINEL = "-1";

type DerivedOffsets = { latest: Map<number, number>; earliest: Map<number, number> };

function accumulateDerivedDlq(derived: Map<string, DerivedOffsets>, topic: z.infer<typeof OffsetsTopicSchema>): void {
	if (!DLQ_NAME_RE.test(topic.name)) return;
	const entry = derived.get(topic.name) ?? { latest: new Map(), earliest: new Map() };
	for (const p of topic.partitions) {
		// Sentinel echo decides which bound this row is. An absent timestamp means the
		// default request (LATEST). A real (time-anchored) timestamp is neither bound.
		const ts = p.timestamp === undefined ? LATEST_SENTINEL : String(p.timestamp);
		if (ts === EARLIEST_SENTINEL) entry.earliest.set(p.partitionIndex, p.offset);
		else if (ts === LATEST_SENTINEL) entry.latest.set(p.partitionIndex, p.offset);
	}
	derived.set(topic.name, entry);
}

// totalMessages per derived topic: sum(latest - earliest) when EVERY latest partition
// has an earliest bound, else sum of high watermarks -- an UPPER BOUND on retained
// messages (retention-truncated topics start above offset 0). Snapshot-only, so
// recentDelta is unknowable: emitted as null.
function derivedDlqRows(derived: Map<string, DerivedOffsets>): Array<z.infer<typeof ListDlqTopicsRowSchema>> {
	const rows: Array<z.infer<typeof ListDlqTopicsRowSchema>> = [];
	for (const [name, { latest, earliest }] of derived) {
		if (latest.size === 0) continue;
		const haveAllEarliest = Array.from(latest.keys()).every((i) => earliest.has(i));
		let total = 0;
		for (const [i, high] of latest) {
			total += haveAllEarliest ? high - (earliest.get(i) ?? 0) : high;
		}
		if (total > 0) rows.push({ name, totalMessages: total, recentDelta: null });
	}
	return rows;
}

// SIO-785 follow-up (2026-05-18): shape from kafka_describe_cluster.
// Live-probed against c72-shared-services-msk on 2026-05-18; matches MSK admin API.
const DescribeClusterSchema = z.object({
	provider: z.string().optional(),
	brokerCount: z.number().int().optional(),
	topicCount: z.number().int().optional(),
	controllerId: z.number().int().optional(),
});

// SIO-785 follow-up (2026-05-18): shape from connect_list_connectors.
// Response is { connectors: { <name>: { status: { connector: { state }, tasks: [{state}], type } } } }
// — an object keyed by connector name, NOT an array. The status.connector.state
// is the canonical connector state; tasks[] is per-worker.
const ConnectorStatusEntrySchema = z.object({
	status: z.object({
		name: z.string().optional(),
		connector: z.object({ state: z.string() }),
		tasks: z
			.array(
				z.object({
					id: z.number().int().optional(),
					state: z.string(),
				}),
			)
			.optional(),
		type: z.string().optional(),
	}),
});
const ListConnectorsWrappedSchema = z.object({
	connectors: z.record(z.string(), ConnectorStatusEntrySchema),
});

// SIO-785 follow-up (2026-05-18): shape from ksql_list_queries.
// Response: { queries: [{ id, state, queryType, statusCount: {<replicaState>: count} }] }
const KsqlQueryRowSchema = z.object({
	id: z.string(),
	state: z.string(),
	queryType: z.string().optional(),
	statusCount: z.record(z.string(), z.number().int()).optional(),
});
const ListKsqlQueriesWrappedSchema = z.object({
	queries: z.array(z.unknown()),
});

// SIO-785 / SIO-1030: "related to" matching between a finding name and the
// investigation focus services. Pass-through any finding that is degraded
// (non-Stable state, non-zero lag, or DLQ with growth) regardless of name match —
// those are operational signals the user should see even if they didn't ask by
// name. The name-match itself is delegated to the shared matchesFocus (which
// short-circuits show-all on empty focus).
function isRelevantById(
	id: string | undefined,
	state: string | undefined,
	totalLag: number | undefined,
	focusServices: string[],
): boolean {
	if (state !== undefined && state !== "STABLE") return true;
	if ((totalLag ?? 0) > 0) return true;
	if (focusServices.length === 0) return true;
	if (!id) return false;
	return matchesFocus(id, focusServices);
}

function isRelevantDlq(name: string, recentDelta: number | null, focusServices: string[]): boolean {
	if (recentDelta !== null && recentDelta > 0) return true;
	return matchesFocus(name, focusServices);
}

// SIO-785: focusServices is an optional list of service names from the
// investigation context (InvestigationFocus.services + NormalizedIncident.affectedServices.name).
// Empty/omitted = render all (current behavior). Populated = scope findings to
// related groups via fuzzy match, with degraded-pass-through.
export function extractKafkaFindings(outputs: ToolOutput[], focusServices: string[] = []): KafkaFindings {
	const byId = new Map<string, { id: string; state?: string; totalLag?: number }>();
	const dlqTopics: Array<z.infer<typeof ListDlqTopicsRowSchema>> = [];
	const derivedDlq = new Map<string, DerivedOffsets>();
	let cluster: NonNullable<KafkaFindings["cluster"]> | undefined;
	const connectorsByName = new Map<string, NonNullable<KafkaFindings["connectors"]>[number]>();
	const ksqlQueries: NonNullable<KafkaFindings["ksqlQueries"]> = [];

	for (const o of outputs) {
		if (o.toolName === "kafka_list_consumer_groups") {
			// SIO-783: prefer bare-array shape (real MCP output), fall back to wrapper.
			const arr = ListConsumerGroupsArraySchema.safeParse(o.rawJson);
			let rows: unknown[];
			if (arr.success) {
				rows = arr.data;
			} else {
				const wrapper = ListConsumerGroupsWrapperSchema.safeParse(o.rawJson);
				if (!wrapper.success) continue;
				rows = wrapper.data.groups;
			}
			for (const g of rows) {
				const parsed = ListConsumerGroupsRowSchema.safeParse(g);
				if (!parsed.success) continue;
				const existing = byId.get(parsed.data.id) ?? { id: parsed.data.id };
				existing.state = parsed.data.state;
				byId.set(parsed.data.id, existing);
			}
		} else if (o.toolName === "kafka_get_consumer_group_lag") {
			const parsed = GetConsumerGroupLagSchema.safeParse(o.rawJson);
			if (!parsed.success) continue;
			const existing = byId.get(parsed.data.groupId) ?? { id: parsed.data.groupId };
			existing.totalLag = parsed.data.totalLag;
			byId.set(parsed.data.groupId, existing);
		} else if (o.toolName === "kafka_list_dlq_topics") {
			if (!Array.isArray(o.rawJson)) continue;
			for (const t of o.rawJson) {
				const parsed = ListDlqTopicsRowSchema.safeParse(t);
				if (parsed.success) dlqTopics.push(parsed.data);
			}
		} else if (o.toolName === "kafka_describe_topic") {
			// SIO-1149: fallback DLQ derivation (see accumulateDerivedDlq above).
			const parsed = DescribeTopicSchema.safeParse(o.rawJson);
			if (!parsed.success || parsed.data.offsets === null) continue;
			accumulateDerivedDlq(derivedDlq, parsed.data.offsets);
		} else if (o.toolName === "kafka_get_topic_offsets") {
			const parsed = OffsetsTopicSchema.safeParse(o.rawJson);
			if (!parsed.success) continue;
			accumulateDerivedDlq(derivedDlq, parsed.data);
		} else if (o.toolName === "kafka_describe_cluster" || o.toolName === "kafka_get_cluster_info") {
			// Cluster summary tile. Both tools return overlapping shapes; merge.
			const parsed = DescribeClusterSchema.safeParse(o.rawJson);
			if (!parsed.success) continue;
			cluster = { ...(cluster ?? {}), ...parsed.data };
		} else if (o.toolName === "connect_list_connectors") {
			// connect_list_connectors returns an object keyed by name. Iterate values.
			const parsed = ListConnectorsWrappedSchema.safeParse(o.rawJson);
			if (!parsed.success) continue;
			for (const [name, entry] of Object.entries(parsed.data.connectors)) {
				const tasks = entry.status.tasks ?? [];
				const taskFailures = tasks.filter((t) => t.state !== "RUNNING").length;
				connectorsByName.set(name, {
					name,
					state: entry.status.connector.state,
					...(entry.status.type ? { type: entry.status.type } : {}),
					...(tasks.length > 0 ? { taskFailures } : {}),
				});
			}
		} else if (o.toolName === "connect_get_connector_status") {
			// Singleton variant: { name, connector: {state}, tasks: [{state}], type }
			const parsed = ConnectorStatusEntrySchema.safeParse({ status: o.rawJson });
			if (!parsed.success) continue;
			const name = parsed.data.status.name;
			if (!name) continue;
			const tasks = parsed.data.status.tasks ?? [];
			const taskFailures = tasks.filter((t) => t.state !== "RUNNING").length;
			connectorsByName.set(name, {
				name,
				state: parsed.data.status.connector.state,
				...(parsed.data.status.type ? { type: parsed.data.status.type } : {}),
				...(tasks.length > 0 ? { taskFailures } : {}),
			});
		} else if (o.toolName === "ksql_list_queries") {
			const parsed = ListKsqlQueriesWrappedSchema.safeParse(o.rawJson);
			if (!parsed.success) continue;
			for (const q of parsed.data.queries) {
				const row = KsqlQueryRowSchema.safeParse(q);
				if (!row.success) continue;
				ksqlQueries.push(row.data);
			}
		}
	}

	// SIO-785: apply relevance filter at emit time. Done after accumulation so the
	// merged state/totalLag (set by separate tool outputs) is visible to the filter.
	const filteredGroups = Array.from(byId.values()).filter((g) =>
		isRelevantById(g.id, g.state, g.totalLag, focusServices),
	);
	const filteredDlqs = dlqTopics.filter((d) => isRelevantDlq(d.name, d.recentDelta, focusServices));
	// SIO-1149: derived rows fill in only for topics the listing did not cover (listed rows
	// win -- they carry a real recentDelta). They BYPASS isRelevantDlq deliberately: the
	// sub-agent targeted the topic by name, which is itself the relevance signal, and a
	// snapshot-derived row (recentDelta null) would otherwise be dropped unless its name
	// happened to fuzzy-match the focus service (DLQ_T_PRIVATE_... does not match localcore).
	const listedNames = new Set(dlqTopics.map((d) => d.name));
	const derivedRows = derivedDlqRows(derivedDlq).filter((d) => !listedNames.has(d.name));

	const findings: KafkaFindings = {};
	if (filteredGroups.length > 0) findings.consumerGroups = filteredGroups;
	const allDlqs = [...filteredDlqs, ...derivedRows];
	if (allDlqs.length > 0) findings.dlqTopics = allDlqs;
	if (cluster) findings.cluster = cluster;
	if (connectorsByName.size > 0) findings.connectors = Array.from(connectorsByName.values());
	if (ksqlQueries.length > 0) findings.ksqlQueries = ksqlQueries;
	return findings;
}
