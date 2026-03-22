// agent/src/paths.ts
// Resolve the monorepo root and agents directory regardless of CWD or runtime (Bun, Node, Vite SSR)
import { join, resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function findWorkspaceRoot(): string {
  // Strategy 1: Walk up from this file's location
  try {
    const thisFile = fileURLToPath(import.meta.url);
    let dir = dirname(thisFile);
    for (let i = 0; i < 10; i++) {
      if (existsSync(join(dir, "agents", "incident-analyzer", "agent.yaml"))) {
        return dir;
      }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url may not resolve in all environments
  }

  // Strategy 2: Walk up from CWD
  const cwd = process.cwd();
  const candidates = [cwd, resolve(cwd, ".."), resolve(cwd, "../..")];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "agents", "incident-analyzer", "agent.yaml"))) {
      return candidate;
    }
  }

  // Strategy 3: Check WORKSPACE_ROOT env var
  if (process.env.WORKSPACE_ROOT) {
    return process.env.WORKSPACE_ROOT;
  }

  throw new Error(`Cannot find workspace root (agents/incident-analyzer/agent.yaml). CWD: ${cwd}`);
}

let cachedRoot: string | null = null;

export function getWorkspaceRoot(): string {
  if (!cachedRoot) {
    cachedRoot = findWorkspaceRoot();
  }
  return cachedRoot;
}

export function getAgentsDir(): string {
  return join(getWorkspaceRoot(), "agents", "incident-analyzer");
}
