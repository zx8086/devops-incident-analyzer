// agent/src/network-topology.ts
// SIO-1204: pure per-turn network-map builder. Parses the turn's toolOutputs[]
// (AWS network-path + ingress tools, plus the konnect/kafka/capella/elastic
// endpoint overlay) into the shared NetworkTopology shape. Called TWICE per turn
// because `aggregate` runs before `extractFindings`: once in aggregate for the
// prompt summary, once in extractFindings for the state slot + SSE event. Must
// therefore stay pure, cheap, and total: malformed outputs are skipped via
// safeParse, never thrown on. CIDR containment replaces the Neo4j-article
// query-time UDF: computed here (ipInCidr) and recorded as `derived` in-subnet
// edges; explicit SubnetId placement always wins over CIDR math.
import type {
	DataSourceResult,
	NetworkTopology,
	NetworkTopologyEdge,
	NetworkTopologyNode,
	ToolOutput,
} from "@devops-agent/shared";
import { ipInCidr, parseIpv4 } from "@devops-agent/shared";
import { z } from "zod";
import { matchesFocus } from "./correlation/focus-match.ts";

export const MAX_NODES = 200;
export const MAX_EDGES = 400;

const tags = z.array(z.object({ Key: z.string().optional(), Value: z.string().optional() })).optional();

function nameTag(t: z.infer<typeof tags>): string | undefined {
	return t?.find((x) => x.Key === "Name")?.Value;
}

// SIO-833: wrapListTool attaches a complete projected `_summary` when the primary
// list field was byte-truncated server-side. Prefer it (same rule as extractors/aws.ts).
function summaryRows(envelope: unknown): unknown[] | undefined {
	if (typeof envelope !== "object" || envelope === null) return undefined;
	const summary = (envelope as Record<string, unknown>)._summary;
	return Array.isArray(summary) ? summary : undefined;
}

function rows(envelope: unknown, listField: string): unknown[] {
	const summary = summaryRows(envelope);
	if (summary) return summary;
	if (typeof envelope !== "object" || envelope === null) return [];
	const primary = (envelope as Record<string, unknown>)[listField];
	return Array.isArray(primary) ? primary : [];
}

const VpcRow = z.object({ VpcId: z.string(), CidrBlock: z.string().optional(), Tags: tags });
const SubnetRow = z.object({
	SubnetId: z.string(),
	VpcId: z.string().optional(),
	CidrBlock: z.string().optional(),
	AvailabilityZone: z.string().optional(),
});
const EniRow = z.object({
	NetworkInterfaceId: z.string(),
	PrivateIpAddress: z.string().optional(),
	PrivateIpAddresses: z.array(z.object({ PrivateIpAddress: z.string().optional() })).optional(),
	SubnetId: z.string().optional(),
	Attachment: z.object({ InstanceId: z.string().optional() }).optional(),
	Description: z.string().optional(),
});
const InstanceRow = z.object({
	InstanceId: z.string(),
	PrivateIpAddress: z.string().optional(),
	SubnetId: z.string().optional(),
	Tags: tags,
});
const ReservationsEnvelope = z.object({
	Reservations: z.array(z.object({ Instances: z.array(z.unknown()).optional() })).optional(),
});
// ECS DescribeTasks is lowerCamelCase (unlike the PascalCase EC2/ELBv2 APIs).
const EcsTaskRow = z.object({
	taskArn: z.string(),
	group: z.string().optional(), // "service:<name>"
	attachments: z
		.array(
			z.object({
				type: z.string().optional(),
				details: z.array(z.object({ name: z.string().optional(), value: z.string().optional() })).optional(),
			}),
		)
		.optional(),
});
const LoadBalancerRow = z.object({
	LoadBalancerArn: z.string(),
	LoadBalancerName: z.string().optional(),
	DNSName: z.string().optional(),
	Type: z.string().optional(),
	Scheme: z.string().optional(),
	AvailabilityZones: z.array(z.object({ SubnetId: z.string().optional(), ZoneName: z.string().optional() })).optional(),
});
const ListenerRow = z.object({
	LoadBalancerArn: z.string().optional(),
	Port: z.number().optional(),
	Protocol: z.string().optional(),
	DefaultActions: z.array(z.object({ TargetGroupArn: z.string().optional() })).optional(),
});
const TargetGroupRow = z.object({
	TargetGroupArn: z.string(),
	TargetGroupName: z.string().optional(),
	Port: z.number().optional(),
	Protocol: z.string().optional(),
	LoadBalancerArns: z.array(z.string()).optional(),
});
// SIO-1204: the tool echoes the requested TargetGroupArn into its envelope (the
// SDK response omits it and ToolOutput carries no request args).
const TargetHealthEnvelope = z.object({
	TargetGroupArn: z.string().optional(),
	TargetHealthDescriptions: z
		.array(
			z.object({
				Target: z.object({ Id: z.string().optional(), Port: z.number().optional() }).optional(),
				TargetHealth: z.object({ State: z.string().optional() }).optional(),
			}),
		)
		.optional(),
});
const RecordSetRow = z.object({
	Name: z.string(),
	Type: z.string(),
	AliasTarget: z.object({ DNSName: z.string().optional() }).optional(),
	ResourceRecords: z.array(z.object({ Value: z.string().optional() })).optional(),
});
const KongServiceRow = z.object({
	name: z.string().optional(),
	host: z.string().optional(),
	port: z.number().optional(),
	protocol: z.string().optional(),
});
const KafkaClusterEnvelope = z.object({
	brokers: z
		.array(
			z.object({
				nodeId: z.number().optional(),
				id: z.number().optional(),
				host: z.string().optional(),
				port: z.number().optional(),
				rack: z.string().nullable().optional(),
			}),
		)
		.optional(),
});
const ElasticNodesEnvelope = z.object({
	nodes: z.record(z.string(), z.unknown()).optional(),
});
const ElasticNodeRow = z.object({
	name: z.string().optional(),
	host: z.string().optional(),
	ip: z.string().optional(),
	transport_address: z.string().optional(),
});

interface Accumulator {
	nodes: Map<string, NetworkTopologyNode>;
	edges: Map<string, NetworkTopologyEdge>;
	sources: Set<string>;
}

// Merge-not-clobber: a later sighting of the same node (e.g. an LB from both
// describe_load_balancers and a listener stub) fills gaps without erasing fields.
function upsertNode(acc: Accumulator, node: NetworkTopologyNode): void {
	const existing = acc.nodes.get(node.id);
	if (!existing) {
		acc.nodes.set(node.id, node);
		return;
	}
	const merged: NetworkTopologyNode = { ...existing };
	for (const [k, v] of Object.entries(node)) {
		if (v === undefined) continue;
		const key = k as keyof NetworkTopologyNode;
		if (key === "privateIps") {
			const ips = new Set([...(existing.privateIps ?? []), ...(node.privateIps ?? [])]);
			merged.privateIps = Array.from(ips);
		} else if (merged[key] === undefined) {
			(merged as Record<string, unknown>)[key] = v;
		}
	}
	acc.nodes.set(node.id, merged);
}

// Merge-not-clobber (same rule as upsertNode): the listener pass records
// routes-to with a protocol:port detail, and the later target-groups pass must
// not erase it by re-adding the bare edge.
function addEdge(acc: Accumulator, edge: NetworkTopologyEdge): void {
	const key = `${edge.kind}|${edge.from}|${edge.to}`;
	const existing = acc.edges.get(key);
	if (!existing) {
		acc.edges.set(key, edge);
		return;
	}
	acc.edges.set(key, {
		...existing,
		...(edge.detail !== undefined && { detail: edge.detail }),
		...(edge.derived !== undefined && { derived: edge.derived }),
	});
}

// DNS names compare case-insensitively and Route53 appends a trailing dot.
function normalizeDns(name: string): string {
	return name.toLowerCase().replace(/\.$/, "");
}

function ecsDetail(task: z.infer<typeof EcsTaskRow>, detailName: string): string | undefined {
	for (const att of task.attachments ?? []) {
		if (att.type !== "ElasticNetworkInterface") continue;
		const hit = att.details?.find((d) => d.name === detailName)?.value;
		if (hit) return hit;
	}
	return undefined;
}

function parseAwsOutputs(acc: Accumulator, outputs: ToolOutput[], estate: string | undefined, focus: string[]): void {
	for (const o of outputs) {
		switch (o.toolName) {
			case "aws_ec2_describe_vpcs": {
				for (const raw of rows(o.rawJson, "Vpcs")) {
					const p = VpcRow.safeParse(raw);
					if (!p.success) continue;
					upsertNode(acc, {
						id: p.data.VpcId,
						kind: "vpc",
						name: nameTag(p.data.Tags),
						cidr: p.data.CidrBlock,
						estate,
					});
				}
				break;
			}
			case "aws_ec2_describe_subnets": {
				for (const raw of rows(o.rawJson, "Subnets")) {
					const p = SubnetRow.safeParse(raw);
					if (!p.success) continue;
					upsertNode(acc, {
						id: p.data.SubnetId,
						kind: "subnet",
						cidr: p.data.CidrBlock,
						availabilityZone: p.data.AvailabilityZone,
						estate,
					});
					if (p.data.VpcId) {
						upsertNode(acc, { id: p.data.VpcId, kind: "vpc", estate });
						addEdge(acc, { from: p.data.SubnetId, to: p.data.VpcId, kind: "in-vpc" });
					}
				}
				break;
			}
			case "aws_ec2_describe_network_interfaces": {
				for (const raw of rows(o.rawJson, "NetworkInterfaces")) {
					const p = EniRow.safeParse(raw);
					if (!p.success) continue;
					const ips = new Set<string>();
					if (p.data.PrivateIpAddress) ips.add(p.data.PrivateIpAddress);
					for (const extra of p.data.PrivateIpAddresses ?? []) {
						if (extra.PrivateIpAddress) ips.add(extra.PrivateIpAddress);
					}
					upsertNode(acc, {
						id: p.data.NetworkInterfaceId,
						kind: "eni",
						privateIps: Array.from(ips),
						estate,
					});
					if (p.data.SubnetId) {
						upsertNode(acc, { id: p.data.SubnetId, kind: "subnet", estate });
						addEdge(acc, { from: p.data.NetworkInterfaceId, to: p.data.SubnetId, kind: "in-subnet" });
					}
					if (p.data.Attachment?.InstanceId) {
						upsertNode(acc, { id: p.data.Attachment.InstanceId, kind: "workload", estate });
						addEdge(acc, {
							from: p.data.NetworkInterfaceId,
							to: p.data.Attachment.InstanceId,
							kind: "attached-to",
						});
					}
				}
				break;
			}
			case "aws_ec2_describe_instances": {
				// The `_summary` projection must be checked FIRST: the all-optional
				// ReservationsEnvelope parses even when only `_summary` survived
				// byte-truncation, which would otherwise drop every instance row.
				const summary = summaryRows(o.rawJson);
				const env = ReservationsEnvelope.safeParse(o.rawJson);
				const instanceRows =
					summary ?? (env.success ? (env.data.Reservations ?? []).flatMap((r) => r.Instances ?? []) : []);
				for (const raw of instanceRows) {
					const p = InstanceRow.safeParse(raw);
					if (!p.success) continue;
					const name = nameTag(p.data.Tags);
					upsertNode(acc, {
						id: p.data.InstanceId,
						kind: "workload",
						name,
						privateIps: p.data.PrivateIpAddress ? [p.data.PrivateIpAddress] : undefined,
						estate,
						service: name && matchesFocus(name, focus) ? name : undefined,
					});
					if (p.data.SubnetId) {
						upsertNode(acc, { id: p.data.SubnetId, kind: "subnet", estate });
						addEdge(acc, { from: p.data.InstanceId, to: p.data.SubnetId, kind: "in-subnet" });
					}
				}
				break;
			}
			case "aws_ecs_describe_tasks": {
				for (const raw of rows(o.rawJson, "tasks")) {
					const p = EcsTaskRow.safeParse(raw);
					if (!p.success) continue;
					const serviceName = p.data.group?.startsWith("service:") ? p.data.group.slice(8) : undefined;
					const ip = ecsDetail(p.data, "privateIPv4Address");
					const subnetId = ecsDetail(p.data, "subnetId");
					upsertNode(acc, {
						id: p.data.taskArn,
						kind: "workload",
						name: serviceName ?? p.data.taskArn.split("/").pop(),
						privateIps: ip ? [ip] : undefined,
						estate,
						service: serviceName && matchesFocus(serviceName, focus) ? serviceName : undefined,
					});
					if (subnetId) {
						upsertNode(acc, { id: subnetId, kind: "subnet", estate });
						addEdge(acc, { from: p.data.taskArn, to: subnetId, kind: "in-subnet" });
					}
				}
				break;
			}
			case "aws_elbv2_describe_load_balancers": {
				for (const raw of rows(o.rawJson, "LoadBalancers")) {
					const p = LoadBalancerRow.safeParse(raw);
					if (!p.success) continue;
					upsertNode(acc, {
						id: p.data.LoadBalancerArn,
						kind: "loadBalancer",
						name: p.data.LoadBalancerName,
						dnsName: p.data.DNSName,
						lbType: p.data.Type,
						scheme: p.data.Scheme,
						estate,
					});
					for (const az of p.data.AvailabilityZones ?? []) {
						if (!az.SubnetId) continue;
						upsertNode(acc, { id: az.SubnetId, kind: "subnet", availabilityZone: az.ZoneName, estate });
						addEdge(acc, { from: p.data.LoadBalancerArn, to: az.SubnetId, kind: "attached-to" });
					}
				}
				break;
			}
			case "aws_elbv2_describe_listeners": {
				for (const raw of rows(o.rawJson, "Listeners")) {
					const p = ListenerRow.safeParse(raw);
					if (!p.success || !p.data.LoadBalancerArn) continue;
					const detail = p.data.Protocol && p.data.Port ? `${p.data.Protocol}:${p.data.Port}` : undefined;
					for (const action of p.data.DefaultActions ?? []) {
						if (!action.TargetGroupArn) continue;
						upsertNode(acc, { id: p.data.LoadBalancerArn, kind: "loadBalancer", estate });
						upsertNode(acc, { id: action.TargetGroupArn, kind: "targetGroup", estate });
						addEdge(acc, {
							from: p.data.LoadBalancerArn,
							to: action.TargetGroupArn,
							kind: "routes-to",
							detail,
						});
					}
				}
				break;
			}
			case "aws_elbv2_describe_target_groups": {
				for (const raw of rows(o.rawJson, "TargetGroups")) {
					const p = TargetGroupRow.safeParse(raw);
					if (!p.success) continue;
					upsertNode(acc, {
						id: p.data.TargetGroupArn,
						kind: "targetGroup",
						name: p.data.TargetGroupName,
						estate,
					});
					for (const lbArn of p.data.LoadBalancerArns ?? []) {
						upsertNode(acc, { id: lbArn, kind: "loadBalancer", estate });
						addEdge(acc, { from: lbArn, to: p.data.TargetGroupArn, kind: "routes-to" });
					}
				}
				break;
			}
			case "aws_elbv2_describe_target_health": {
				const env = TargetHealthEnvelope.safeParse(o.rawJson);
				if (!env.success || !env.data.TargetGroupArn) break;
				const tgArn = env.data.TargetGroupArn;
				let healthy = 0;
				let total = 0;
				upsertNode(acc, { id: tgArn, kind: "targetGroup", estate });
				for (const row of env.data.TargetHealthDescriptions ?? []) {
					const targetId = row.Target?.Id;
					if (!targetId) continue;
					total += 1;
					if (row.TargetHealth?.State === "healthy") healthy += 1;
					const detail = row.Target?.Port !== undefined ? `port ${row.Target.Port}` : undefined;
					if (parseIpv4(targetId) !== null) {
						// IP-type target: anchor on a synthetic workload node keyed by IP so
						// the derived-subnet pass can still place it.
						const ipNodeId = `ip:${targetId}`;
						upsertNode(acc, { id: ipNodeId, kind: "workload", name: targetId, privateIps: [targetId], estate });
						addEdge(acc, { from: tgArn, to: ipNodeId, kind: "targets", detail });
					} else {
						upsertNode(acc, { id: targetId, kind: "workload", estate });
						addEdge(acc, { from: tgArn, to: targetId, kind: "targets", detail });
					}
				}
				if (total > 0) {
					const existing = acc.nodes.get(tgArn);
					if (existing) acc.nodes.set(tgArn, { ...existing, health: { healthy, total } });
				}
				break;
			}
			case "aws_route53_list_resource_record_sets": {
				for (const raw of rows(o.rawJson, "ResourceRecordSets")) {
					const p = RecordSetRow.safeParse(raw);
					if (!p.success) continue;
					if (!["A", "AAAA", "CNAME", "ALIAS"].includes(p.data.Type)) continue;
					const recordName = normalizeDns(p.data.Name);
					const target = p.data.AliasTarget?.DNSName ?? p.data.ResourceRecords?.[0]?.Value;
					const id = `dns:${recordName}:${p.data.Type}`;
					upsertNode(acc, {
						id,
						kind: "dnsRecord",
						name: recordName,
						recordType: p.data.Type,
						dnsName: target ? normalizeDns(target) : undefined,
						estate,
					});
				}
				break;
			}
			default:
				break;
		}
	}
}

function addEndpoint(
	acc: Accumulator,
	datasource: string,
	host: string,
	port: number | undefined,
	protocol: string | undefined,
	name: string | undefined,
	focus: string[],
): string {
	const id = port !== undefined ? `ep:${datasource}:${host}:${port}` : `ep:${datasource}:${host}`;
	upsertNode(acc, {
		id,
		kind: "serviceEndpoint",
		name,
		endpoint: { host, port, protocol, datasource },
		service: name && matchesFocus(name, focus) ? name : undefined,
	});
	return id;
}

function parseOverlayOutputs(acc: Accumulator, dataSourceId: string, outputs: ToolOutput[], focus: string[]): void {
	for (const o of outputs) {
		if (
			dataSourceId === "konnect" &&
			(o.toolName === "konnect_get_service" || o.toolName === "konnect_list_services")
		) {
			const raw = o.rawJson;
			const candidates: unknown[] = [];
			if (typeof raw === "object" && raw !== null && "data" in raw && Array.isArray((raw as { data: unknown }).data)) {
				candidates.push(...(raw as { data: unknown[] }).data);
			} else {
				candidates.push(raw);
			}
			for (const c of candidates) {
				const p = KongServiceRow.safeParse(c);
				if (!p.success || !p.data.host) continue;
				addEndpoint(acc, "konnect", p.data.host, p.data.port, p.data.protocol, p.data.name, focus);
			}
		} else if (dataSourceId === "kafka" && o.toolName === "kafka_describe_cluster") {
			const env = KafkaClusterEnvelope.safeParse(o.rawJson);
			if (!env.success) continue;
			for (const b of env.data.brokers ?? []) {
				if (!b.host) continue;
				const brokerId = b.nodeId ?? b.id;
				const label = brokerId !== undefined ? `broker-${brokerId}` : "broker";
				const id = addEndpoint(acc, "kafka", b.host, b.port, undefined, label, focus);
				if (b.rack) {
					const node = acc.nodes.get(id);
					if (node) acc.nodes.set(id, { ...node, availabilityZone: b.rack });
				}
			}
		} else if (dataSourceId === "couchbase" && o.toolName === "capella_get_system_nodes") {
			const raw = o.rawJson;
			const rowsArr =
				typeof raw === "object" &&
				raw !== null &&
				"results" in raw &&
				Array.isArray((raw as { results: unknown }).results)
					? (raw as { results: unknown[] }).results
					: Array.isArray(raw)
						? raw
						: [];
			for (const r of rowsArr) {
				if (typeof r !== "object" || r === null) continue;
				const rec = r as Record<string, unknown>;
				const inner =
					typeof rec.nodes === "object" && rec.nodes !== null ? (rec.nodes as Record<string, unknown>) : rec;
				const host = typeof inner.hostname === "string" ? inner.hostname : undefined;
				if (!host) continue;
				const [h, portStr] = host.split(":");
				const port = portStr && /^\d+$/.test(portStr) ? Number(portStr) : undefined;
				if (h) addEndpoint(acc, "couchbase", h, port, undefined, undefined, focus);
			}
		} else if (dataSourceId === "elastic" && o.toolName === "elasticsearch_get_nodes_info") {
			const env = ElasticNodesEnvelope.safeParse(o.rawJson);
			if (!env.success) continue;
			for (const nodeRaw of Object.values(env.data.nodes ?? {})) {
				const p = ElasticNodeRow.safeParse(nodeRaw);
				if (!p.success) continue;
				const host = p.data.ip ?? p.data.host;
				if (!host) continue;
				let port: number | undefined;
				const addr = p.data.transport_address;
				const colon = addr?.lastIndexOf(":") ?? -1;
				if (addr && colon > 0 && /^\d+$/.test(addr.slice(colon + 1))) port = Number(addr.slice(colon + 1));
				addEndpoint(acc, "elastic", host, port, undefined, p.data.name, focus);
			}
		}
	}
}

// Link every un-placed IP-bearing node into a subnet via CIDR containment
// (`derived: true`), and DNS records to LBs whose DNSName matches their target.
function deriveEdges(acc: Accumulator): void {
	const subnets = Array.from(acc.nodes.values()).filter((n) => n.kind === "subnet" && n.cidr);
	const lbsByDns = new Map<string, string>();
	for (const n of acc.nodes.values()) {
		if (n.kind === "loadBalancer" && n.dnsName) lbsByDns.set(normalizeDns(n.dnsName), n.id);
	}
	// Precomputed once: nodes already placed by an explicit in-subnet edge.
	const placedInSubnet = new Set<string>();
	for (const e of acc.edges.values()) {
		if (e.kind === "in-subnet") placedInSubnet.add(e.from);
	}
	for (const node of acc.nodes.values()) {
		if (node.kind === "dnsRecord") {
			if (!node.dnsName) continue;
			const lbId = lbsByDns.get(node.dnsName);
			if (lbId) addEdge(acc, { from: node.id, to: lbId, kind: "resolves-to" });
			continue;
		}
		if (node.kind === "subnet" || node.kind === "vpc" || node.kind === "loadBalancer" || node.kind === "targetGroup") {
			continue;
		}
		if (placedInSubnet.has(node.id)) continue;
		const ips = [...(node.privateIps ?? [])];
		if (node.endpoint && parseIpv4(node.endpoint.host) !== null) ips.push(node.endpoint.host);
		for (const ip of ips) {
			const hit = subnets.find(
				(s) =>
					s.cidr !== undefined &&
					// Cross-estate CIDR matches are likely coincidences (10.0.0.0/16 exists
					// everywhere); only match within the same estate or when either side
					// has no estate attribution.
					(node.estate === undefined || s.estate === undefined || node.estate === s.estate) &&
					ipInCidr(ip, s.cidr),
			);
			if (hit) {
				addEdge(acc, { from: node.id, to: hit.id, kind: "in-subnet", derived: true });
				break;
			}
		}
	}
}

export function buildNetworkTopology(
	results: DataSourceResult[],
	focusServices: string[],
	turn = 0,
): NetworkTopology | undefined {
	const acc: Accumulator = { nodes: new Map(), edges: new Map(), sources: new Set() };
	for (const r of results) {
		const outputs = r.toolOutputs ?? [];
		if (outputs.length === 0) continue;
		const before = acc.nodes.size;
		if (r.dataSourceId === "aws") {
			parseAwsOutputs(acc, outputs, r.deploymentId, focusServices);
		} else {
			parseOverlayOutputs(acc, r.dataSourceId, outputs, focusServices);
		}
		if (acc.nodes.size > before) acc.sources.add(r.dataSourceId);
	}
	if (acc.nodes.size === 0) return undefined;
	deriveEdges(acc);

	let truncated = false;
	let nodes = Array.from(acc.nodes.values());
	if (nodes.length > MAX_NODES) {
		nodes = nodes.slice(0, MAX_NODES);
		truncated = true;
	}
	const keptIds = new Set(nodes.map((n) => n.id));
	let edges = Array.from(acc.edges.values()).filter((e) => keptIds.has(e.from) && keptIds.has(e.to));
	if (edges.length > MAX_EDGES) {
		edges = edges.slice(0, MAX_EDGES);
		truncated = true;
	}
	return {
		builtAtTurn: turn,
		sources: Array.from(acc.sources),
		nodes,
		edges,
		...(truncated && { truncated }),
	};
}

const MAX_PROMPT_LINES = 20;

// Compact hierarchy text for the aggregate prompt. The full map renders as a
// card in the UI; the prompt only needs enough to ground root-cause reasoning.
export function summarizeNetworkTopologyForPrompt(topology: NetworkTopology): string {
	const byId = new Map(topology.nodes.map((n) => [n.id, n]));
	const label = (id: string): string => {
		const n = byId.get(id);
		if (!n) return id;
		return n.name ?? n.id;
	};
	const lines: string[] = [];

	const subnetsByVpc = new Map<string, string[]>();
	for (const e of topology.edges) {
		if (e.kind !== "in-vpc") continue;
		const list = subnetsByVpc.get(e.to) ?? [];
		list.push(e.from);
		subnetsByVpc.set(e.to, list);
	}
	const workloadsBySubnet = new Map<string, string[]>();
	for (const e of topology.edges) {
		if (e.kind !== "in-subnet") continue;
		const list = workloadsBySubnet.get(e.to) ?? [];
		list.push(e.from);
		workloadsBySubnet.set(e.to, list);
	}
	for (const vpc of topology.nodes.filter((n) => n.kind === "vpc")) {
		const subnetIds = subnetsByVpc.get(vpc.id) ?? [];
		const parts: string[] = [];
		for (const subnetId of subnetIds.slice(0, 4)) {
			const subnet = byId.get(subnetId);
			const members = (workloadsBySubnet.get(subnetId) ?? [])
				.map((id) => {
					const n = byId.get(id);
					const ip = n?.privateIps?.[0];
					return ip ? `${label(id)} ${ip}` : label(id);
				})
				.slice(0, 4);
			parts.push(`${subnetId}${subnet?.cidr ? ` (${subnet.cidr})` : ""}: ${members.join(", ") || "no members seen"}`);
		}
		lines.push(
			`- vpc ${vpc.id}${vpc.cidr ? ` (${vpc.cidr})` : ""}${vpc.estate ? ` [${vpc.estate}]` : ""} > ${parts.join(" | ") || "no subnets seen"}`,
		);
	}

	const routesByLb = new Map<string, { to: string; detail?: string }[]>();
	for (const e of topology.edges) {
		if (e.kind !== "routes-to") continue;
		const list = routesByLb.get(e.from) ?? [];
		list.push({ to: e.to, detail: e.detail });
		routesByLb.set(e.from, list);
	}
	for (const e of topology.edges) {
		if (e.kind !== "resolves-to") continue;
		const dns = byId.get(e.from);
		const lb = byId.get(e.to);
		if (!dns || !lb) continue;
		const chains = (routesByLb.get(lb.id) ?? []).map((r) => {
			const tg = byId.get(r.to);
			const health = tg?.health ? ` ${tg.health.healthy}/${tg.health.total} healthy` : "";
			return `${label(r.to)}${r.detail ? ` (${r.detail})` : ""}${health}`;
		});
		lines.push(
			`- ${dns.name ?? dns.id} ${dns.recordType ?? ""} -> ${label(lb.id)} (${[lb.lbType, lb.scheme].filter(Boolean).join("/") || "lb"})${chains.length > 0 ? ` -> ${chains.join(", ")}` : ""}`,
		);
	}

	const endpoints = topology.nodes.filter((n) => n.kind === "serviceEndpoint");
	if (endpoints.length > 0) {
		const rendered = endpoints
			.slice(0, 6)
			.map((n) => {
				const ep = n.endpoint;
				const hostPort = ep ? (ep.port !== undefined ? `${ep.host}:${ep.port}` : ep.host) : n.id;
				return `${ep?.datasource ?? "?"} ${hostPort}${n.name ? ` (${n.name})` : ""}`;
			})
			.join(", ");
		lines.push(`- endpoints: ${rendered}${endpoints.length > 6 ? ` (+${endpoints.length - 6} more)` : ""}`);
	}

	if (lines.length > MAX_PROMPT_LINES) {
		const hidden = lines.length - (MAX_PROMPT_LINES - 1);
		return [...lines.slice(0, MAX_PROMPT_LINES - 1), `- ... (+${hidden} more lines)`].join("\n");
	}
	return lines.join("\n");
}
