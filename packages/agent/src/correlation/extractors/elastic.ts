// packages/agent/src/correlation/extractors/elastic.ts
// SIO-785 follow-up (2026-05-18): minimal Elastic findings extractor. Today
// surfaces synthetic monitor status from elasticsearch_search queries against
// the synthetics-* index pattern. The SOUL's Synthetic-Monitor Cross-Check rule
// (SIO-717) mandates these queries during Confluent outage investigation, so
// the underlying response shape is stable across runs.
//
// Extend with new branches when other deterministic signals stabilise (APM
// service summary, top error log clusters, etc.). Each new branch should pull
// from a specific ES index pattern + query type so the schema stays tight.
import { createHash } from "node:crypto";
import type {
	ElasticApmService,
	ElasticFindings,
	ElasticLogCluster,
	ElasticSyntheticMonitor,
	ToolOutput,
} from "@devops-agent/shared";
import { z } from "zod";
import { distinctiveTokens } from "../rules.ts";

// Elasticsearch hit envelope.
const HitSchema = z.object({
	_source: z.unknown(),
});
const SearchResponseSchema = z.object({
	hits: z.object({
		hits: z.array(HitSchema),
	}),
});

// Synthetic monitor document subset we surface in the card.
const SyntheticHitSourceSchema = z.object({
	monitor: z.object({
		name: z.string(),
		status: z.string(),
	}),
	url: z
		.object({
			full: z.string().optional(),
		})
		.optional(),
	"@timestamp": z.string().optional(),
	observer: z
		.object({
			geo: z
				.object({
					name: z.string().optional(),
				})
				.optional(),
		})
		.optional(),
});

// SIO-786 (2026-05-18): real elastic MCP returns multi-text-block content
// joined into a single string by @langchain/mcp-adapters. Each document is a
// section starting with "Document ID: <id>" containing YAML-like top-level
// fields with JSON object values:
//
//   monitor: { "name": "...", "id": "...", "status": "down" }
//   url: { "full": "..." }
//   observer: { "geo": { "name": "..." } }
//   summary: { "up": 0, "down": 1, "status": "down" }
//   state: { "status": "down" }
//   @timestamp: 2026-05-18T14:58:52.969Z
//
// `monitor.status` is not always present on browser synthetic heartbeat
// records; resolve status from monitor.status -> summary.status -> state.status.
// Dedupe by monitor.id (stable UUID); fall back to monitor.name when id is
// absent.

// Find a "<key>: {" line and return the substring of the brace-balanced JSON
// object that follows. Returns null when the key isn't present or braces
// don't balance.
function extractJsonBlock(text: string, key: string): string | null {
	const re = new RegExp(`^${key}:\\s*\\{`, "m");
	const m = re.exec(text);
	if (!m) return null;
	const start = m.index + m[0].length - 1; // position of opening brace
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

function parseJsonBlock<T = unknown>(text: string, key: string): T | null {
	const block = extractJsonBlock(text, key);
	if (block === null) return null;
	try {
		return JSON.parse(block) as T;
	} catch {
		return null;
	}
}

// Bare-scalar field, e.g. `@timestamp: 2026-05-18T14:58:52.969Z` (no quotes,
// not a JSON value).
function extractScalarField(text: string, key: string): string | null {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^${escaped}:\\s*(\\S.*?)\\s*$`, "m");
	const m = re.exec(text);
	return m ? (m[1] ?? null) : null;
}

interface ParsedMonitorSection {
	name?: string;
	id?: string;
	status?: string;
	type?: string;
}
interface ParsedUrlSection {
	full?: string;
}
interface ParsedObserverSection {
	geo?: { name?: string };
	name?: string;
}
interface ParsedStatusSection {
	status?: string;
}

function parseSyntheticMonitorsFromText(content: string): ElasticSyntheticMonitor[] {
	// Split on "Document ID:" — the leading marker for each hit's section.
	// The first split element (before the first Document ID) is the summary
	// line ("Total results: ...") which we drop.
	const sections = content.split(/^Document ID:.*$/m).slice(1);
	if (sections.length === 0) return [];

	const monitorsByKey = new Map<string, ElasticSyntheticMonitor>();
	for (const section of sections) {
		const monitor = parseJsonBlock<ParsedMonitorSection>(section, "monitor");
		if (!monitor?.name) continue;

		// Status priority: monitor.status -> summary.status -> state.status.
		let status = monitor.status;
		if (!status) {
			const summary = parseJsonBlock<ParsedStatusSection>(section, "summary");
			status = summary?.status;
		}
		if (!status) {
			const state = parseJsonBlock<ParsedStatusSection>(section, "state");
			status = state?.status;
		}
		if (!status) continue; // no resolvable status — skip

		// Use || (not ??) so empty-string monitor.id falls back to name.
		const dedupeKey = monitor.id || monitor.name;
		if (monitorsByKey.has(dedupeKey)) continue; // first wins (most-recent)

		const url = parseJsonBlock<ParsedUrlSection>(section, "url");
		const observer = parseJsonBlock<ParsedObserverSection>(section, "observer");
		const timestamp = extractScalarField(section, "@timestamp");

		monitorsByKey.set(dedupeKey, {
			name: monitor.name,
			status,
			...(url?.full && { url: url.full }),
			...(timestamp && { observedAt: timestamp }),
			...(observer?.geo?.name && { geo: observer.geo.name }),
		});
	}
	return Array.from(monitorsByKey.values());
}

function looksLikeSyntheticIndex(o: ToolOutput): boolean {
	// SIO-717: the SOUL pattern is `synthetics-*`. Soft-detect via the index
	// or query arg if the agent included it in toolArgs (typical via MCP).
	const args = (o as unknown as { toolArgs?: Record<string, unknown> }).toolArgs;
	if (args && typeof args === "object") {
		const index = (args as { index?: unknown }).index;
		if (typeof index === "string" && /synthetics?/i.test(index)) return true;
	}
	// Fallback: any search hit whose _source has monitor.status counts.
	return false;
}

// SIO-787 (SIO-778 Phase B): APM bucket shape produced by
// `traces-apm-*` + terms-agg on service.name. The real eu-b2b response is a
// multi-text-block MCP payload (joined by normalizeToolContent in sub-agent.ts):
//
//   "Search results with aggregations (10000 total hits, 419ms):\n\n{
//      "by_service": { "buckets": [{ key, doc_count, errors:{doc_count},
//                                    avg_duration:{value}, latest:{value_as_string} }, ...] }
//    }"
//
// tryParseJson fails on the prefixed mixed content, so the extractor sees
// `rawJson` as a string and uses the brace-balanced JSON walker.
const ApmBucketSchema = z.object({
	key: z.string(),
	doc_count: z.number(),
	avg_duration: z.object({ value: z.number().nullable().optional() }).optional(),
	errors: z.object({ doc_count: z.number().optional() }).optional(),
	latest: z
		.object({
			value_as_string: z.string().optional(),
		})
		.optional(),
});
const ApmAggregationSchema = z.object({
	by_service: z.object({
		buckets: z.array(ApmBucketSchema),
	}),
});

function looksLikeApmIndex(o: ToolOutput): boolean {
	const args = (o as unknown as { toolArgs?: Record<string, unknown> }).toolArgs;
	if (args && typeof args === "object") {
		const index = (args as { index?: unknown }).index;
		if (typeof index === "string" && /traces-apm/i.test(index)) return true;
	}
	return false;
}

function bucketToApmService(b: z.infer<typeof ApmBucketSchema>): ElasticApmService {
	const out: ElasticApmService = {
		serviceName: b.key,
		transactionCount: b.doc_count,
	};
	// SIO-787: divide-by-zero guard. Don't emit a 0/0 errorRate; skip the field.
	if (b.doc_count > 0 && b.errors?.doc_count !== undefined) {
		out.errorRate = b.errors.doc_count / b.doc_count;
	}
	if (b.avg_duration?.value !== undefined && b.avg_duration.value !== null) {
		// µs -> ms. Real eu-b2b response stores transaction.duration.us as
		// microseconds; the card displays milliseconds.
		out.avgDurationMs = b.avg_duration.value / 1000;
	}
	if (b.latest?.value_as_string) {
		out.observedAt = b.latest.value_as_string;
	}
	return out;
}

function parseApmAggregationFromText(content: string): ElasticApmService[] {
	// SIO-787: the elastic MCP wraps aggregation responses as a two-block
	// payload — a prefix sentence + a JSON object holding aggregation results
	// at the root (e.g. `{ "by_service": { "buckets": [...] } }`). The text
	// arrives joined with "\n\n" by normalizeToolContent. Locate the first
	// `{` and walk brace-balanced JSON to the matching `}`.
	const firstBrace = content.indexOf("{");
	if (firstBrace === -1) return [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let end = -1;
	for (let i = firstBrace; i < content.length; i++) {
		const ch = content[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) return [];
	let body: unknown;
	try {
		body = JSON.parse(content.slice(firstBrace, end + 1));
	} catch {
		return [];
	}
	return parseApmAggregationFromJson(body);
}

function parseApmAggregationFromJson(rawJson: unknown): ElasticApmService[] {
	// Tolerate both shapes: aggregations.by_service.buckets (full ES envelope)
	// AND by_service.buckets at root (when the MCP server unwraps the body).
	if (!rawJson || typeof rawJson !== "object") return [];
	const candidate = (rawJson as { aggregations?: unknown }).aggregations ?? rawJson;
	const parsed = ApmAggregationSchema.safeParse(candidate);
	if (!parsed.success) return [];
	return parsed.data.by_service.buckets.map(bucketToApmService);
}

// SIO-788 (SIO-778 Phase C): log-cluster source-document shape per
// packages/mcp-server-elastic/tests/dev/fixtures/real-elasticsearch-data.json.
// `service` is sometimes a string and sometimes a nested object (`{name: ...}`)
// in ECS-conformant logs; tolerate both shapes by accepting unknown and
// narrowing at use site.
const LogsHitSourceSchema = z.object({
	message: z.string(),
	level: z.string().optional(),
	service: z.unknown().optional(),
	"@timestamp": z.string().optional(),
});

function looksLikeLogsIndex(o: ToolOutput): boolean {
	const args = (o as unknown as { toolArgs?: Record<string, unknown> }).toolArgs;
	if (args && typeof args === "object") {
		const index = (args as { index?: unknown }).index;
		if (typeof index === "string" && /logs-/i.test(index)) return true;
	}
	return false;
}

function looksLikeNonLogsIndex(o: ToolOutput): boolean {
	// Strict exclusion: if the index hint clearly points to APM or synthetics,
	// the logs branch must not fire even if a hits-level-error majority would
	// otherwise trip the detector.
	const args = (o as unknown as { toolArgs?: Record<string, unknown> }).toolArgs;
	if (!args || typeof args !== "object") return false;
	const index = (args as { index?: unknown }).index;
	if (typeof index !== "string") return false;
	return /traces-apm/i.test(index) || /synthetics?/i.test(index);
}

function signatureFromTokens(tokens: Set<string>): string {
	const sorted = [...tokens].sort().join(" ");
	return createHash("sha1").update(sorted).digest("hex").slice(0, 16);
}

function dominantValue(values: string[], minShare: number): string | undefined {
	// Returns the modal value when one covers >= minShare of the cluster.
	// Tiebreak alphabetical. Undefined when no value clears the threshold or
	// values is empty.
	if (values.length === 0) return undefined;
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	let best: string | undefined;
	let bestCount = -1;
	const sortedKeys = [...counts.keys()].sort();
	for (const key of sortedKeys) {
		const c = counts.get(key) ?? 0;
		if (c > bestCount) {
			best = key;
			bestCount = c;
		}
	}
	if (best === undefined) return undefined;
	if (bestCount / values.length < minShare) return undefined;
	return best;
}

function extractServiceName(rawService: unknown): string | undefined {
	if (typeof rawService === "string") return rawService;
	if (rawService && typeof rawService === "object") {
		const name = (rawService as { name?: unknown }).name;
		if (typeof name === "string") return name;
	}
	return undefined;
}

interface LogClusterAccumulator {
	signature: string;
	sampleMessage: string;
	count: number;
	levels: string[];
	services: string[];
	firstSeen?: string;
	lastSeen?: string;
}

function extractLogClustersFromHits(hits: unknown[]): ElasticLogCluster[] {
	const bySignature = new Map<string, LogClusterAccumulator>();
	let totalErrorLevel = 0;

	for (const hit of hits) {
		if (!hit || typeof hit !== "object") continue;
		const source = (hit as { _source?: unknown })._source;
		const parsed = LogsHitSourceSchema.safeParse(source);
		if (!parsed.success) continue;
		const tokens = distinctiveTokens(parsed.data.message);
		if (tokens.size === 0) continue;
		const sig = signatureFromTokens(tokens);
		const level = parsed.data.level ?? "";
		if (level.toLowerCase() === "error") totalErrorLevel++;
		const ts = parsed.data["@timestamp"];
		const serviceName = extractServiceName(parsed.data.service);

		let acc = bySignature.get(sig);
		if (!acc) {
			acc = {
				signature: sig,
				sampleMessage: parsed.data.message,
				count: 0,
				levels: [],
				services: [],
			};
			bySignature.set(sig, acc);
		}
		acc.count++;
		if (level) acc.levels.push(level);
		if (serviceName) acc.services.push(serviceName);
		if (ts) {
			if (acc.firstSeen === undefined || ts < acc.firstSeen) acc.firstSeen = ts;
			if (acc.lastSeen === undefined || ts > acc.lastSeen) acc.lastSeen = ts;
		}
	}

	// Track whether the hits-level-error majority detector would have tripped.
	// Caller uses this when no index hint is present.
	const projected: (ElasticLogCluster & { __errorMajority?: boolean })[] = [];
	const errorMajority = hits.length > 0 && totalErrorLevel * 2 > hits.length;
	for (const acc of bySignature.values()) {
		const cluster: ElasticLogCluster = {
			signature: acc.signature,
			sampleMessage: acc.sampleMessage,
			count: acc.count,
			level: dominantValue(acc.levels, 0) ?? "",
		};
		const service = dominantValue(acc.services, 0.5);
		if (service) cluster.service = service;
		if (acc.firstSeen) cluster.firstSeen = acc.firstSeen;
		if (acc.lastSeen) cluster.lastSeen = acc.lastSeen;
		projected.push({ ...cluster, __errorMajority: errorMajority });
	}
	projected.sort((a, b) => b.count - a.count);
	return projected.slice(0, 10).map(({ __errorMajority: _err, ...rest }) => rest);
}

function logsHitsErrorMajority(hits: unknown[]): boolean {
	if (hits.length === 0) return false;
	let errors = 0;
	for (const hit of hits) {
		if (!hit || typeof hit !== "object") continue;
		const source = (hit as { _source?: unknown })._source;
		if (!source || typeof source !== "object") continue;
		const level = (source as { level?: unknown }).level;
		if (typeof level === "string" && level.toLowerCase() === "error") errors++;
	}
	return errors * 2 > hits.length;
}

// SIO-788 post-merge fix: the real eu-b2b logs-* response is the same
// "Document ID: ..." YAML-block shape that Phase A parses for synthetic
// monitors — NOT a JSON envelope. Each section carries top-level YAML-like
// keys, with values that are either bare scalars (`@timestamp: ...`,
// `message: ...`) or single-key JSON objects (`log: { "level": "ERROR" }`,
// `service: { "name": "..." }`). Synthesise `_source` shapes from these
// sections and feed them into the existing `extractLogClustersFromHits` so
// the clustering / signature / dominant-value logic stays in one place.
interface ParsedLogLevelSection {
	level?: string;
}
interface ParsedServiceNameSection {
	name?: string;
}

function extractMultiLineScalar(text: string, key: string): string | null {
	// Bare-scalar but allow the value to continue until the next top-level
	// `<key>:` line. Captures messages that wrap onto subsequent lines.
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^${escaped}:\\s*(.*)$`, "m");
	const m = re.exec(text);
	if (!m) return null;
	const startIdx = (m.index ?? 0) + m[0].length;
	// Look ahead for the next line that starts with `<word>:` (a new YAML key)
	// or a blank line followed by `Document ID:`. The value is everything
	// between the match and that boundary, on a single logical line.
	const rest = text.slice(startIdx);
	const boundary = rest.match(/\n(?=[A-Za-z_@][A-Za-z0-9_.-]*:\s|Document ID:)/);
	const tail = boundary ? rest.slice(0, boundary.index) : rest;
	return `${m[1] ?? ""}${tail}`.trim();
}

function parseLogClustersFromBlockText(content: string): unknown[] {
	const sections = content.split(/^Document ID:.*$/m).slice(1);
	if (sections.length === 0) return [];
	const synthesized: unknown[] = [];
	for (const section of sections) {
		const message = extractMultiLineScalar(section, "message");
		if (!message) continue;
		const log = parseJsonBlock<ParsedLogLevelSection>(section, "log");
		const service = parseJsonBlock<ParsedServiceNameSection>(section, "service");
		const timestamp = extractScalarField(section, "@timestamp");
		const source: Record<string, unknown> = { message };
		if (log?.level) source.level = log.level;
		if (service?.name) source.service = service.name;
		if (timestamp) source["@timestamp"] = timestamp;
		synthesized.push({ _source: source });
	}
	return synthesized;
}

function parseLogsHitsFromText(content: string): unknown[] {
	// SIO-788: defensive text-block path. The Phase B walker for APM extracts a
	// single brace-balanced JSON object after a prefix sentence. If the logs
	// MCP response arrives as text (rather than JSON envelope), we expect the
	// same shape: prefix + `{ "hits": { "hits": [...] } }`.
	const firstBrace = content.indexOf("{");
	if (firstBrace === -1) return [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let end = -1;
	for (let i = firstBrace; i < content.length; i++) {
		const ch = content[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}
	if (end === -1) return [];
	try {
		const body = JSON.parse(content.slice(firstBrace, end + 1)) as {
			hits?: { hits?: unknown };
		};
		const inner = body?.hits?.hits;
		return Array.isArray(inner) ? inner : [];
	} catch {
		return [];
	}
}

export function extractElasticFindings(outputs: ToolOutput[]): ElasticFindings {
	const monitorsByName = new Map<string, ElasticSyntheticMonitor>();
	const apmByName = new Map<string, ElasticApmService>();
	// SIO-788: dedupe log clusters across multiple ToolOutput entries by signature.
	// Within a single ToolOutput, extractLogClustersFromHits already caps at 10
	// and aggregates per-signature; the outer map merges across calls (first wins).
	const clustersBySignature = new Map<string, ElasticLogCluster>();

	for (const o of outputs) {
		if (o.toolName !== "elasticsearch_search") continue;

		// SIO-787: APM branch must run alongside (not instead of) the synthetic
		// branch. Detection is strict per spec risk register: route to APM only
		// when toolArgs.index matches /traces-apm/i OR the response payload
		// contains a `by_service.buckets` aggregation shape.
		const apmByIndex = looksLikeApmIndex(o);
		// SIO-788: logs branch uses the same alongside model. Strict detection:
		// `/logs-/i` index hint OR majority-error hits, with explicit exclusion
		// when the index points to APM or synthetics (mutual exclusion).
		const logsByIndex = looksLikeLogsIndex(o);
		const nonLogsIndex = looksLikeNonLogsIndex(o);

		// SIO-786: real elastic MCP returns multi-text-block content joined into
		// a string by tryParseJson's fall-through. Detect string rawJson and
		// route to the text-block parser; otherwise keep the JSON-envelope path.
		if (typeof o.rawJson === "string") {
			if (apmByIndex || o.rawJson.includes("by_service")) {
				for (const svc of parseApmAggregationFromText(o.rawJson)) {
					if (apmByName.has(svc.serviceName)) continue;
					apmByName.set(svc.serviceName, svc);
				}
			}
			// SIO-786: parseSyntheticMonitorsFromText dedupes by monitor.id || name;
			// the outer monitorsByName dedupes across ToolOutput entries by name only.
			// Synthetic monitor names are unique in practice, so the asymmetry is benign;
			// revisit if two monitors with the same name but different ids ever surface.
			for (const m of parseSyntheticMonitorsFromText(o.rawJson)) {
				if (monitorsByName.has(m.name)) continue;
				monitorsByName.set(m.name, m);
			}
			// SIO-788: text-block paths for logs. Two real shapes have been seen:
			//   1. YAML-style "Document ID: ..." blocks (eu-b2b production shape,
			//      same family as Phase A's synthetic monitor response).
			//   2. Bare JSON envelope with prefix sentence (defensive fallback).
			// Only fires when the index hint suggests logs and the content does
			// not look like an APM aggregation envelope (handled above).
			if (logsByIndex && !nonLogsIndex && !o.rawJson.includes("by_service")) {
				const blockHits = parseLogClustersFromBlockText(o.rawJson);
				const jsonHits = blockHits.length > 0 ? [] : parseLogsHitsFromText(o.rawJson);
				const hits = blockHits.length > 0 ? blockHits : jsonHits;
				for (const cluster of extractLogClustersFromHits(hits)) {
					if (clustersBySignature.has(cluster.signature)) continue;
					clustersBySignature.set(cluster.signature, cluster);
				}
			}
			continue;
		}

		// JSON-envelope path: try APM first (when index hints) then synthetic.
		if (apmByIndex) {
			for (const svc of parseApmAggregationFromJson(o.rawJson)) {
				if (apmByName.has(svc.serviceName)) continue;
				apmByName.set(svc.serviceName, svc);
			}
			continue;
		}

		const parsed = SearchResponseSchema.safeParse(o.rawJson);
		if (!parsed.success) continue;
		const hits = parsed.data.hits.hits;

		// SIO-788: logs branch — fire when the index hint matches /logs-/i, or
		// when no APM/synthetics hint is present AND a majority of hits carry
		// `level: "error"`. Explicit exclusion guards against false positives
		// when the index clearly points elsewhere.
		const wantLogs = !nonLogsIndex && (logsByIndex || (!looksLikeSyntheticIndex(o) && logsHitsErrorMajority(hits)));
		if (wantLogs) {
			for (const cluster of extractLogClustersFromHits(hits)) {
				if (clustersBySignature.has(cluster.signature)) continue;
				clustersBySignature.set(cluster.signature, cluster);
			}
			// A logs-branch hit consumes this output; do not also attempt the
			// synthetic branch on the same payload.
			continue;
		}

		// Heuristic: if the search wasn't against synthetics, the hits won't have
		// the monitor.status shape and the inner safeParse will skip them.
		const wantSynthetic = looksLikeSyntheticIndex(o) || hits.length > 0;
		if (!wantSynthetic) continue;
		for (const hit of hits) {
			const source = SyntheticHitSourceSchema.safeParse(hit._source);
			if (!source.success) continue;
			// Only keep the most recent doc per monitor name (responses are typically
			// sorted by @timestamp desc; first wins).
			if (monitorsByName.has(source.data.monitor.name)) continue;
			monitorsByName.set(source.data.monitor.name, {
				name: source.data.monitor.name,
				status: source.data.monitor.status,
				...(source.data.url?.full ? { url: source.data.url.full } : {}),
				...(source.data["@timestamp"] ? { observedAt: source.data["@timestamp"] } : {}),
				...(source.data.observer?.geo?.name ? { geo: source.data.observer.geo.name } : {}),
			});
		}
	}

	const findings: ElasticFindings = {};
	if (monitorsByName.size > 0) findings.syntheticMonitors = Array.from(monitorsByName.values());
	if (apmByName.size > 0) findings.apmServices = Array.from(apmByName.values());
	if (clustersBySignature.size > 0) {
		// SIO-788: outer top-10 cap. Each ToolOutput contributes up to 10 clusters;
		// when multiple outputs feed in, sort the merged set and cap at 10.
		const all = Array.from(clustersBySignature.values()).sort((a, b) => b.count - a.count);
		findings.logClusters = all.slice(0, 10);
	}
	return findings;
}
