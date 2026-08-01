#!/usr/bin/env bun
// agent/src/skill-promote-cli.ts
//
// SIO-1017 + SIO-1345: CLI over kind:skill proposal facts. Three modes:
//   --list             enumerate pending proposals with promotion status
//   --skill <name>     scaffold a local SKILL.md DRAFT + print the agent.yaml hint
//   --skill <n> --pr   git-native promotion: branch + SKILL.md + agent.yaml edit +
//                      commit + push + ready-for-review PR (merge = approval gate)
//
//   bun run --filter @devops-agent/agent skill:promote -- [--list] [--skill <n>]
//     [--agent <a>] [--force] [--pr] [--ticket SIO-XXXX]
//
// The pure helpers (parsePromoteArgs, skillFilePath) are exported + unit-tested;
// main() is guarded by import.meta.main so importing this module is side-effect free.
// Default mode never edits agent.yaml (propose-only posture); --pr edits it ON A
// BRANCH so the human review boundary moves to the PR merge, not the local file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { getAgentsDir, getWorkspaceRoot, skillFilePath } from "./paths.ts";
import { renderSkillMarkdown } from "./skill-promote.ts";

export { skillFilePath };

export interface PromoteArgs {
	agent: string;
	skill?: string;
	force: boolean;
	list: boolean;
	pr: boolean;
	ticket?: string;
}

// The learner only runs for incident-analyzer today, so that is the default agent.
const DEFAULT_AGENT = "incident-analyzer";

export function parsePromoteArgs(argv: string[]): PromoteArgs {
	const { values } = parseArgs({
		args: argv,
		options: {
			agent: { type: "string" },
			skill: { type: "string" },
			force: { type: "boolean", default: false },
			list: { type: "boolean", default: false },
			pr: { type: "boolean", default: false },
			ticket: { type: "string" },
		},
		allowPositionals: false,
	});
	if (!values.list && !values.skill) throw new Error("missing required --skill <skill_name> (or use --list)");
	return {
		agent: values.agent ?? DEFAULT_AGENT,
		...(values.skill ? { skill: values.skill } : {}),
		force: values.force ?? false,
		list: values.list ?? false,
		pr: values.pr ?? false,
		...(values.ticket ? { ticket: values.ticket } : {}),
	};
}

// The manifest hint a human pastes into agent.yaml in default (draft) mode. --pr
// performs this edit itself, on a branch.
function manifestHint(agent: string, skill: string): string {
	return `To load this skill, add it under \`skills:\` in agents/${agent}/agent.yaml:\n  - ${skill}`;
}

async function main(): Promise<void> {
	const args = parsePromoteArgs(process.argv.slice(2));
	// Import lazily so the unit tests (which only exercise the pure helpers) never
	// pull in the agent-memory client / its env.
	const { searchAgentMemory, selectedBackend } = await import("./memory-backend.ts");
	if (selectedBackend() !== "agent-memory") {
		console.error(
			"Skill proposals live in the agent-memory backend. Set LIVE_MEMORY_BACKEND=agent-memory (and AGENT_MEMORY_* env) to read them.",
		);
		process.exit(1);
	}

	if (args.list) {
		const { listSkillProposals } = await import("./skill-learner.ts");
		const { manifestHasSkill } = await import("./skill-manifest.ts");
		const proposals = await listSkillProposals(args.agent);
		if (proposals.length === 0) {
			console.log(`No kind:skill proposals found for agent ${args.agent}.`);
			return;
		}
		const manifestText = readFileSync(join(getAgentsDir(args.agent), "agent.yaml"), "utf8");
		for (const p of proposals) {
			const fileExists = existsSync(skillFilePath(getWorkspaceRoot(), args.agent, p.name));
			const inManifest = manifestHasSkill(manifestText, p.name);
			const status = fileExists && inManifest ? "promoted" : fileExists ? "drafted" : inManifest ? "broken" : "pending";
			console.log(`${status.padEnd(9)} ${p.name}  [${p.category}]  learned ${p.learnedAt} from ${p.learnedFrom}`);
		}
		console.log("\nPromote one with: --skill <name> --pr");
		return;
	}

	const skill = args.skill;
	if (!skill) throw new Error("missing required --skill <skill_name>");

	const hits = await searchAgentMemory(args.agent, "", { kind: "skill", skill_name: skill }, 1, {
		deterministic: true,
	});
	const hit = hits[0];
	if (!hit) {
		console.error(`No kind:skill proposal found for skill_name="${skill}" (agent ${args.agent}).`);
		process.exit(1);
	}

	const filePath = skillFilePath(getWorkspaceRoot(), args.agent, skill);
	if (existsSync(filePath) && !args.force) {
		console.error(`Refusing to overwrite existing ${filePath} (pass --force to replace).`);
		process.exit(1);
	}

	const markdown = renderSkillMarkdown(
		{ annotations: hit.annotations, body: hit.text },
		{ mode: args.pr ? "pr" : "draft" },
	);

	if (!args.pr) {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, markdown, "utf8");
		console.log(`Wrote DRAFT skill: ${filePath}`);
		console.log(manifestHint(args.agent, skill));
		console.log("Review the DRAFT banner and procedure before relying on this skill.");
		return;
	}

	const { addSkillToManifest } = await import("./skill-manifest.ts");
	const { runPromotion, spawnRunner } = await import("./skill-promote-git.ts");
	const manifestFile = join(getAgentsDir(args.agent), "agent.yaml");
	const result = runPromotion(
		spawnRunner(getWorkspaceRoot()),
		{
			agent: args.agent,
			skill,
			skillFile: filePath,
			manifestFile,
			...(args.ticket ? { ticket: args.ticket } : {}),
			annotations: hit.annotations,
		},
		() => {
			mkdirSync(dirname(filePath), { recursive: true });
			writeFileSync(filePath, markdown, "utf8");
			const edited = addSkillToManifest(readFileSync(manifestFile, "utf8"), skill);
			if (edited.changed) writeFileSync(manifestFile, edited.content, "utf8");
		},
	);
	console.log(`Promotion branch pushed: ${result.branch}`);
	if (result.prUrl) console.log(`PR (ready for review; merging activates the skill): ${result.prUrl}`);
	for (const step of result.manualSteps) console.log(`MANUAL STEP NEEDED: ${step}`);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error("promote-skill failed:", error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
