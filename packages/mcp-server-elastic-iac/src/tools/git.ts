// src/tools/git.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.ts";
import { errText, run, text } from "./shared.ts";

const PROTECTED = new Set(["main", "master"]);

// Branch/commit/push (non-protected) + read ops. No force-push, no push to main.
export function registerGitTools(server: McpServer, config: Config): void {
	const cwd = config.repository.workspaceDir;

	server.tool(
		"git_clone",
		"Clone the IaC repository into the workspace (idempotent fetch when already present).",
		{ url: z.string().describe("Repository clone URL") },
		async ({ url }) => text(await run(["git", "clone", url, "."], cwd)),
	);

	server.tool("git_checkout", "Checkout an existing ref in the workspace.", { ref: z.string() }, async ({ ref }) =>
		text(await run(["git", "checkout", ref], cwd)),
	);

	server.tool(
		"git_create_branch",
		"Create and switch to a new working branch (agent/<short>-<yyyymmdd>).",
		{ branch: z.string() },
		async ({ branch }) => {
			if (PROTECTED.has(branch)) return errText(`Refusing to create over protected branch '${branch}'.`);
			return text(await run(["git", "checkout", "-b", branch], cwd));
		},
	);

	server.tool(
		"git_commit",
		"Stage all changes and commit on the current branch.",
		{ message: z.string() },
		async ({ message }) => {
			await run(["git", "add", "-A"], cwd);
			return text(await run(["git", "commit", "-m", message], cwd));
		},
	);

	server.tool(
		"git_push",
		"Push the working branch to origin. Never main/master, never --force.",
		{ branch: z.string() },
		async ({ branch }) => {
			if (PROTECTED.has(branch))
				return errText(`Refusing to push to protected branch '${branch}'. Apply is manual in GitLab.`);
			return text(await run(["git", "push", "-u", "origin", branch], cwd));
		},
	);

	server.tool("git_status", "Show the working tree status.", {}, async () =>
		text(await run(["git", "status", "--short", "--branch"], cwd)),
	);

	server.tool(
		"git_diff",
		"Show the unified diff of the working tree (or against a ref).",
		{ ref: z.string().optional() },
		async ({ ref }) => text(await run(["git", "diff", ...(ref ? [ref] : [])], cwd)),
	);
}
