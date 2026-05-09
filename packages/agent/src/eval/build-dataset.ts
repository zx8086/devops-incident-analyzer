// packages/agent/src/eval/build-dataset.ts

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { DATASET } from "./dataset.ts";

const TARGET = "/tmp/devops-incident-eval.json";
const DATASET_NAME = "devops-incident-eval";

writeFileSync(TARGET, JSON.stringify(DATASET, null, 2));
console.log(`Wrote ${DATASET.length} examples to ${TARGET}`);

const result = spawnSync("langsmith", ["dataset", "upload", TARGET, "--name", DATASET_NAME], {
	stdio: "inherit",
	env: process.env,
});

if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
	console.error("`langsmith` CLI not found on PATH. Install it:");
	console.error(
		"  curl -sSL https://raw.githubusercontent.com/langchain-ai/langsmith-cli/main/scripts/install.sh | sh",
	);
	process.exit(1);
}

if (result.status !== 0) {
	console.error(`langsmith dataset upload failed (exit ${result.status})`);
	console.error(`If the dataset already exists, delete it first: langsmith dataset delete ${DATASET_NAME}`);
	process.exit(result.status ?? 1);
}
