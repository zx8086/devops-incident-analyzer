// agent/src/wiki/lint-cli.ts
//
// SIO-847: `wiki:lint` entrypoint. Lints the production wiki under the resolved
// agents dir and exits non-zero on any issue so CI fails on a broken wiki, like
// yaml:check. Run via `bun run wiki:lint`.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentsDir } from "../paths.ts";
import { formatWikiLint, lintWiki } from "./lint.ts";

function main(): void {
	const agentDir = getAgentsDir();
	const wikiDir = join(agentDir, "memory", "wiki");
	const pagesDir = join(wikiDir, "pages");
	const indexPath = join(wikiDir, "index.md");

	if (!existsSync(pagesDir)) {
		// No wiki yet is not a failure; there is simply nothing to lint.
		process.stdout.write("Wiki OK: no memory/wiki/pages directory present.\n");
		return;
	}

	const pagePaths = readdirSync(pagesDir)
		.filter((f) => f.endsWith(".md") && f !== ".gitkeep")
		.map((f) => join(pagesDir, f));

	const result = lintWiki({
		pagePaths,
		indexMd: existsSync(indexPath) ? readFileSync(indexPath, "utf-8") : undefined,
		sourceRoot: agentDir,
	});

	process.stdout.write(`${formatWikiLint(result)}\n`);
	if (!result.ok) process.exit(1);
}

main();
