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

function extractNodes(content: string, evidenceId: string): TopologyNode[] {
	const nodes: TopologyNode[] = [];
	const application = content.match(/^application_name:\s*["']?([^\s"']+)/m)?.[1];
	if (application) nodes.push({ id: `account:${application}`, kind: "account", name: application, evidenceId });
	for (const { pattern, kind } of resourcePatterns) {
		pattern.lastIndex = 0;
		for (const match of content.matchAll(pattern)) {
			const name = match[1];
			if (name) nodes.push({ id: `${kind}:${name}`, kind, name, evidenceId });
		}
	}
	return nodes;
}

function linkNodes(nodes: TopologyNode[]): TopologyEdge[] {
	const edges: TopologyEdge[] = [];
	const parent = nodes.find((node) => node.kind === "account") ?? nodes.find((node) => node.kind === "vpc");
	if (!parent) return edges;
	for (const node of nodes) {
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
		nodes.push(...extractNodes(file.content, evidenceId));
	}
	const uniqueNodes = [...new Map(nodes.map((node) => [node.id, node])).values()].slice(0, 500);
	return {
		repository,
		nodes: uniqueNodes,
		edges: linkNodes(uniqueNodes),
		evidence,
		provenance,
	};
}
