// packages/agent/src/correlation/extractors/kafka.ts
import type { KafkaFindings, ToolOutput } from "@devops-agent/shared";
import { z } from "zod";

// SIO-771/772: file-private schemas describe the **tool output** shape (what
// the kafka MCP returns), not the **finding** shape (which lives in
// @devops-agent/shared). Each tool's parser is owned by this extractor.

// SIO-783: kafka-service.ts listConsumerGroups returns a bare Array<{id, state, ...}>.
// Accept either the bare array (production shape) or the {groups: [...]} wrapper
// (back-compat for any callers that wrap).
const ListConsumerGroupsRowSchema = z.object({ id: z.string(), state: z.string() });
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

// SIO-785: tokens used as suffixes/qualifiers on kafka consumer-group ids that
// should be stripped before fuzzy-matching against APM service names. Kafka groups
// often look like `<service>-prod-consumer`, `<service>-sink`, `<service>-eventing`.
const SUFFIX_PATTERN = /-?(consumer|sink|eventing|prod|stg|dev|svc|service)$/g;
const MIN_TOKEN_LENGTH = 4;

function normalize(s: string): string {
	let result = s.toLowerCase();
	// Strip suffix tokens iteratively (a group can be e.g. `notifications-service-consumer`).
	let prev = "";
	while (prev !== result) {
		prev = result;
		result = result.replace(SUFFIX_PATTERN, "");
	}
	// Singular form: drop trailing `s` (handles notifications-service vs notification-service).
	return result.replace(/s$/, "");
}

function tokenize(s: string): Set<string> {
	// SIO-785: depluralise per token so `articles` matches `article`. The whole-string
	// normalize only strips a single trailing `s`, but kafka group ids embed plural
	// nouns mid-string (e.g. `pim-sink-articles`).
	return new Set(
		normalize(s)
			.split(/[-_.]/)
			.filter((t) => t.length >= MIN_TOKEN_LENGTH)
			.map((t) => t.replace(/s$/, "")),
	);
}

// SIO-785: "related to" matching between a finding name and the investigation
// focus services. Pass-through any finding that is degraded (non-Stable state,
// non-zero lag, or DLQ with growth) regardless of name match — those are
// operational signals the user should see even if they didn't ask by name.
function isRelevantById(
	id: string | undefined,
	state: string | undefined,
	totalLag: number | undefined,
	focusServices: string[],
): boolean {
	if (state !== undefined && state !== "Stable") return true;
	if ((totalLag ?? 0) > 0) return true;
	if (focusServices.length === 0) return true;
	if (!id) return false;
	const idNorm = normalize(id);
	const idTokens = tokenize(id);
	for (const svc of focusServices) {
		const sNorm = normalize(svc);
		if (sNorm.length > 0 && (idNorm.includes(sNorm) || sNorm.includes(idNorm))) return true;
		const sTokens = tokenize(svc);
		for (const t of sTokens) {
			if (idTokens.has(t)) return true;
		}
	}
	return false;
}

function isRelevantDlq(name: string, recentDelta: number | null, focusServices: string[]): boolean {
	if (recentDelta !== null && recentDelta > 0) return true;
	if (focusServices.length === 0) return true;
	const nameNorm = normalize(name);
	const nameTokens = tokenize(name);
	for (const svc of focusServices) {
		const sNorm = normalize(svc);
		if (sNorm.length > 0 && (nameNorm.includes(sNorm) || sNorm.includes(nameNorm))) return true;
		const sTokens = tokenize(svc);
		for (const t of sTokens) {
			if (nameTokens.has(t)) return true;
		}
	}
	return false;
}

// SIO-785: focusServices is an optional list of service names from the
// investigation context (InvestigationFocus.services + NormalizedIncident.affectedServices.name).
// Empty/omitted = render all (current behavior). Populated = scope findings to
// related groups via fuzzy match, with degraded-pass-through.
export function extractKafkaFindings(outputs: ToolOutput[], focusServices: string[] = []): KafkaFindings {
	const byId = new Map<string, { id: string; state?: string; totalLag?: number }>();
	const dlqTopics: Array<z.infer<typeof ListDlqTopicsRowSchema>> = [];

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
		}
	}

	// SIO-785: apply relevance filter at emit time. Done after accumulation so the
	// merged state/totalLag (set by separate tool outputs) is visible to the filter.
	const filteredGroups = Array.from(byId.values()).filter((g) =>
		isRelevantById(g.id, g.state, g.totalLag, focusServices),
	);
	const filteredDlqs = dlqTopics.filter((d) => isRelevantDlq(d.name, d.recentDelta, focusServices));

	const findings: KafkaFindings = {};
	if (filteredGroups.length > 0) findings.consumerGroups = filteredGroups;
	if (filteredDlqs.length > 0) findings.dlqTopics = filteredDlqs;
	return findings;
}
