#!/usr/bin/env bun
// agent/src/skill-promote-cli.ts
//
// SIO-1017: CLI that scaffolds a SKILL.md DRAFT from a SIO-1015 kind:skill
// proposal. Reads the proposal fact from agent-memory by skill_name, renders the
// draft via skill-promote.ts, and writes it under agents/<agent>/skills/<name>/.
// PROPOSE-ONLY safety: refuses to overwrite without --force and NEVER edits
// agent.yaml unless --add-to-manifest is passed (prints the line to add instead).
//
//   bun run --filter @devops-agent/agent skill:promote -- --skill <name> [--agent <a>] [--force]
//
// The pure helpers (parsePromoteArgs, skillFilePath) are exported + unit-tested;
// main() is guarded by import.meta.main so importing this module is side-effect free.
//
// agent.yaml is NEVER edited: local skills are manifest-gated, so an un-added draft
// is inert (the propose-only safety posture). The CLI prints the line to add by hand.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { getWorkspaceRoot } from "./paths.ts";
import { renderSkillMarkdown } from "./skill-promote.ts";

export interface PromoteArgs {
	agent: string;
	skill: string;
	force: boolean;
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
		},
		allowPositionals: false,
	});
	if (!values.skill) throw new Error("missing required --skill <skill_name>");
	return {
		agent: values.agent ?? DEFAULT_AGENT,
		skill: values.skill,
		force: values.force ?? false,
	};
}

export function skillFilePath(workspaceRoot: string, agent: string, skill: string): string {
	return join(workspaceRoot, "agents", agent, "skills", skill, "SKILL.md");
}

// The manifest hint a human pastes into agent.yaml when --add-to-manifest is NOT
// passed (the default). Kept here so the message and the actual append share one shape.
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

	const hits = await searchAgentMemory(args.agent, "", { kind: "skill", skill_name: args.skill }, 1, {
		deterministic: true,
	});
	const hit = hits[0];
	if (!hit) {
		console.error(`No kind:skill proposal found for skill_name="${args.skill}" (agent ${args.agent}).`);
		process.exit(1);
	}

	const filePath = skillFilePath(getWorkspaceRoot(), args.agent, args.skill);
	if (existsSync(filePath) && !args.force) {
		console.error(`Refusing to overwrite existing ${filePath} (pass --force to replace).`);
		process.exit(1);
	}

	const markdown = renderSkillMarkdown({ annotations: hit.annotations, body: hit.text });
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, markdown, "utf8");
	console.log(`Wrote DRAFT skill: ${filePath}`);
	console.log(manifestHint(args.agent, args.skill));
	console.log("Review the DRAFT banner and procedure before relying on this skill.");
}

if (import.meta.main) {
	main().catch((error) => {
		console.error("promote-skill failed:", error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
