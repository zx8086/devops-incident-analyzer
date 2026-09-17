// apps/web/vite.config.ts

import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { findRepoRoot } from "./src/lib/repo-root.ts";

export default defineConfig(({ mode }) => {
	// SIO-1143: the repo root, NOT the checkout root -- in a worktree those differ and only
	// the main checkout holds the gitignored .env. See src/lib/repo-root.ts for why.
	const repoRoot = findRepoRoot(__dirname);
	// Precedence is unchanged: loadEnv gives existing process.env keys priority over the
	// parsed file, and Object.assign then writes the merged result back. SIO-1647's auth
	// backoff depends on exactly this ordering -- do not swap it for a spread that would
	// let the file win.
	const rootEnv = loadEnv(mode, repoRoot, "");
	Object.assign(process.env, rootEnv);

	return {
		plugins: [tailwindcss(), sveltekit()],
		envDir: repoRoot,
		server: {
			watch: {
				ignored: ["!**/packages/agent/**", "!**/packages/shared/**", "!**/packages/checkpointer/**"],
			},
		},
		ssr: {
			// Workspace packages: bundle as source code
			noExternal: [
				"@devops-agent/agent",
				"@devops-agent/shared",
				"@devops-agent/checkpointer",
				"@devops-agent/observability",
				"@devops-agent/gitagent-bridge",
			],
			// External packages: run in Node.js, don't bundle
			external: [
				"@langchain/core",
				"@langchain/langgraph",
				"@langchain/langgraph-checkpoint",
				"@langchain/aws",
				"@langchain/mcp-adapters",
				"pino",
				"yaml",
			],
		},
	};
});
