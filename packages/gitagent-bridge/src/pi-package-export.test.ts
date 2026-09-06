// gitagent-bridge/src/pi-package-export.test.ts
// SIO-1649: the Pi package exporter is allowlist-only and mirrors the runtime
// prompt's section order without inlined skill bodies.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgent } from "./manifest-loader.ts";
import { assertNoAccountIds, buildPiPackage, foldSkillFrontmatter, renderContextFile } from "./pi-package-export.ts";
import { buildSystemPromptParts } from "./skill-loader.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");
const PI_FLEET_DIR = join(REPO_ROOT, "agents", "pi-fleet");
const SEP = "\n\n---\n\n";

function writeSkill(dir: string, name: string, frontmatter: string, body = `# ${name}\n\nDo the thing.\n`): void {
	mkdirSync(join(dir, "skills", name), { recursive: true });
	writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\n${frontmatter}---\n${body}`);
}

// A fixture tree with every denylisted asset present, so the test can prove
// none of it reaches the package.
function makeFixture(opts: { accountIdInKnowledge?: boolean; learnedSkill?: boolean } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "gitagent-pi-export-"));
	const shared = join(root, "shared");
	mkdirSync(join(shared, "skills", "cite"), { recursive: true });
	writeFileSync(join(shared, "context.md"), "# Shared Context\n\n## Operating invariants\n\n- read-only\n");
	writeFileSync(join(shared, "context-runtime.md"), "# Runtime\n\n| Datasource | MCP server |\n");
	writeFileSync(
		join(shared, "skills", "cite", "SKILL.md"),
		"---\nname: cite\ndescription: Cite every claim.\n---\n# Cite\n\nCite.\n",
	);

	const agent = join(root, "fleet");
	mkdirSync(join(agent, "agents", "spoke", "knowledge", "runbooks"), { recursive: true });
	mkdirSync(join(agent, "memory", "runtime"), { recursive: true });
	mkdirSync(join(agent, "hooks"), { recursive: true });
	mkdirSync(join(agent, "compliance"), { recursive: true });
	mkdirSync(join(agent, "workflows"), { recursive: true });
	writeFileSync(
		join(agent, "agent.yaml"),
		"name: fleet\nversion: 1.2.3\ndescription: console\nskills:\n  - console-skill\nagents:\n  spoke: {}\n",
	);
	writeFileSync(join(agent, "SOUL.md"), "# Soul\n\nConsole.\n");
	writeFileSync(join(agent, "RULES.md"), "# Rules\n\n- rule\n");
	writeFileSync(join(agent, "DUTIES.md"), "# Duties\n\n- duty\n");
	writeFileSync(join(agent, "memory", "runtime", "context.md"), "# Live Context\n\nsecret incident notes\n");
	writeFileSync(join(agent, "hooks", "hooks.yaml"), "bootstrap:\n  steps: []\n");
	writeFileSync(join(agent, "compliance", "risk-assessment.md"), "# Risk\n");
	writeSkill(
		agent,
		"console-skill",
		"name: console-skill\ndescription: Console procedure.\nconfidence: 0.9\nversion: 2\n",
	);
	if (opts.learnedSkill) {
		writeSkill(
			agent,
			"learned",
			"name: learned\ndescription: Learned.\nlearned_from: DEVOPS-1\nlearned_at: 2026-01-01T00:00:00Z\n",
		);
		writeFileSync(
			join(agent, "agent.yaml"),
			"name: fleet\nversion: 1.2.3\ndescription: console\nskills:\n  - console-skill\n  - learned\nagents:\n  spoke: {}\n",
		);
	}
	const spoke = join(agent, "agents", "spoke");
	writeFileSync(
		join(spoke, "agent.yaml"),
		"name: spoke\nversion: 1.2.3\ndescription: spoke\nskills:\n  - spoke-skill\nknowledge:\n  - knowledge/runbooks/\n",
	);
	writeFileSync(join(spoke, "SOUL.md"), "# Soul\n\nSpoke.\n");
	writeFileSync(join(spoke, "RULES.md"), "# Rules\n\n- spoke rule\n");
	writeSkill(spoke, "spoke-skill", "name: spoke-skill\ndescription: Spoke procedure.\n");
	writeFileSync(
		join(spoke, "knowledge", "runbooks", "triage.md"),
		`---\ntitle: Triage\n---\n# Triage\n\nAccount ${opts.accountIdInKnowledge ? "123456789012" : "<account-id>"} steps.\n`,
	);
	return root;
}

describe("renderContextFile", () => {
	test("keeps the runtime section order and drops only the inlined skill bodies", () => {
		const root = makeFixture();
		try {
			const agent = loadAgent(join(root, "fleet"));
			const spoke = agent.subAgents.get("spoke");
			if (!spoke) throw new Error("fixture: spoke missing");
			for (const a of [agent, spoke]) {
				// The fixture has a runtime context file, so the exported shared section is
				// the portable part; build the expectation from the runtime parts with that
				// substitution and without the skill bodies.
				const parts = buildSystemPromptParts(a);
				const expectedCore = parts.core
					.split(SEP)
					.filter((s) => !s.startsWith("## Skill: "))
					.map((s) =>
						s.startsWith("## Shared Context") ? `## Shared Context\n\n${a.sharedContextPortable?.trim()}` : s,
					)
					.join(SEP);
				const rendered = renderContextFile(a, { inlineSkills: false });
				expect(rendered).toBe(`${expectedCore}${parts.knowledge}\n`);
				expect(rendered).not.toContain("MCP server");
				expect(rendered).toContain("## Skills");
			}
			const withHeader = renderContextFile(agent, { inlineSkills: false, header: "<!-- x -->" });
			expect(withHeader.startsWith("<!-- x -->\n\n# Soul")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("foldSkillFrontmatter", () => {
	test("moves extension fields under metadata and keeps the spec fields top-level", () => {
		const out = foldSkillFrontmatter(
			"s",
			"---\nname: s\ndescription: D.\nconfidence: 0.9\nversion: 2\nmetadata:\n  owner: ops\n---\n# S\n",
		);
		const fm = `${out.slice(4, out.indexOf("\n---\n", 4))}\n`;
		expect(fm).toContain("name: s\n");
		expect(fm).toContain("description: D.\n");
		expect(fm).not.toMatch(/^confidence:/m);
		expect(fm).toContain("metadata:\n");
		expect(fm).toContain("  confidence: 0.9\n");
		expect(fm).toContain("  version: 2\n");
		expect(fm).toContain("  owner: ops\n");
		expect(out.endsWith("---\n# S\n")).toBe(true);
	});

	test("refuses learned skills and skills without a description", () => {
		expect(() => foldSkillFrontmatter("l", "---\nname: l\ndescription: x\nlearned_from: T-1\n---\n")).toThrow(
			"learned skills",
		);
		expect(() => foldSkillFrontmatter("n", "---\nname: n\n---\nbody")).toThrow("description is required");
	});
});

describe("buildPiPackage", () => {
	test("emits the context files, the skill folders and the Pi manifest, and nothing denylisted", () => {
		const root = makeFixture();
		try {
			const agent = loadAgent(join(root, "fleet"));
			const pkg = buildPiPackage({ root: agent, name: "fleet", version: agent.manifest.version, sha: "abc1234" });
			const paths = pkg.files.map((f) => f.path).sort();
			expect(paths).toEqual([
				"AGENTS.md",
				"package.json",
				"skills/cite/SKILL.md",
				"skills/console-skill/SKILL.md",
				"skills/spoke-skill/SKILL.md",
				"spoke/AGENTS.override.md",
			]);
			for (const p of paths) {
				expect(
					p.startsWith("memory/") ||
						p.startsWith("hooks/") ||
						p.startsWith("compliance/") ||
						p.startsWith("workflows/"),
				).toBe(false);
			}
			const all = pkg.files.map((f) => f.content).join("\n");
			expect(all).not.toContain("secret incident notes");
			expect(all).not.toContain("MCP server");
			const manifest = JSON.parse(pkg.files.find((f) => f.path === "package.json")?.content ?? "{}") as Record<
				string,
				unknown
			>;
			expect(manifest).toEqual({
				name: "fleet",
				version: "1.2.3",
				private: true,
				description: "console",
				keywords: ["pi-package"],
				pi: { skills: ["./skills"] },
			});
			const override = pkg.files.find((f) => f.path === "spoke/AGENTS.override.md")?.content ?? "";
			expect(override.startsWith("<!-- fleet v1.2.3 (analyzer abc1234) -->\n\n# Soul\n\nSpoke.")).toBe(true);
			expect(override).toContain("## Knowledge Base");
			expect(override).toContain("Account <account-id> steps.");
			expect(pkg.skills.sort()).toEqual(["cite", "console-skill", "spoke-skill"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a learned skill or a 12-digit account id refuses the whole export", () => {
		const learned = makeFixture({ learnedSkill: true });
		const withId = makeFixture({ accountIdInKnowledge: true });
		try {
			const a = loadAgent(join(learned, "fleet"));
			expect(() => buildPiPackage({ root: a, name: "fleet", version: "1.2.3" })).toThrow("learned skills");
			const b = loadAgent(join(withId, "fleet"));
			expect(() => buildPiPackage({ root: b, name: "fleet", version: "1.2.3" })).toThrow(
				"spoke/AGENTS.override.md: contains a 12-digit account id (123456789012)",
			);
			expect(() => assertNoAccountIds("x", "ts 1725630000000 is 13 digits")).not.toThrow();
		} finally {
			rmSync(learned, { recursive: true, force: true });
			rmSync(withId, { recursive: true, force: true });
		}
	});

	test("the real pi-fleet definition exports the console, the spoke and both skills", () => {
		const agent = loadAgent(PI_FLEET_DIR);
		const pkg = buildPiPackage({ root: agent, name: "pi-fleet", version: agent.manifest.version });
		expect(pkg.skills.sort()).toEqual(["cite-sources", "verify-incident-report"]);
		const override = pkg.files.find((f) => f.path === "aws-spoke/AGENTS.override.md")?.content ?? "";
		expect(override).toContain("## Grounded permission claims");
		expect(override).toContain("## Knowledge Base");
		expect(override).not.toContain("aws_ecs_describe_services\n"); // no runbook tool frontmatter, bodies only
		expect(override).not.toContain("MCP server mapping");
	});

	test("packages/pi-coms/AGENTS.md is the current export of the console persona (run just sync-persona)", () => {
		const agent = loadAgent(PI_FLEET_DIR);
		const pkg = buildPiPackage({ root: agent, name: "pi-fleet", version: agent.manifest.version });
		const console = pkg.files.find((f) => f.path === "AGENTS.md")?.content ?? "";
		const committed = readFileSync(join(REPO_ROOT, "packages", "pi-coms", "AGENTS.md"), "utf-8");
		expect(committed).toBe(console);
	});
});
