// knowledge-graph/src/seed-iac.ts
//
// SIO-965: `knowledge-graph:seed-iac` populates the three-layer IaC skeleton
// (modules/stacks/deployments/stack-instances) from the LIVE elastic-iac GitLab
// repo. This CLI owns ALL GitLab I/O (plain fetch, no MCP/agent dependency) so
// the package stays zero-LLM and the writer.seed* helpers stay pure. Idempotent
// (all MERGE) -- safe to re-run. Requires KNOWLEDGE_GRAPH_ENABLED=true + an
// installed lbug, plus ELASTIC_IAC_GITLAB_{TOKEN,BASE_URL,PROJECT}.

import { getGraphStore, isKnowledgeGraphEnabled } from "./store.ts";
import {
	type DeploymentSeed,
	linkStackModule,
	seedDeployments,
	seedModules,
	seedStackInstances,
	seedStacks,
} from "./writer.ts";

// Deployment inventory (name -> EC id + region) from the verified repo README.
// Used only to enrich the ElasticDeployment nodes; the deployment SET is keyed by
// the actual environments/<dir> listing, so an unknown dir still seeds (no id).
export const DEPLOYMENT_INVENTORY: Record<string, { ecId: string; region: string }> = {
	"eu-cld": { ecId: "eda974d", region: "Frankfurt" },
	"us-cld": { ecId: "971a5b5", region: "N. Virginia" },
	"ap-cld": { ecId: "fa42400", region: "Hong Kong" },
	"eu-b2b": { ecId: "02655c3", region: "Frankfurt" },
	"gl-cld-reporting": { ecId: "4c3796f", region: "Ohio" },
	"eu-onboarding": { ecId: "e9187e6", region: "Frankfurt" },
	"eu-cld-monitor": { ecId: "e0d0b78", region: "Frankfurt" },
	"ap-cld-monitor": { ecId: "b55ebf4", region: "Hong Kong" },
	"us-cld-monitor": { ecId: "0169212", region: "N. Virginia" },
	"gl-testing": { ecId: "f00e987", region: "Ohio" },
};

// Underscore-prefixed environment dirs are config buckets, not clusters:
// `_deployments` (cluster JSON for the deployments stack) and `_shared` (defaults).
function isDeploymentDir(name: string): boolean {
	return !name.startsWith("_");
}

// Pure: extract every `source = "../../modules/<x>"` module name from a stack's
// main.tf. A stack can wire several modules (e.g. `deployments` uses deployment +
// traffic-filter), and the stack name is NOT derivable from the module name
// (slos -> slo, agent-policies -> agent-policy), so parsing is mandatory.
export function parseModuleSources(mainTf: string): string[] {
	const out: string[] = [];
	const re = /source\s*=\s*"(?:\.\.\/)*modules\/([A-Za-z0-9_-]+)"/g;
	for (const m of mainTf.matchAll(re)) {
		const name = m[1];
		if (name && !out.includes(name)) out.push(name);
	}
	return out;
}

interface TreeEntry {
	name: string;
	type: "tree" | "blob";
	path: string;
}

interface GitlabConfig {
	base: string;
	token: string;
	projectEnc: string;
}

function loadGitlabConfig(env: NodeJS.ProcessEnv = process.env): GitlabConfig {
	const base = env.ELASTIC_IAC_GITLAB_BASE_URL || "https://gitlab.com";
	const token = env.ELASTIC_IAC_GITLAB_TOKEN || "";
	const project = env.ELASTIC_IAC_GITLAB_PROJECT || "pvhcorp/dhco/observability/observability-elastic-iac";
	if (!token) throw new Error("ELASTIC_IAC_GITLAB_TOKEN is required to seed from the live repo");
	return { base, token, projectEnc: encodeURIComponent(project) };
}

// List one directory level (non-recursive), paginating until an empty page.
async function listTree(cfg: GitlabConfig, path: string): Promise<TreeEntry[]> {
	const out: TreeEntry[] = [];
	for (let page = 1; ; page++) {
		const url = `${cfg.base}/api/v4/projects/${cfg.projectEnc}/repository/tree?path=${encodeURIComponent(path)}&per_page=100&page=${page}`;
		const res = await fetch(url, { headers: { "PRIVATE-TOKEN": cfg.token } });
		if (!res.ok) throw new Error(`GitLab tree ${path} page ${page}: ${res.status} ${res.statusText}`);
		const batch = (await res.json()) as TreeEntry[];
		if (batch.length === 0) break;
		out.push(...batch);
		if (batch.length < 100) break;
	}
	return out;
}

async function getRawFile(cfg: GitlabConfig, path: string): Promise<string> {
	const url = `${cfg.base}/api/v4/projects/${cfg.projectEnc}/repository/files/${encodeURIComponent(path)}/raw?ref=main`;
	const res = await fetch(url, { headers: { "PRIVATE-TOKEN": cfg.token } });
	if (!res.ok) throw new Error(`GitLab file ${path}: ${res.status} ${res.statusText}`);
	return res.text();
}

async function seedIac(): Promise<void> {
	const cfg = loadGitlabConfig();
	const store = await getGraphStore();
	await store.init();

	// 1. Modules (skip _unused).
	const moduleDirs = (await listTree(cfg, "modules")).filter((e) => e.type === "tree" && !e.name.startsWith("_"));
	const modules = moduleDirs.map((e) => e.name);
	await seedModules(store, modules);

	// 2. Stacks.
	const stackDirs = (await listTree(cfg, "stacks")).filter((e) => e.type === "tree");
	const stacks = stackDirs.map((e) => e.name);
	await seedStacks(store, stacks);

	// 3. Stack -> Module edges, parsed from each stack's main.tf.
	let edges = 0;
	for (const stack of stacks) {
		let mainTf: string;
		try {
			mainTf = await getRawFile(cfg, `stacks/${stack}/main.tf`);
		} catch {
			continue; // a stack without a main.tf has no module wiring to record
		}
		for (const module of parseModuleSources(mainTf)) {
			await linkStackModule(store, stack, module);
			edges++;
		}
	}

	// 4. Deployments (environments/* dirs, minus _deployments/_shared).
	const envDirs = (await listTree(cfg, "environments")).filter((e) => e.type === "tree" && isDeploymentDir(e.name));
	const deployments: DeploymentSeed[] = envDirs.map((e) => ({ name: e.name, ...DEPLOYMENT_INVENTORY[e.name] }));
	await seedDeployments(store, deployments);

	// 5. StackInstances: the sparse (deployment, stack) cells that actually exist.
	const instances: Array<{ deployment: string; stack: string }> = [];
	for (const dep of envDirs) {
		const subdirs = (await listTree(cfg, `environments/${dep.name}`)).filter((e) => e.type === "tree");
		for (const sub of subdirs) instances.push({ deployment: dep.name, stack: sub.name });
	}
	await seedStackInstances(store, instances);

	process.stdout.write(
		`knowledge-graph: seeded ${modules.length} modules, ${stacks.length} stacks (${edges} module edges), ` +
			`${deployments.length} deployments, ${instances.length} stack instances.\n`,
	);
}

async function main(): Promise<void> {
	if (!isKnowledgeGraphEnabled()) {
		process.stdout.write("knowledge-graph: KNOWLEDGE_GRAPH_ENABLED is not set; nothing to do.\n");
		return;
	}
	await seedIac();
	const store = await getGraphStore();
	await store.close();
}

// Auto-run only as a CLI (`bun run src/seed-iac.ts`), not when a test imports the
// pure helpers (parseModuleSources / DEPLOYMENT_INVENTORY) from this module.
if (import.meta.main) {
	main().catch((error) => {
		process.stderr.write(
			`knowledge-graph seed-iac failed: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(1);
	});
}
