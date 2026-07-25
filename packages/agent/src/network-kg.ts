// agent/src/network-kg.ts
// SIO-1204/SIO-1207: pure mappers between the per-turn shared NetworkTopology
// (built by network-topology.ts from toolOutputs) and the knowledge-graph
// boundary shapes. Kept out of record-bindings.ts so both directions are unit
// testable without the graph store: derive (state slot -> KG write record) and
// render (KG read -> graphContext line).
import type { NetworkMap, NetworkTopologyRecord } from "@devops-agent/knowledge-graph";
import { NETWORK_DISCOVERED_BY } from "@devops-agent/knowledge-graph";
import type { NetworkTopology } from "@devops-agent/shared";

// Matches the SIO-1100 agent-observed convention (recordServiceBinding).
const AGENT_CONFIDENCE = 0.7;

// Synthetic nodes the builder mints for IP-type LB targets whose owning
// workload is unknown ("ip:<addr>") -- they must never become BOUND_TO edges
// (the workloadArn would be the IP itself).
function isSyntheticIpNode(id: string): boolean {
	return id.startsWith("ip:");
}

export function deriveNetworkTopology(
	topology: NetworkTopology | undefined,
	incidentId: string | undefined,
): NetworkTopologyRecord | undefined {
	if (!topology || topology.nodes.length === 0) return undefined;

	const inVpc = new Map<string, string>(); // subnetId -> vpcId
	const attachedSubnets = new Map<string, string[]>(); // lbArn -> subnetIds
	const tgToLb = new Map<string, string>(); // tgArn -> lbArn
	const tgTargets = new Map<string, { id: string; isIp: boolean }[]>();
	const dnsToLb = new Map<string, string>(); // dnsNodeId -> lbArn
	const inSubnet = new Map<string, string>(); // nodeId -> subnetId
	for (const e of topology.edges) {
		switch (e.kind) {
			case "in-vpc":
				inVpc.set(e.from, e.to);
				break;
			case "attached-to": {
				const list = attachedSubnets.get(e.from) ?? [];
				list.push(e.to);
				attachedSubnets.set(e.from, list);
				break;
			}
			case "routes-to":
				if (!tgToLb.has(e.to)) tgToLb.set(e.to, e.from);
				break;
			case "targets": {
				const list = tgTargets.get(e.from) ?? [];
				list.push(isSyntheticIpNode(e.to) ? { id: e.to.slice(3), isIp: true } : { id: e.to, isIp: false });
				tgTargets.set(e.from, list);
				break;
			}
			case "resolves-to":
				dnsToLb.set(e.from, e.to);
				break;
			case "in-subnet":
				inSubnet.set(e.from, e.to);
				break;
			default:
				break;
		}
	}

	const record: NetworkTopologyRecord = {
		vpcs: [],
		subnets: [],
		loadBalancers: [],
		targetGroups: [],
		dnsRecords: [],
		endpoints: [],
		ipBindings: [],
	};

	for (const node of topology.nodes) {
		switch (node.kind) {
			case "vpc":
				record.vpcs.push({ id: node.id, cidr: node.cidr, name: node.name });
				break;
			case "subnet":
				record.subnets.push({
					id: node.id,
					cidr: node.cidr,
					az: node.availabilityZone,
					vpcId: inVpc.get(node.id),
				});
				break;
			case "loadBalancer":
				record.loadBalancers.push({
					arn: node.id,
					name: node.name,
					dnsName: node.dnsName,
					type: node.lbType,
					scheme: node.scheme,
					subnetIds: attachedSubnets.get(node.id),
				});
				break;
			case "targetGroup":
				record.targetGroups.push({
					arn: node.id,
					name: node.name,
					loadBalancerArn: tgToLb.get(node.id),
					targets: tgTargets.get(node.id),
				});
				break;
			case "dnsRecord":
				if (node.name && node.recordType) {
					record.dnsRecords.push({
						name: node.name,
						type: node.recordType,
						target: node.dnsName,
						loadBalancerArn: dnsToLb.get(node.id),
					});
				}
				break;
			case "serviceEndpoint":
				// HAS_ENDPOINT anchors on a Service node, so only endpoints the builder
				// linked to a focus service persist; unlinked endpoints stay ephemeral.
				if (node.service && node.endpoint) {
					record.endpoints.push({
						service: node.service,
						host: node.endpoint.host,
						port: node.endpoint.port,
						protocol: node.endpoint.protocol,
						datasource: node.endpoint.datasource,
					});
				}
				break;
			case "workload":
				if (isSyntheticIpNode(node.id)) break;
				for (const ip of node.privateIps ?? []) {
					record.ipBindings.push({
						ip,
						workloadArn: node.id,
						subnetId: inSubnet.get(node.id),
						confidence: AGENT_CONFIDENCE,
						discoveredBy: NETWORK_DISCOVERED_BY,
						evidence: `network-map:${topology.sources.join("+")}`,
						incidentId,
					});
				}
				break;
			default:
				break;
		}
	}

	const total =
		record.vpcs.length +
		record.subnets.length +
		record.loadBalancers.length +
		record.targetGroups.length +
		record.dnsRecords.length +
		record.endpoints.length +
		record.ipBindings.length;
	return total > 0 ? record : undefined;
}

// One bounded graphContext line per service from the PERSISTED map (prior
// incidents' knowledge, not this turn's live data). Empty string when the graph
// knows nothing network-shaped about the service.
export function renderNetworkContextLine(service: string, map: NetworkMap): string {
	const parts: string[] = [];
	const placement = map.placements[0];
	if (placement) {
		const vpc = placement.vpcName || placement.vpcId;
		parts.push(`in ${vpc}${placement.vpcCidr ? ` (${placement.vpcCidr})` : ""}`);
	}
	const lb = map.loadBalancers[0];
	if (lb) {
		const dns = map.dnsRecords.find((d) => d.loadBalancerArn === lb.arn);
		parts.push(`behind ${lb.type || "lb"} ${lb.name || lb.arn}${dns ? ` (dns ${dns.name})` : ""}`);
	}
	if (map.ipAddresses.length > 0) {
		const ips = map.ipAddresses.slice(0, 3).map((i) => i.ip);
		parts.push(`last-known IPs ${ips.join(", ")}${map.ipAddresses.length > 3 ? " ..." : ""}`);
	}
	if (map.endpoints.length > 0) {
		const eps = map.endpoints
			.slice(0, 3)
			.map((e) => `${e.datasource} ${e.port !== undefined && e.port !== 0 ? `${e.host}:${e.port}` : e.host}`);
		parts.push(`endpoints: ${eps.join(", ")}`);
	}
	if (parts.length === 0) return "";
	return `- known topology: ${service} ${parts.join("; ")}`;
}
