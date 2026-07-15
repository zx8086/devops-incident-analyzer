// packages/agent/src/resolve-identifiers-parsers.ts
//
// SIO-1084: pure parsers for each datasource's enumeration ("where to look") probe
// response. MCP-free and clock-free so they can be unit-tested against the exact
// upstream text/JSON shapes. Each takes the already-normalizeToolContent'd string
// (or parsed JSON) and returns plain identifiers; every parser is defensive and
// returns an empty result on any shape drift rather than throwing.

// Find the first JSON object/array in a normalized string and parse it. Returns
// null when there is no parseable JSON (e.g. the elastic agg's leading text block).
function firstJson(normalized: string): unknown {
	const objStart = normalized.indexOf("{");
	const arrStart = normalized.indexOf("[");
	const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
	if (start === -1) return null;
	try {
		return JSON.parse(normalized.slice(start));
	} catch {
		return null;
	}
}

// ELASTIC: elasticsearch_search size:0 renders as two text blocks joined by
// normalizeToolContent: "Search results with aggregations (N total hits, Xms):"
// then the aggregations JSON. Extract the by_service (or any) terms-agg bucket keys.
export function parseElasticServiceAgg(normalized: string): string[] {
	const parsed = firstJson(normalized);
	if (!parsed || typeof parsed !== "object") return [];
	const keys = collectBucketKeys(parsed as Record<string, unknown>);
	return dedupe(keys);
}

function collectBucketKeys(node: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const value of Object.values(node)) {
		if (!value || typeof value !== "object") continue;
		const buckets = (value as Record<string, unknown>).buckets;
		if (Array.isArray(buckets)) {
			for (const b of buckets) {
				const key = b && typeof b === "object" ? (b as Record<string, unknown>).key : undefined;
				if (typeof key === "string") out.push(key);
			}
		}
		// recurse for nested aggs
		out.push(...collectBucketKeys(value as Record<string, unknown>));
	}
	return out;
}

// COUCHBASE: capella_get_scopes_and_collections returns a text tree with a
// "[folder icon] Scope: <name>" line per scope and an indented
// "[page icon] Collection: <name>" line per collection ("(No collections)" for
// empty scopes). Match on the "Scope:" / "Collection:" substrings (not the
// leading glyph bytes) so the parser survives whitespace/glyph drift.
export function parseCouchbaseScopeTree(normalized: string): Record<string, string[]> {
	const scopes: Record<string, string[]> = {};
	let current: string | null = null;
	for (const rawLine of normalized.split("\n")) {
		const line = rawLine.trim();
		const scopeMatch = line.match(/(?:^|\s)Scope:\s*(.+)$/);
		if (scopeMatch?.[1]) {
			current = scopeMatch[1].trim();
			if (current && !(current in scopes)) scopes[current] = [];
			continue;
		}
		const collectionMatch = line.match(/Collection:\s*(.+)$/);
		if (collectionMatch?.[1] && current) {
			const list = scopes[current] ?? [];
			list.push(collectionMatch[1].trim());
			scopes[current] = list;
		}
		// "(No collections)" lines are ignored; the scope stays with an empty array.
	}
	return scopes;
}

// COUCHBASE (SIO-1087): capella_get_system_indexes returns the executeAnalysisQuery markdown --
// a fenced ```json block wrapping an array of system:indexes rows. Each row has keyspace_id
// (collection), scope_id, bucket_id, name, is_primary (true only for a primary index),
// index_key (backtick-wrapped field expressions), and state ("online"|"deferred"|...).
//
// SIO-1088: the crucial distinction (validated live against seasons.dates): "has an ONLINE index"
// is NOT the same as "supports SELECT *". A bare SELECT * needs a PRIMARY index; a collection with
// only SECONDARY (GSI) indexes rejects SELECT * with "no index available" (code 4000) but IS
// queryable via a WHERE clause that LEADS on the index's first key field. So per collection we
// capture whether it has a primary index and the union of secondary index-key FIELD names (so the
// focus block can tell the agent exactly which fields to filter on). Only ONLINE indexes count.
// Defensive: returns {} on any shape drift.
export interface CollectionIndexInfo {
	hasPrimary: boolean;
	// Field names appearing as index keys across the collection's ONLINE secondary indexes, in
	// first-seen order (leading keys first). Function expressions (e.g. concat2(...)) are dropped --
	// only plain field names, since those are what a WHERE predicate can filter on.
	secondaryKeyFields: string[];
}

// scope -> collection -> index info.
export type CouchbaseIndexMap = Record<string, Record<string, CollectionIndexInfo>>;

// Pull plain field names out of an index_key array, preserving order and dropping function exprs.
// e.g. ['`styleSeasonCodeFms`', '`divisionCode`', 'concat2("_", ...)'] -> ['styleSeasonCodeFms','divisionCode']
function extractKeyFields(indexKey: unknown): string[] {
	if (!Array.isArray(indexKey)) return [];
	const fields: string[] = [];
	for (const raw of indexKey) {
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim();
		// A plain field key is backtick-wrapped: `fieldName`. The real disambiguator is "is this a
		// function/expression, not a field" -- so accept ANY backtick-wrapped name and reject only
		// keys containing "(" (a function/expression like concat2(...)). This preserves legitimate
		// field names that need escaping for other reasons (hyphens, spaces, leading digit) rather
		// than silently dropping them -- a dropped LEADING key would misdirect the WHERE guidance.
		const m = trimmed.match(/^`([^`]+)`$/);
		if (m?.[1] && !m[1].includes("(")) fields.push(m[1]);
	}
	return fields;
}

export function parseCouchbaseSystemIndexes(normalized: string): CouchbaseIndexMap {
	// executeAnalysisQuery wraps rows in a ```json fenced block after a "# Title" heading and
	// followed by "## Query Execution Details" -- firstJson's slice-to-end would include the
	// closing fence and trailing prose and fail to parse. Extract the fenced block first.
	const fence = normalized.match(/```json\s*([\s\S]*?)```/);
	let parsed: unknown = null;
	if (fence?.[1]) {
		try {
			parsed = JSON.parse(fence[1].trim());
		} catch {
			parsed = null;
		}
	}
	if (parsed == null) parsed = firstJson(normalized);
	// The rows live under t.* -> flat row objects; the outer parse may be an array of rows.
	const rows: unknown[] = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
	const map: CouchbaseIndexMap = {};
	for (const row of rows) {
		if (!row || typeof row !== "object") continue;
		const r = row as Record<string, unknown>;
		const scope = typeof r.scope_id === "string" ? r.scope_id : undefined;
		const collection = typeof r.keyspace_id === "string" ? r.keyspace_id : undefined;
		const state = typeof r.state === "string" ? r.state : undefined;
		// A collection-level index has BOTH scope_id and keyspace_id; skip bucket-level primary
		// indexes (scope_id null). Only ONLINE indexes make a collection queryable.
		if (!scope || !collection || state !== "online") continue;
		const scopeMap = map[scope] ?? {};
		map[scope] = scopeMap;
		const info = scopeMap[collection] ?? { hasPrimary: false, secondaryKeyFields: [] };
		scopeMap[collection] = info;
		if (r.is_primary === true) {
			info.hasPrimary = true;
			continue;
		}
		for (const f of extractKeyFields(r.index_key)) {
			if (!info.secondaryKeyFields.includes(f)) info.secondaryKeyFields.push(f);
		}
	}
	return map;
}

// AWS: aws_logs_describe_log_groups returns { logGroups: [{ logGroupName, ... }] }
// OR { _error: { kind } } as a successful payload. Accepts the parsed JSON.
export function parseAwsLogGroups(json: unknown): { logGroups: string[]; error?: string } {
	if (!json || typeof json !== "object") return { logGroups: [] };
	const obj = json as Record<string, unknown>;
	const err = obj._error;
	if (err && typeof err === "object") {
		const kind = (err as Record<string, unknown>).kind;
		return { logGroups: [], error: typeof kind === "string" ? kind : "unknown" };
	}
	const groups = obj.logGroups;
	if (!Array.isArray(groups)) return { logGroups: [] };
	const names = groups
		.map((g) => (g && typeof g === "object" ? (g as Record<string, unknown>).logGroupName : undefined))
		.filter((n): n is string => typeof n === "string");
	return { logGroups: dedupe(names) };
}

// AWS ECS: aws_ecs_list_services returns { serviceArns: [arn, ...] }. Return the
// last ARN segment (the service name) for readable matching.
export function parseAwsEcsServiceArns(json: unknown): string[] {
	if (!json || typeof json !== "object") return [];
	const arns = (json as Record<string, unknown>).serviceArns;
	if (!Array.isArray(arns)) return [];
	const names = arns.filter((a): a is string => typeof a === "string").map((a) => a.split("/").pop() ?? a);
	return dedupe(names);
}

// KAFKA topics: kafka_list_topics returns { topics: [{ name }], ... }.
export function parseKafkaTopics(json: unknown): string[] {
	if (!json || typeof json !== "object") return [];
	const topics = (json as Record<string, unknown>).topics;
	if (!Array.isArray(topics)) return [];
	const names = topics
		.map((t) => (t && typeof t === "object" ? (t as Record<string, unknown>).name : t))
		.filter((n): n is string => typeof n === "string");
	return dedupe(names);
}

// KAFKA consumer groups: kafka_list_consumer_groups returns an array of
// { id, state, ... } rows (or { groupId } shapes on some providers).
export function parseKafkaConsumerGroups(json: unknown): string[] {
	if (!Array.isArray(json)) return [];
	const ids = json
		.map((g) => {
			if (typeof g === "string") return g;
			if (g && typeof g === "object") {
				const rec = g as Record<string, unknown>;
				const id = rec.id ?? rec.groupId;
				return typeof id === "string" ? id : undefined;
			}
			return undefined;
		})
		.filter((s): s is string => typeof s === "string");
	return dedupe(ids);
}

export interface KonnectControlPlane {
	controlPlaneId: string;
	name?: string;
}

// KONNECT control planes: konnect_list_control_planes returns
// { controlPlanes: [{ controlPlaneId, name }] }.
export function parseKonnectControlPlanes(json: unknown): KonnectControlPlane[] {
	if (!json || typeof json !== "object") return [];
	const cps = (json as Record<string, unknown>).controlPlanes;
	if (!Array.isArray(cps)) return [];
	const out: KonnectControlPlane[] = [];
	for (const cp of cps) {
		if (!cp || typeof cp !== "object") continue;
		const rec = cp as Record<string, unknown>;
		const id = rec.controlPlaneId ?? rec.id;
		if (typeof id === "string") {
			out.push({ controlPlaneId: id, name: typeof rec.name === "string" ? rec.name : undefined });
		}
	}
	return out;
}

// KONNECT services: konnect_list_services returns { services: [{ serviceId, name }] }.
export function parseKonnectServices(json: unknown): Array<{ serviceId: string; name?: string }> {
	if (!json || typeof json !== "object") return [];
	const services = (json as Record<string, unknown>).services;
	if (!Array.isArray(services)) return [];
	const out: Array<{ serviceId: string; name?: string }> = [];
	for (const s of services) {
		if (!s || typeof s !== "object") continue;
		const rec = s as Record<string, unknown>;
		const id = rec.serviceId ?? rec.id;
		if (typeof id === "string") {
			out.push({ serviceId: id, name: typeof rec.name === "string" ? rec.name : undefined });
		}
	}
	return out;
}

export interface GitlabProject {
	id: string;
	pathWithNamespace?: string;
	name?: string;
}

// GITLAB: gitlab_search scope=projects returns an array of project rows. The
// numeric `id` is the identifier the sub-agent needs (guessing the path 404s), so
// we lift it as a string.
export function parseGitlabProjects(json: unknown): GitlabProject[] {
	const rows = Array.isArray(json) ? json : [];
	const out: GitlabProject[] = [];
	for (const r of rows) {
		if (!r || typeof r !== "object") continue;
		const rec = r as Record<string, unknown>;
		if (rec.id === undefined || rec.id === null) continue;
		out.push({
			id: String(rec.id),
			pathWithNamespace: typeof rec.path_with_namespace === "string" ? rec.path_with_namespace : undefined,
			name: typeof rec.name === "string" ? rec.name : undefined,
		});
	}
	return out;
}

// SIO-1096: parseAtlassianProjects / parseAtlassianSpaces (and their parseKeyedRows helper) were
// removed with the atlassian resolveIdentifiers probe -- Jira projects are named by team/org, not
// service, so name-matching resolved nothing. The atlassian sub-agent searches by domain terms.

// SIO-1104 (5a): topology-sweep parsers.

// Recursive search for a named property anywhere in the parsed response -- the
// aggregations block's nesting depth varies with the search-tool envelope.
function findProp(node: Record<string, unknown>, name: string): unknown {
	if (name in node) return node[name];
	for (const value of Object.values(node)) {
		if (!value || typeof value !== "object") continue;
		const found = findProp(value as Record<string, unknown>, name);
		if (found !== undefined) return found;
	}
	return undefined;
}

// ELASTIC APM: the topology sweep's service_destination agg -- by_service (terms on
// service.name) x by_dest (terms on span.destination.service.resource). Takes the
// normalizeToolContent'd string (the search tool prefixes a text block). `services`
// carries EVERY by_service bucket key (a service with no outbound pairs is still a
// valid destination target for the P6 self-join).
export function parseApmServiceDestinationAgg(normalized: string): {
	pairs: Array<{ service: string; destination: string }>;
	services: string[];
	// True when a terms agg dropped buckets (sum_other_doc_count > 0) -- the
	// collection is INCOMPLETE and must not drive the staleness sweep (a dropped
	// service would otherwise accrue false misses).
	truncated: boolean;
} {
	const parsed = firstJson(normalized);
	if (!parsed || typeof parsed !== "object") return { pairs: [], services: [], truncated: false };
	const byService = findProp(parsed as Record<string, unknown>, "by_service");
	if (!byService || typeof byService !== "object") return { pairs: [], services: [], truncated: false };
	const buckets = (byService as Record<string, unknown>).buckets;
	if (!Array.isArray(buckets)) return { pairs: [], services: [], truncated: false };
	const otherCount = (node: Record<string, unknown>): number => {
		const n = node.sum_other_doc_count;
		return typeof n === "number" ? n : 0;
	};
	let truncated = otherCount(byService as Record<string, unknown>) > 0;
	const pairs: Array<{ service: string; destination: string }> = [];
	const services: string[] = [];
	for (const b of buckets) {
		if (!b || typeof b !== "object") continue;
		const rec = b as Record<string, unknown>;
		const service = typeof rec.key === "string" ? rec.key : undefined;
		if (!service) continue;
		services.push(service);
		const byDest = rec.by_dest;
		if (!byDest || typeof byDest !== "object") continue;
		if (otherCount(byDest as Record<string, unknown>) > 0) truncated = true;
		const destBuckets = (byDest as Record<string, unknown>).buckets;
		if (!Array.isArray(destBuckets)) continue;
		for (const d of destBuckets) {
			const key = d && typeof d === "object" ? (d as Record<string, unknown>).key : undefined;
			if (typeof key === "string" && key.length > 0) pairs.push({ service, destination: key });
		}
	}
	return { pairs, services: dedupe(services), truncated };
}

export interface KonnectRoute {
	routeId: string;
	paths: string[];
	serviceId?: string;
}

// KONNECT: konnect_list_routes returns { metadata: { capped, ... }, routes:
// [{ routeId, paths, serviceId, ... }] }. capped signals Kong's 100-row page cap
// hit -- the caller must treat the collection as incomplete.
export function parseKonnectRoutes(json: unknown): { routes: KonnectRoute[]; capped: boolean } {
	if (!json || typeof json !== "object") return { routes: [], capped: false };
	const obj = json as Record<string, unknown>;
	const meta = obj.metadata;
	const capped = meta && typeof meta === "object" ? (meta as Record<string, unknown>).capped === true : false;
	const rows = obj.routes;
	if (!Array.isArray(rows)) return { routes: [], capped };
	const routes: KonnectRoute[] = [];
	for (const r of rows) {
		if (!r || typeof r !== "object") continue;
		const rec = r as Record<string, unknown>;
		if (typeof rec.routeId !== "string") continue;
		const paths = Array.isArray(rec.paths) ? rec.paths.filter((p): p is string => typeof p === "string") : [];
		routes.push({
			routeId: rec.routeId,
			paths,
			serviceId: typeof rec.serviceId === "string" ? rec.serviceId : undefined,
		});
	}
	return { routes, capped };
}

// KAFKA: kafka_describe_consumer_group returns { groupId, state, members,
// offsets: [{ topic, partitions }] }. The committed-offset topics are the group's
// consumption set.
export function parseKafkaGroupTopics(json: unknown): string[] {
	if (!json || typeof json !== "object") return [];
	const offsets = (json as Record<string, unknown>).offsets;
	if (!Array.isArray(offsets)) return [];
	const topics = offsets
		.map((o) => (o && typeof o === "object" ? (o as Record<string, unknown>).topic : undefined))
		.filter((t): t is string => typeof t === "string" && t.length > 0);
	return dedupe(topics);
}

// AWS ECS: aws_ecs_list_clusters returns { clusterArns: [arn, ...] }.
export function parseAwsEcsClusterArns(json: unknown): string[] {
	if (!json || typeof json !== "object") return [];
	const arns = (json as Record<string, unknown>).clusterArns;
	if (!Array.isArray(arns)) return [];
	return dedupe(arns.filter((a): a is string => typeof a === "string"));
}

// AWS ECS: aws_ecs_list_services returns { serviceArns: [arn, ...] }. The topology
// sweep needs BOTH the full ARN (the AwsResource identity) and the short name (the
// P6 Service-name match), unlike parseAwsEcsServiceArns above which keeps names only.
export function parseAwsEcsServices(json: unknown): Array<{ arn: string; name: string }> {
	if (!json || typeof json !== "object") return [];
	const arns = (json as Record<string, unknown>).serviceArns;
	if (!Array.isArray(arns)) return [];
	const seen = new Set<string>();
	const out: Array<{ arn: string; name: string }> = [];
	for (const a of arns) {
		if (typeof a !== "string" || a.length === 0 || seen.has(a)) continue;
		seen.add(a);
		out.push({ arn: a, name: a.split("/").pop() ?? a });
	}
	return out;
}

function dedupe(items: string[]): string[] {
	return [...new Set(items)];
}
