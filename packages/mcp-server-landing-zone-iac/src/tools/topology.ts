import {
	assertSafeRepositoryPath,
	type GitLabReadClient,
	repositoryProvenance,
	resolveRepository,
} from "./repositories.ts";

type TopologyKind = "account" | "vpc" | "subnet" | "route-table" | "dns-record" | "module";

export interface TopologyNode {
	id: string;
	kind: TopologyKind;
	name: string;
	evidenceId: string;
}

export interface TopologyEdge {
	from: string;
	to: string;
	relation: "contains" | "routes-through" | "resolves-for" | "composes";
	evidenceId: string;
}

const resourcePatterns: ReadonlyArray<{ pattern: RegExp; kind: TopologyKind }> = [
	{ pattern: /resource\s+"aws_vpc"\s+"([^"]+)"/g, kind: "vpc" },
	{ pattern: /resource\s+"aws_subnet"\s+"([^"]+)"/g, kind: "subnet" },
	{ pattern: /resource\s+"aws_route_table"\s+"([^"]+)"/g, kind: "route-table" },
	{ pattern: /resource\s+"aws_route53_(?:record|zone)"\s+"([^"]+)"/g, kind: "dns-record" },
	{ pattern: /module\s+"([^"]+)"/g, kind: "module" },
];

function extractNodes(content: string, evidenceId: string, scope: string): TopologyNode[] {
	const nodes: TopologyNode[] = [];
	const application = content.match(/^application_name:\s*["']?([^\s"']+)/m)?.[1];
	if (application)
		nodes.push({ id: `${scope}:account:${application}`, kind: "account", name: application, evidenceId });
	for (const { pattern, kind } of resourcePatterns) {
		pattern.lastIndex = 0;
		for (const match of content.matchAll(pattern)) {
			const name = match[1];
			if (name) nodes.push({ id: `${scope}:${kind}:${name}`, kind, name, evidenceId });
		}
	}
	return nodes;
}

function linkNodes(nodes: TopologyNode[]): TopologyEdge[] {
	const edges: TopologyEdge[] = [];
	const nodesByEvidence = new Map<string, TopologyNode[]>();
	for (const node of nodes) {
		const group = nodesByEvidence.get(node.evidenceId) ?? [];
		group.push(node);
		nodesByEvidence.set(node.evidenceId, group);
	}
	for (const evidenceNodes of nodesByEvidence.values()) {
		const account = evidenceNodes.find((node) => node.kind === "account");
		const vpcs = evidenceNodes.filter((node) => node.kind === "vpc");
		const parent = account ?? (vpcs.length === 1 ? vpcs[0] : undefined);
		if (!parent) continue;
		for (const node of evidenceNodes) {
			if (node.id === parent.id) continue;
			const relation =
				node.kind === "route-table"
					? "routes-through"
					: node.kind === "dns-record"
						? "resolves-for"
						: node.kind === "module"
							? "composes"
							: "contains";
			edges.push({ from: parent.id, to: node.id, relation, evidenceId: node.evidenceId });
		}
	}
	return edges;
}

export async function extractTerraformTopology(
	client: GitLabReadClient,
	input: { repository: string; paths: string[]; ref?: string },
) {
	const repository = resolveRepository(input.repository);
	if (input.paths.length === 0 || input.paths.length > 20)
		throw new Error("paths must contain between 1 and 20 entries");
	const { provenance } = await repositoryProvenance(client, repository, input.ref);
	const evidence = [];
	const nodes: TopologyNode[] = [];
	for (const path of input.paths) {
		assertSafeRepositoryPath(path);
		const file = await client.readFile(repository.projectPath, path, provenance.ref);
		const evidenceId = `gitlab:${repository.name}:${path}:${file.blobId}`;
		evidence.push({ id: evidenceId, path, blobId: file.blobId, ref: provenance.ref });
		nodes.push(...extractNodes(file.content, evidenceId, `${repository.name}:${path}`));
	}
	const deduplicatedNodes = [...new Map(nodes.map((node) => [node.id, node])).values()];
	const topologyTruncated = deduplicatedNodes.length > 500;
	const uniqueNodes = deduplicatedNodes.slice(0, 500);
	return {
		repository,
		nodes: uniqueNodes,
		edges: linkNodes(uniqueNodes),
		evidence,
		warnings: topologyTruncated ? ["Topology evidence was truncated at 500 nodes"] : [],
		provenance: { ...provenance, truncated: provenance.truncated || topologyTruncated },
	};
}
