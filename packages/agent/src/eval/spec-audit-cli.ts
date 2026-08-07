// agent/src/eval/spec-audit-cli.ts
//
// SIO-1440: tier-1 OKF spec audit entrypoint. Runs the three static/semantic checks
// (frontmatter degradation, orphaned knowledge, RULES-vs-SOUL contradictions) across the root
// agent and every declared sub-agent, exits non-zero on any finding -- same convention as
// wiki:lint (packages/agent/src/wiki/lint-cli.ts) and yaml:check. Checks 2/3 are pure/local;
// check 1 makes one OpenAI call per agent, so this script is not free to run and is invoked
// deliberately (`bun run packages/agent/src/eval/spec-audit-cli.ts`), not as a pre-commit hook.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	findFrontmatterDegradations,
	findOrphanedKnowledgeFiles,
	KnowledgeIndexSchema,
	type LoadedAgent,
	loadAgent,
} from "@devops-agent/gitagent-bridge";
import { parse } from "yaml";
import { getAgentsDir } from "../paths.ts";
import { contradictionJudgeFeedback, judgeSpecContradictions } from "./spec-contradiction-judge.ts";

interface AuditFinding {
	agentName: string;
	kind: "frontmatter_degradation" | "orphaned_knowledge" | "spec_contradiction";
	detail: string;
}

function flattenAgents(agentName: string, agent: LoadedAgent): { name: string; agent: LoadedAgent }[] {
	const flat = [{ name: agentName, agent }];
	for (const [subName, subAgent] of agent.subAgents) {
		flat.push(...flattenAgents(subName, subAgent));
	}
	return flat;
}

async function auditAgent(name: string, agent: LoadedAgent, agentDir: string): Promise<AuditFinding[]> {
	const findings: AuditFinding[] = [];

	const indexPath = join(agentDir, "knowledge", "index.yaml");
	try {
		const index = KnowledgeIndexSchema.parse(parse(readFileSync(indexPath, "utf-8")));
		for (const d of findFrontmatterDegradations(agentDir, index)) {
			findings.push({ agentName: name, kind: "frontmatter_degradation", detail: `${d.path}: ${d.error}` });
		}
		for (const o of findOrphanedKnowledgeFiles(agentDir, index)) {
			findings.push({ agentName: name, kind: "orphaned_knowledge", detail: o.path });
		}
	} catch {
		// No knowledge/index.yaml (GAP dialect, manifest-enumerated knowledge) -- nothing to
		// walk for checks 2/3 on this agent.
	}

	if (agent.soul && agent.rules) {
		const grade = await judgeSpecContradictions(agent.soul, agent.rules);
		const feedback = contradictionJudgeFeedback(grade, name);
		if (feedback[0]?.score === 0) {
			findings.push({ agentName: name, kind: "spec_contradiction", detail: feedback[0].comment });
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
	for (const { name, agent } of flattenAgents("incident-analyzer", root)) {
		const agentDir = name === "incident-analyzer" ? agentsDir : join(agentsDir, "agents", name);
		allFindings.push(...(await auditAgent(name, agent, agentDir)));
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
