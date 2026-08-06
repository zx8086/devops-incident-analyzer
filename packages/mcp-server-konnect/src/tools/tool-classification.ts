// src/tools/tool-classification.ts
// SIO-1414: MCP ToolAnnotations classification for the konnect registry, keyed on
// the leading verb of each tool's `method`. Hand-reviewed against the full 78-tool
// registry (not looksReadOnlyByName guesswork). destructiveHint follows the spec's
// semantics -- "may perform non-ADDITIVE changes" -- so update/regenerate/unpublish/
// logout are destructive (they overwrite or remove existing state) while create/
// publish/register/authenticate/process are additive writes.
import type { ToolAnnotationSets } from "@devops-agent/shared";

const READ_VERBS = new Set(["analyze", "check", "fetch", "get", "list", "query"]);
const ADDITIVE_WRITE_VERBS = new Set(["authenticate", "create", "process", "publish", "register"]);
const DESTRUCTIVE_VERBS = new Set(["delete", "logout", "regenerate", "revoke", "unpublish", "update"]);

// Builds the name-keyed Sets deriveToolAnnotations consumes, over the PREFIXED
// tool names the registry loop actually registers. Throws on an unclassified
// verb so a new tool cannot ship without a recorded read/write decision -- the
// factory-replay and snapshot tests boot the server, so an unclassified verb
// fails the suite, not production.
export function buildKonnectAnnotationSets(
	tools: ReadonlyArray<{ method: string }>,
	prefix = "konnect_",
): ToolAnnotationSets {
	const readOnly = new Set<string>();
	const destructive = new Set<string>();
	for (const tool of tools) {
		const verb = tool.method.split("_")[0] ?? "";
		const name = `${prefix}${tool.method}`;
		if (READ_VERBS.has(verb)) {
			readOnly.add(name);
		} else if (DESTRUCTIVE_VERBS.has(verb)) {
			destructive.add(name);
		} else if (!ADDITIVE_WRITE_VERBS.has(verb)) {
			throw new Error(
				`konnect tool "${tool.method}" has unclassified verb "${verb}" -- add it to tool-classification.ts (SIO-1414)`,
			);
		}
	}
	return { readOnly, destructive };
}
