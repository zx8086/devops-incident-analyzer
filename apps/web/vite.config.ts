// apps/web/vite.config.ts
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, resolve(__dirname, "../.."), "");
  Object.assign(process.env, rootEnv);

  return {
    plugins: [tailwindcss(), sveltekit()],
    envDir: "../..",
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
