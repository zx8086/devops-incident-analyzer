// packages/agent/src/eval/build-mcp-tool-dataset.ts
//
// SIO-1398: uploads MCP_TOOL_DATASET as its own LangSmith dataset, separate from both
// build-dataset.ts ("devops-incident-eval") and build-incident-replay-dataset.ts
// ("incident-replay-eval") -- kept as an independent script, per the precedent set by
// SIO-1371, so no dataset's upload path can regress another's.
//
// Uses the SDK (not the langsmith CLI) for the same reasons SIO-1378 switched: the CLI cannot
// carry per-example metadata, and its failure path forces a delete-and-reupload that churns the
// dataset id and orphans prior experiments' version history.

import { Client } from "langsmith";
import type { Example } from "langsmith/schemas";
import { coveredDatasources, MCP_TOOL_DATASET } from "./mcp-tool-dataset.ts";

const DATASET_NAME = "mcp-tool-eval";

const client = new Client();

let datasetId: string;
try {
	const existing = await client.readDataset({ datasetName: DATASET_NAME });
	datasetId = existing.id;
	console.log(`Dataset ${DATASET_NAME} exists (${datasetId}) -- syncing examples in place, id preserved.`);
} catch {
	const created = await client.createDataset(DATASET_NAME, {
		description: "Per-datasource MCP tool-correctness probes against live anchors (SIO-1398)",
	});
	datasetId = created.id;
	console.log(`Created dataset ${DATASET_NAME} (${datasetId}).`);
}

// Replace-all sync from the TS source of truth, deleting EXAMPLES only (never the dataset) so
// the id and version history survive. Create BEFORE deleting the stale set (CodeRabbit, PR
// #593): the JS SDK has no upsert, so a delete-first flow that then failed mid-create would
// leave the dataset empty or partial for the next eval run. Creating first means a failed
// upload leaves the OLD examples fully intact -- worst case is temporary duplicates, reported
// loudly below and cleaned up by a successful re-run.
const stale: Example[] = [];
for await (const example of client.listExamples({ datasetId })) stale.push(example);

const created = await client.createExamples(
	MCP_TOOL_DATASET.map((entry) => ({
		dataset_id: datasetId,
		inputs: entry.inputs,
		outputs: entry.outputs,
		metadata: entry.metadata,
	})),
);
if (created.length !== MCP_TOOL_DATASET.length) {
	console.error(
		`Upload incomplete: created ${created.length}/${MCP_TOOL_DATASET.length} examples; ` +
			`the ${stale.length} pre-existing examples were NOT deleted. Re-run this script to sync cleanly.`,
	);
	process.exit(1);
}

for (const example of stale) await client.deleteExample(example.id);
if (stale.length > 0) console.log(`Deleted ${stale.length} stale examples after a validated upload.`);
console.log(`Uploaded ${created.length} examples to ${DATASET_NAME} (${datasetId}).`);
console.log(`Datasources covered: ${coveredDatasources().join(", ")}`);
