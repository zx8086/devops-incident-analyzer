// packages/agent/src/landing-zone/topology-projection.ts

import {
	type LandingZoneTopology,
	LandingZoneTopologySchema,
	type LandingZoneTopologySource,
	type TopologyDiagramView,
	type TopologyVisualState,
} from "@devops-agent/shared";
import { z } from "zod";
import {
	type LandingZoneTopologyEntity,
	LandingZoneTopologyEntitySchema,
	type LandingZoneTopologyRelationship,
	LandingZoneTopologyRelationshipSchema,
	TopologyProvenanceSchema,
} from "./topology-extractor.ts";
import type { ReconciledTopology, ReconciledTopologyFact } from "./topology-reconcile.ts";

const NETWORK_KINDS = new Set<LandingZoneTopologyEntity["kind"]>([
	"aws-organization",
	"organizational-unit",
	"aws-account",
	"region",
	"availability-zone",
	"vpc",
	"subnet",
	"route-table",
	"route",
	"internet-gateway",
	"nat-gateway",
	"transit-gateway",
	"core-network",
	"network-attachment",
	"vpc-endpoint",
	"network-acl",
	"cidr-block",
]);
const DNS_KINDS = new Set<LandingZoneTopologyEntity["kind"]>([
	"aws-account",
	"region",
	"vpc",
	"vpc-endpoint",
	"hosted-zone",
	"dns-record",
	"load-balancer",
	"resolver-endpoint",
	"resolver-rule",
	"dns-firewall-rule-group",
	"ip-address",
]);
const PATH_KINDS = new Set([...NETWORK_KINDS, ...DNS_KINDS]);
const TRAVERSAL_LEAVES = new Set<LandingZoneTopologyEntity["kind"]>([
	"aws-account",
	"region",
	"availability-zone",
	"internet-gateway",
	"nat-gateway",
	"transit-gateway",
	"core-network",
	"vpc-endpoint",
	"network-acl",
	"hosted-zone",
	"load-balancer",
	"ip-address",
	"cidr-block",
]);

const LEGEND: LandingZoneTopology["legend"] = [
	{ state: "confirmed", label: "Confirmed", description: "Desired state confirmed by observed evidence." },
	{ state: "proposed", label: "Proposed", description: "Open merge-request evidence; rendered with dashed links." },
	{ state: "drift", label: "Drift", description: "Desired and observed evidence differ or conflict." },
	{ state: "unverified", label: "Unverified", description: "Required live evidence is missing or unavailable." },
];

export interface LandingZoneTopologyProjectionOptions {
	view: TopologyDiagramView;
	accountId?: string;
	vpcId?: string;
	hostname?: string;
	maxNodes?: number;
	generatedAt?: string;
}

const ReconciledFactMetadataSchema = z
	.object({
		id: z.string().min(1),
		provenance: z.array(TopologyProvenanceSchema).min(1),
		reconciliation: z
			.object({
				status: z.enum(["aligned", "drifted", "pending", "unknown", "conflicting-evidence"]),
				confidence: z.enum(["verified", "unverified"]),
			})
			.strict(),
		validFrom: z.string().min(1),
		validTo: z.string().min(1).optional(),
		observedAt: z.string().min(1).optional(),
		consecutiveMisses: z.number().int().nonnegative(),
	})
	.strict();

function textPayload(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value !== "object" || value === null) return undefined;
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const text = (block as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	return undefined;
}

export interface ReconciledTopologyToolPage {
	topology: ReconciledTopology;
	rowCount: number;
}

export function parseReconciledTopologyToolPage(value: unknown): ReconciledTopologyToolPage {
	const text = textPayload(value);
	if (!text) return { topology: { entities: [], relationships: [] }, rowCount: 0 };
	let rows: unknown;
	try {
		rows = JSON.parse(text);
	} catch {
		return { topology: { entities: [], relationships: [] }, rowCount: 0 };
	}
	if (!Array.isArray(rows)) return { topology: { entities: [], relationships: [] }, rowCount: 0 };
	const topology: ReconciledTopology = { entities: [], relationships: [] };
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const rawPayload = (row as { payload?: unknown }).payload;
		let payload: unknown = rawPayload;
		if (typeof rawPayload === "string") {
			try {
				payload = JSON.parse(rawPayload);
			} catch {
				continue;
			}
		}
		if (typeof payload !== "object" || payload === null) continue;
		const record = payload as Record<string, unknown>;
		const metadata = ReconciledFactMetadataSchema.safeParse({
			id: record.id,
			provenance: record.provenance,
			reconciliation: record.reconciliation,
			validFrom: record.validFrom,
			validTo: record.validTo,
			observedAt: record.observedAt,
			consecutiveMisses: record.consecutiveMisses,
		});
		if (!metadata.success) continue;
		const factRecord = record.fact;
		const isRelationship =
			typeof factRecord === "object" && factRecord !== null && "from" in factRecord && "to" in factRecord;
		if (isRelationship) {
			const fact = LandingZoneTopologyRelationshipSchema.safeParse(factRecord);
			if (fact.success) topology.relationships.push({ ...metadata.data, fact: fact.data });
		} else {
			const fact = LandingZoneTopologyEntitySchema.safeParse(factRecord);
			if (fact.success) topology.entities.push({ ...metadata.data, fact: fact.data });
		}
	}
	return { topology, rowCount: rows.length };
}

export function parseReconciledTopologyToolResult(value: unknown): ReconciledTopology {
	return parseReconciledTopologyToolPage(value).topology;
}

function visualState<T extends LandingZoneTopologyEntity | LandingZoneTopologyRelationship>(
	fact: ReconciledTopologyFact<T>,
): TopologyVisualState {
	if (fact.reconciliation.status === "drifted" || fact.reconciliation.status === "conflicting-evidence") return "drift";
	if (fact.reconciliation.status === "pending" || fact.provenance.some((item) => item.state === "proposed"))
		return "proposed";
	if (fact.reconciliation.status === "unknown" || fact.reconciliation.confidence === "unverified") return "unverified";
	return "confirmed";
}

function sourceId(provenance: ReconciledTopologyFact<LandingZoneTopologyEntity>["provenance"][number]): string {
	const identity = [
		provenance.source,
		provenance.repository,
		provenance.filePath,
		provenance.commitSha,
		provenance.terraformAddress,
		provenance.resourceId,
		provenance.mergeRequestUrl,
	]
		.filter(Boolean)
		.join(":");
	return `source:${provenance.source}:${Bun.hash(identity).toString(16)}`;
}

function sourceUrl(
	provenance: ReconciledTopologyFact<LandingZoneTopologyEntity>["provenance"][number],
): string | undefined {
	if (provenance.mergeRequestUrl)
		return provenance.mergeRequestUrl.length <= 2_048 ? provenance.mergeRequestUrl : undefined;
	if (!provenance.repository || !provenance.commitSha || !provenance.filePath) return undefined;
	const path = provenance.filePath
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	const url = `https://gitlab.com/${provenance.repository}/-/blob/${encodeURIComponent(provenance.commitSha)}/${path}`;
	return url.length <= 2_048 ? url : undefined;
}

function collectSources(
	facts: Array<ReconciledTopologyFact<LandingZoneTopologyEntity | LandingZoneTopologyRelationship>>,
): LandingZoneTopologySource[] {
	const sources = new Map<string, LandingZoneTopologySource>();
	for (const fact of facts)
		for (const provenance of fact.provenance) {
			const id = sourceId(provenance);
			if (!id || sources.has(id)) continue;
			const location =
				[provenance.repository, provenance.filePath, provenance.terraformAddress].filter(Boolean).join(" / ") ||
				provenance.resourceId ||
				provenance.mergeRequestUrl ||
				provenance.source;
			const url = sourceUrl(provenance);
			sources.set(id, {
				id,
				label: `${provenance.source}: ${location}`.slice(0, 512),
				...(url && { url }),
				state: provenance.state,
			});
		}
	return [...sources.values()].sort((left, right) => left.id.localeCompare(right.id)).slice(0, 100);
}

function entityLabel(entity: LandingZoneTopologyEntity): string {
	return (entity.name?.trim() || entity.id).slice(0, 160);
}

function entityDetail(entity: LandingZoneTopologyEntity): string | undefined {
	const details = [
		entity.accountId ? `account ${entity.accountId}` : undefined,
		entity.region ? `region ${entity.region}` : undefined,
		...Object.entries(entity.properties)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, value]) => `${key} ${String(value)}`),
	].filter((value): value is string => Boolean(value));
	return details.length > 0 ? details.join("; ").slice(0, 2_048) : undefined;
}

function mermaidEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/[\r\n]+/g, " ");
}

function humanize(value: string): string {
	return value.replace(/-/g, " ");
}

function selectConnected(
	startIds: Set<string>,
	entities: Map<string, ReconciledTopologyFact<LandingZoneTopologyEntity>>,
	relationships: ReconciledTopologyFact<LandingZoneTopologyRelationship>[],
): Set<string> {
	const selected = new Set(startIds);
	const queue = [...startIds].sort();
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;
		const currentKind = entities.get(current)?.fact.kind;
		if (currentKind && TRAVERSAL_LEAVES.has(currentKind)) continue;
		for (const relationship of relationships) {
			const next =
				relationship.fact.from === current
					? relationship.fact.to
					: relationship.fact.to === current
						? relationship.fact.from
						: undefined;
			if (!next || selected.has(next) || !entities.has(next)) continue;
			selected.add(next);
			queue.push(next);
		}
	}
	return selected;
}

function selectEntityIds(
	entities: Map<string, ReconciledTopologyFact<LandingZoneTopologyEntity>>,
	relationships: ReconciledTopologyFact<LandingZoneTopologyRelationship>[],
	options: LandingZoneTopologyProjectionOptions,
): Set<string> {
	if (options.vpcId) return selectConnected(new Set([options.vpcId]), entities, relationships);
	if (options.hostname) {
		const hostname = options.hostname.toLowerCase();
		const starts = new Set(
			[...entities.values()]
				.filter(
					(item) =>
						item.fact.kind === "dns-record" &&
						(item.fact.name?.toLowerCase() === hostname || item.fact.id.toLowerCase() === hostname),
				)
				.map((item) => item.fact.id),
		);
		return selectConnected(starts, entities, relationships);
	}
	if (options.accountId) {
		const selected = new Set(
			[...entities.values()]
				.filter(
					(item) =>
						item.fact.accountId === options.accountId ||
						(item.fact.kind === "aws-account" && item.fact.id === options.accountId),
				)
				.map((item) => item.fact.id),
		);
		for (const relationship of relationships) {
			if (relationship.fact.kind !== "account-owns-vpc") continue;
			if (selected.has(relationship.fact.from)) selected.add(relationship.fact.to);
		}
		for (const relationship of relationships) {
			const fromSelected = selected.has(relationship.fact.from);
			const toSelected = selected.has(relationship.fact.to);
			if (fromSelected === toSelected) continue;
			const candidate = entities.get(fromSelected ? relationship.fact.to : relationship.fact.from);
			if (candidate && !candidate.fact.accountId) selected.add(candidate.fact.id);
		}
		return selected;
	}
	return new Set(entities.keys());
}

function renderMermaid(nodes: LandingZoneTopology["nodes"], edges: LandingZoneTopology["edges"]): string {
	const aliases = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
	const lines = ["flowchart LR"];
	for (const node of nodes) lines.push(`  ${aliases.get(node.id)}["${mermaidEscape(node.label)}"]`);
	for (const edge of edges) {
		const from = aliases.get(edge.from);
		const to = aliases.get(edge.to);
		if (!from || !to) continue;
		const arrow =
			edge.visualState === "proposed" || edge.visualState === "unverified"
				? "-.->"
				: edge.visualState === "drift"
					? "==>"
					: "-->";
		lines.push(`  ${from} ${arrow}|${mermaidEscape(edge.label ?? humanize(edge.kind))}| ${to}`);
	}
	lines.push("  classDef confirmed fill:#e8f5ee,stroke:#2e8b57,color:#163d28");
	lines.push("  classDef proposed fill:#eef6fb,stroke:#166c96,stroke-dasharray:5 4,color:#02154e");
	lines.push("  classDef drift fill:#fff1f2,stroke:#d61233,stroke-width:2px,color:#7f1d1d");
	lines.push("  classDef unverified fill:#f3f4f6,stroke:#9ca3af,stroke-dasharray:3 3,color:#4b5563");
	for (const node of nodes) lines.push(`  class ${aliases.get(node.id)} ${node.visualState}`);
	return lines.join("\n");
}

export function projectLandingZoneTopology(
	topology: ReconciledTopology,
	options: LandingZoneTopologyProjectionOptions,
): LandingZoneTopology {
	const maxNodes = Math.min(200, Math.max(1, options.maxNodes ?? 80));
	const kinds = options.view === "network" ? NETWORK_KINDS : options.view === "dns" ? DNS_KINDS : PATH_KINDS;
	const currentEntities = topology.entities
		.filter((item) => !item.validTo && kinds.has(item.fact.kind))
		.sort((left, right) => left.fact.kind.localeCompare(right.fact.kind) || left.fact.id.localeCompare(right.fact.id));
	const entityMap = new Map(currentEntities.map((item) => [item.fact.id, item]));
	const currentRelationships = topology.relationships
		.filter((item) => !item.validTo && entityMap.has(item.fact.from) && entityMap.has(item.fact.to))
		.sort((left, right) => left.fact.kind.localeCompare(right.fact.kind) || left.fact.id.localeCompare(right.fact.id));
	const selectedIds = selectEntityIds(entityMap, currentRelationships, options);
	const selectedEntities = currentEntities.filter((item) => selectedIds.has(item.fact.id));
	const keptEntities = selectedEntities.slice(0, maxNodes);
	const keptIds = new Set(keptEntities.map((item) => item.fact.id));
	const selectedRelationships = currentRelationships.filter(
		(item) => selectedIds.has(item.fact.from) && selectedIds.has(item.fact.to),
	);
	const keptRelationships = selectedRelationships
		.filter((item) => keptIds.has(item.fact.from) && keptIds.has(item.fact.to))
		.slice(0, 400);
	const sources = collectSources([...keptEntities, ...keptRelationships]);
	const sourceIds = new Set(sources.map((source) => source.id));
	const nodes: LandingZoneTopology["nodes"] = keptEntities.map((item) => {
		const detail = entityDetail(item.fact);
		return {
			id: item.fact.id,
			kind: item.fact.kind,
			label: entityLabel(item.fact),
			...(detail && { detail }),
			visualState: visualState(item),
			sourceIds: item.provenance
				.map(sourceId)
				.filter((id) => sourceIds.has(id))
				.sort()
				.slice(0, 20),
		};
	});
	const edges: LandingZoneTopology["edges"] = keptRelationships.map((item) => ({
		id: item.fact.id,
		from: item.fact.from,
		to: item.fact.to,
		kind: item.fact.kind,
		label: humanize(item.fact.kind),
		visualState: visualState(item),
		sourceIds: item.provenance
			.map(sourceId)
			.filter((id) => sourceIds.has(id))
			.sort()
			.slice(0, 20),
	}));
	const counts = nodes.reduce<Record<TopologyVisualState, number>>(
		(accumulator, node) => {
			accumulator[node.visualState] += 1;
			return accumulator;
		},
		{ confirmed: 0, proposed: 0, drift: 0, unverified: 0 },
	);
	const focus = options.hostname ?? options.vpcId;
	const title =
		options.view === "network"
			? "Account network topology"
			: options.view === "dns"
				? "DNS resolution topology"
				: "DNS and route path";
	const summary = `${nodes.length} nodes and ${edges.length} relationships. ${counts.confirmed} confirmed, ${counts.proposed} proposed, ${counts.drift} drifted, ${counts.unverified} unverified.`;
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const text = [
		...nodes.map((node) =>
			`${node.label} [${humanize(node.kind)}] ${node.visualState}${node.detail ? `; ${node.detail}` : ""}`.slice(
				0,
				2_048,
			),
		),
		...edges.map(
			(edge) =>
				`${byId.get(edge.from)?.label ?? edge.from} -> ${byId.get(edge.to)?.label ?? edge.to} [${edge.label}; ${edge.visualState}]`,
		),
	].slice(0, 400);
	return LandingZoneTopologySchema.parse({
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		title,
		summary,
		...(options.accountId && { accountId: options.accountId }),
		...(focus && { focus }),
		nodes,
		edges,
		sources,
		legend: LEGEND,
		text,
		mermaid: renderMermaid(nodes, edges),
		// Keep the accessible alternative honest when its combined 400-line cap
		// is reached before the independently bounded visual collections.
		truncated:
			selectedEntities.length > keptEntities.length ||
			selectedRelationships.length > keptRelationships.length ||
			nodes.length + edges.length > text.length,
	});
}
