// packages/agent/src/eval/spec-audit-cli.ts
//
// SIO-1440: tier-1 OKF spec audit entrypoint. Runs the four static/semantic checks
// (frontmatter degradation, orphaned knowledge, RULES-vs-SOUL contradictions, and the SIO-1444
// skill-declaration drift check) across the root agent and every declared sub-agent, exits
// non-zero on any finding -- same convention as wiki:lint (packages/agent/src/wiki/lint-cli.ts)
// and yaml:check. The contradiction judge makes one OpenAI call per agent, so this script is
// not free to run and is invoked deliberately
// (`bun run packages/agent/src/eval/spec-audit-cli.ts`), not as a pre-commit hook.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	findFrontmatterDegradations,
	findOrphanedKnowledgeFiles,
	findSkillDeclarationDrift,
	KnowledgeIndexSchema,
	type LoadedAgent,
	loadAgent,
} from "@devops-agent/gitagent-bridge";
import { parse } from "yaml";
import { getAgentsDir } from "../paths.ts";
import { contradictionJudgeFeedback, judgeSpecContradictions } from "./spec-contradiction-judge.ts";

interface AuditFinding {
	agentName: string;
	kind:
		| "frontmatter_degradation"
		| "orphaned_knowledge"
		| "skill_declaration_drift"
		| "spec_contradiction"
		| "spec_contradiction_check_failed";
	detail: string;
}

// Carries each agent's own directory through the recursion (a nested agent's dir is
// join(parentDir, "agents", subName), never join(rootDir, "agents", subName) -- see
// manifest-loader.ts:118-123) and qualifies nested names with their parent chain so a
// leaf-name collision two levels down does not merge findings under one bare name.
function flattenAgents(
	agentName: string,
	agent: LoadedAgent,
	agentDir: string,
): { name: string; agent: LoadedAgent; dir: string }[] {
	const flat = [{ name: agentName, agent, dir: agentDir }];
	for (const [subName, subAgent] of agent.subAgents) {
		const subDir = join(agentDir, "agents", subName);
		flat.push(...flattenAgents(`${agentName}/${subName}`, subAgent, subDir));
	}
	return flat;
}

async function auditAgent(name: string, agent: LoadedAgent, agentDir: string): Promise<AuditFinding[]> {
	const findings: AuditFinding[] = [];

	const indexPath = join(agentDir, "knowledge", "index.yaml");
	if (existsSync(indexPath)) {
		try {
			const index = KnowledgeIndexSchema.parse(parse(readFileSync(indexPath, "utf-8")));
			for (const d of findFrontmatterDegradations(agentDir, index)) {
				findings.push({ agentName: name, kind: "frontmatter_degradation", detail: `${d.path}: ${d.error}` });
			}
			for (const o of findOrphanedKnowledgeFiles(agentDir, index)) {
				findings.push({ agentName: name, kind: "orphaned_knowledge", detail: o.path });
			}
		} catch (err) {
			// index.yaml EXISTS but is invalid (bad YAML or fails KnowledgeIndexSchema) --
			// this is a real spec error, not the GAP-dialect "no index.yaml" case below, and
			// must be reported rather than silently treated as "nothing to check."
			findings.push({
				agentName: name,
				kind: "frontmatter_degradation",
				detail: `knowledge/index.yaml is invalid: ${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}
	// else: no knowledge/index.yaml (GAP dialect, manifest-enumerated knowledge) -- nothing to
	// walk for checks 2/3 on this agent.

	// SIO-1444: unlike checks 2/3 this needs no index.yaml -- it runs for every agent in the
	// flattened tree, which is what extends the SIO-1281 root-only drift guarantee to sub-agents.
	for (const d of findSkillDeclarationDrift(agentDir, agent.manifest.skills ?? [])) {
		findings.push({ agentName: name, kind: "skill_declaration_drift", detail: `${d.kind}: ${d.path}` });
	}

	if (agent.soul && agent.rules) {
		const result = await judgeSpecContradictions(agent.soul, agent.rules);
		const [feedback] = contradictionJudgeFeedback(result, name);
		// score undefined means the judge call itself failed (network error, malformed
		// response) -- that must be reported too, not silently treated as a clean pass just
		// because it also isn't score: 0. Only score === 1 (the judge ran and found nothing) is
		// a genuine non-finding.
		if (feedback?.score === undefined) {
			findings.push({ agentName: name, kind: "spec_contradiction_check_failed", detail: feedback?.comment ?? "" });
		} else if (feedback.score === 0) {
			findings.push({ agentName: name, kind: "spec_contradiction", detail: feedback.comment });
		}
	}

	return findings;
}

async function main(): Promise<void> {
	const agentsDir = getAgentsDir();

	// A malformed RUNBOOK (as opposed to any other knowledge category) throws out of
	// loadAgent itself, by design (SIO-1282: the runbook path is deliberately strict, unlike
	// stripFrontmatter's tolerant fallback for every other category). That failure mode is
	// exactly what this audit exists to surface -- report it as a finding, not a crash.
	let root: LoadedAgent;
	try {
		root = loadAgent(agentsDir);
	} catch (err) {
		process.stdout.write("OKF spec audit (tier 1): 1 finding(s):\n");
		process.stdout.write(
			`  [agent_load_failure] incident-analyzer: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	}

	const allFindings: AuditFinding[] = [];
	for (const { name, agent, dir } of flattenAgents("incident-analyzer", root, agentsDir)) {
		allFindings.push(...(await auditAgent(name, agent, dir)));
	}

	if (allFindings.length === 0) {
		process.stdout.write("OKF spec audit (tier 1): OK, no findings.\n");
		return;
	}

	process.stdout.write(`OKF spec audit (tier 1): ${allFindings.length} finding(s):\n`);
	for (const f of allFindings) {
		process.stdout.write(`  [${f.kind}] ${f.agentName}: ${f.detail}\n`);
	}
	process.exit(1);
}

main();
