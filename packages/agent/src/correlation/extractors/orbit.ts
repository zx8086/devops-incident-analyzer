// packages/agent/src/correlation/extractors/orbit.ts
import type {
	OrbitBlastRadius,
	OrbitFindings,
	OrbitPipelineFailure,
	OrbitRecentDeploy,
	OrbitVulnerability,
	ToolOutput,
} from "@devops-agent/shared";
import { matchesFocus } from "../focus-match.ts";

// SIO-1076: Orbit tool outputs ride the gitlab DataSourceResult. Every wrapper
// tool returns { queryTag, result: {...}, ... } (or the raw envelope for the
// escape hatch). We branch on queryTag -- stamped by the DSL builder -- and map
// Orbit's node/aggregation rows to the typed OrbitFindings shape.
//
// Orbit result shapes (format:"raw"):
//  - aggregation: result.rows -- group-by aliases (scalar or nested node) +
//    aggregate cols
//  - traversal, Orbit >= 0.91 (SIO-1318): result.nodes (flat typed node objects
//    with inline properties) + result.edges ({ from, from_id, to, to_id, type })
//    -- NO result.rows. rowsFromNodes() rebuilds alias-keyed rows from these.
//  - traversal, legacy (< 0.91): result.rows with node aliases as keys, each
//    { type, id, properties: {...} } -- still read for backward compat.
// All entity ids come back as strings.

const ORBIT_TOOL_NAMES = new Set([
	"gitlab_blast_radius",
	"gitlab_cross_project_callers",
	"gitlab_recent_deploys",
	"gitlab_pipeline_failures",
	"gitlab_recent_vulnerabilities",
	"gitlab_orbit_query_graph",
]);

type Row = Record<string, unknown>;

function asRecord(v: unknown): Row | undefined {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : undefined;
}

// Orbit node value: { type, id, properties: {...} }. Return its properties bag.
function nodeProps(v: unknown): Row {
	const rec = asRecord(v);
	const props = rec ? asRecord(rec.properties) : undefined;
	return props ?? rec ?? {};
}

function str(v: unknown): string | undefined {
	if (typeof v === "string") return v;
	if (typeof v === "number") return String(v);
	return undefined;
}

function idVal(v: unknown): string | number | undefined {
	if (typeof v === "string" || typeof v === "number") return v;
	return undefined;
}

function num(v: unknown): number | undefined {
	if (typeof v === "number") return v;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return undefined;
}

function rowsOf(rawJson: unknown): Row[] {
	const top = asRecord(rawJson);
	if (!top) return [];
	const result = asRecord(top.result);
	const rows = result?.rows ?? top.rows;
	return Array.isArray(rows) ? rows.filter((r): r is Row => asRecord(r) !== undefined) : [];
}

function resultList(rawJson: unknown, key: "nodes" | "edges"): Row[] {
	const top = asRecord(rawJson);
	if (!top) return [];
	const result = asRecord(top.result);
	const list = result?.[key] ?? top[key];
	return Array.isArray(list) ? list.filter((v): v is Row => asRecord(v) !== undefined) : [];
}

// SIO-1318: rebuild alias-keyed rows from the Orbit >= 0.91 traversal shape
// (flat typed result.nodes + result.edges) so the per-tag push* mappers keep a
// single row contract:
//  - IMPORTS edge          -> { def, sym }  (blast radius / cross-project callers)
//  - IN_PROJECT edge       -> { mr, p } or { v, p }  (deploys / vulnerabilities)
//  - edge-less Definitions -> { def }  (the SIO-1303 name-match fallback sweep)
function rowsFromNodes(rawJson: unknown, tag: string | undefined): Row[] {
	const nodes = resultList(rawJson, "nodes");
	if (nodes.length === 0) return [];
	const byTypeId = new Map<string, Row>();
	for (const n of nodes) {
		const id = str(n.id);
		if (id) byTypeId.set(`${str(n.type) ?? ""}:${id}`, n);
	}
	const edges = resultList(rawJson, "edges");
	const endpoint = (edge: Row, side: "from" | "to"): Row | undefined =>
		byTypeId.get(`${str(edge[side]) ?? ""}:${str(edge[`${side}_id`]) ?? ""}`);
	const rows: Row[] = [];

	switch (tag) {
		case "orbit_blast_radius":
		case "orbit_cross_project_callers": {
			for (const edge of edges) {
				if (str(edge.type) !== "IMPORTS") continue;
				const a = endpoint(edge, "from");
				const b = endpoint(edge, "to");
				const def = [a, b].find((n) => n && str(n.type) === "Definition");
				const sym = [a, b].find((n) => n && str(n.type) === "ImportedSymbol");
				if (def) rows.push({ def, ...(sym ? { sym } : {}) });
			}
			if (rows.length === 0) {
				for (const n of nodes) if (str(n.type) === "Definition") rows.push({ def: n });
			}
			return rows;
		}
		case "orbit_recent_deploys":
		case "orbit_recent_vulnerabilities": {
			const primaryType = tag === "orbit_recent_deploys" ? "MergeRequest" : "Vulnerability";
			const alias = tag === "orbit_recent_deploys" ? "mr" : "v";
			const projectByPrimaryId = new Map<string, Row>();
			for (const edge of edges) {
				if (str(edge.type) !== "IN_PROJECT") continue;
				const a = endpoint(edge, "from");
				const b = endpoint(edge, "to");
				const primary = [a, b].find((n) => n && str(n.type) === primaryType);
				const project = [a, b].find((n) => n && str(n.type) === "Project");
				const primaryId = primary ? str(primary.id) : undefined;
				if (primaryId && project) projectByPrimaryId.set(primaryId, project);
			}
			for (const n of nodes) {
				if (str(n.type) !== primaryType) continue;
				const p = projectByPrimaryId.get(str(n.id) ?? "");
				rows.push({ [alias]: n, ...(p ? { p } : {}) });
			}
			return rows;
		}
		default:
			// Aggregations always carry result.rows; raw escape hatch has no mapping.
			return [];
	}
}

function queryTagOf(rawJson: unknown): string | undefined {
	const top = asRecord(rawJson);
	return top ? str(top.queryTag) : undefined;
}

// SIO-1303: when the IMPORTS-edge query returns 0 rows, runBlastRadius falls back
// to a Definition name-sweep and tags the payload radiusMode: "definition-name-match".
// Those rows are name co-occurrences across repos, not confirmed import edges.
function radiusModeOf(rawJson: unknown): "definition-name-match" | undefined {
	const top = asRecord(rawJson);
	return str(top?.radiusMode) === "definition-name-match" ? "definition-name-match" : undefined;
}

// SIO-1076: the blast-radius tool stitches the recent merged MR per changed
// source file into a top-level `mrByFile` map (the Definition->MR path exceeds
// Orbit's 3-hop cap, so it can't ride the traversal rows). Returns file -> MR
// props so pushBlastRadius can attach mrId/mrMergedAt/mrWebUrl to each finding.
function mrByFileOf(rawJson: unknown): Record<string, Row> {
	const map = asRecord(rawJson)?.mrByFile;
	const rec = asRecord(map);
	if (!rec) return {};
	const out: Record<string, Row> = {};
	for (const [file, mr] of Object.entries(rec)) {
		const props = nodeProps(mr);
		if (Object.keys(props).length > 0) out[file] = props;
	}
	return out;
}

// Blast radius: each row pairs a Definition (def) with an ImportedSymbol (sym).
// Group by definition, collect the distinct downstream import sites, and attach
// the merged-MR metadata resolved for the definition's source file.
// SIO-1303: when radiusMode is "definition-name-match" the rows carry only `def`
// (no `sym`/IMPORTS edge -- the tool fell back to a Definition name-sweep). A
// name-match row is a candidate definition location, NOT a confirmed import
// site: importSiteCount/importedByFiles/importedByProjects must stay empty for
// these rows (they're the "confirmed importer" signal downstream rules key on),
// and the finding is stamped radiusMode so consumers can tell the two apart.
function pushBlastRadius(
	out: OrbitBlastRadius[],
	rows: Row[],
	mrByFile: Record<string, Row>,
	focus: string[],
	radiusMode?: "definition-name-match",
): void {
	const byDef = new Map<string, OrbitBlastRadius>();
	for (const row of rows) {
		const def = nodeProps(row.def);
		const defName = str(def.fqn) ?? str(def.name);
		if (!defName) continue;
		const sourceFile = str(def.file_path);
		const existing = byDef.get(defName) ?? {
			definitionName: defName,
			definitionKind: str(def.definition_type),
			sourceProject: projectFromPath(sourceFile),
			sourceFile,
			importedByProjects: [],
			importedByFiles: [],
			importSiteCount: 0,
			...(radiusMode ? { radiusMode } : {}),
		};
		// Attach MR metadata resolved by the tool's enrichment query, keyed by the
		// changed source file. Populates mrMergedAt, without which the flagship
		// orbit-deploy-blast-radius-vs-elastic rule can never fire.
		if (sourceFile && existing.mrMergedAt === undefined) {
			const mr = mrByFile[sourceFile];
			if (mr) {
				existing.mrId = idVal(mr.id) ?? idVal(mr.iid);
				existing.mrMergedAt = str(mr.merged_at);
				existing.mrWebUrl = str(mr.web_url);
			}
		}
		if (radiusMode === undefined) {
			const sym = nodeProps(row.sym);
			const symFile = str(sym.file_path);
			// The downstream (importing) project is the file DOING the import -- i.e.
			// the ImportedSymbol's own file_path, NOT its import_path (which names
			// the imported source lib and would point back at the changed definition).
			// SIO-1318: only a row with an identifiable importing file counts as a
			// confirmed import site -- def-only rows must not inflate the count.
			if (symFile) {
				const symProject = projectFromPath(symFile);
				existing.importedByFiles.push({ project: symProject, file: symFile });
				if (symProject && !existing.importedByProjects.includes(symProject))
					existing.importedByProjects.push(symProject);
				existing.importSiteCount += 1;
			}
		}
		byDef.set(defName, existing);
	}
	for (const b of byDef.values()) {
		const haystack = `${b.sourceProject ?? ""} ${b.definitionName} ${b.importedByProjects.join(" ")}`;
		if (!matchesFocus(haystack, focus)) continue;
		out.push(b);
	}
}

function pushRecentDeploys(out: OrbitRecentDeploy[], rows: Row[], focus: string[]): void {
	for (const row of rows) {
		const mr = nodeProps(row.mr);
		const project = nodeProps(row.p);
		const mergedAt = str(mr.merged_at);
		const mrId = idVal(mr.id) ?? idVal(mr.iid);
		if (mrId === undefined || !mergedAt) continue;
		const projectPath = str(project.full_path);
		const haystack = `${projectPath ?? ""} ${str(mr.title) ?? ""}`;
		if (!matchesFocus(haystack, focus)) continue;
		out.push({
			mrId,
			project: projectPath,
			title: str(mr.title),
			mergedAt,
			changedFileCount: num(mr.files_count),
		});
	}
}

// Aggregation rows: group-by aliases (project, ref) + the `failures` count column.
function pushPipelineFailures(out: OrbitPipelineFailure[], rows: Row[], focus: string[]): void {
	for (const row of rows) {
		// group-by "project" may be a scalar bucket or a nested Project node.
		const project = str(row.project) ?? str(nodeProps(row.p).full_path);
		const failureCount = num(row.failures) ?? num(row.failure_count);
		if (failureCount === undefined) continue;
		if (!matchesFocus(project ?? "", focus)) continue;
		out.push({
			project,
			ref: str(row.ref),
			failureCount,
		});
	}
}

function pushVulnerabilities(out: OrbitVulnerability[], rows: Row[], focus: string[]): void {
	for (const row of rows) {
		const v = nodeProps(row.v);
		const project = nodeProps(row.p);
		const severity = str(v.severity);
		if (!severity) continue;
		const projectPath = str(project.full_path);
		const haystack = `${projectPath ?? ""} ${str(v.title) ?? ""}`;
		if (!matchesFocus(haystack, focus)) continue;
		out.push({
			vulnerabilityId: idVal(v.id),
			title: str(v.title),
			severity,
			project: projectPath,
			reportType: str(v.report_type),
		});
	}
}

// pvhcorp/<group>/<project> -> the two-segment project path prefix, best-effort.
function projectFromPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const parts = path.split("/").filter(Boolean);
	if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
	return parts[0];
}

export function extractOrbitFindings(outputs: ToolOutput[], focusServices: string[] = []): OrbitFindings {
	const blastRadius: OrbitBlastRadius[] = [];
	const recentDeploys: OrbitRecentDeploy[] = [];
	const pipelineFailures: OrbitPipelineFailure[] = [];
	const vulnerabilities: OrbitVulnerability[] = [];

	for (const o of outputs) {
		if (!ORBIT_TOOL_NAMES.has(o.toolName)) continue;
		const tag = queryTagOf(o.rawJson);
		// SIO-1318: Orbit >= 0.91 traversal responses have no result.rows; fall back
		// to rebuilding alias rows from result.nodes/result.edges.
		let rows = rowsOf(o.rawJson);
		if (rows.length === 0) rows = rowsFromNodes(o.rawJson, tag);
		if (rows.length === 0) continue;
		switch (tag) {
			case "orbit_blast_radius":
			case "orbit_cross_project_callers":
				pushBlastRadius(blastRadius, rows, mrByFileOf(o.rawJson), focusServices, radiusModeOf(o.rawJson));
				break;
			case "orbit_recent_deploys":
				pushRecentDeploys(recentDeploys, rows, focusServices);
				break;
			case "orbit_pipeline_failures":
				pushPipelineFailures(pipelineFailures, rows, focusServices);
				break;
			case "orbit_recent_vulnerabilities":
				pushVulnerabilities(vulnerabilities, rows, focusServices);
				break;
			default:
				// Raw escape hatch or an unknown tag: no deterministic mapping.
				break;
		}
	}

	const findings: OrbitFindings = {};
	if (blastRadius.length > 0) findings.blastRadius = blastRadius;
	if (recentDeploys.length > 0) findings.recentDeploys = recentDeploys;
	if (pipelineFailures.length > 0) findings.pipelineFailures = pipelineFailures;
	if (vulnerabilities.length > 0) findings.vulnerabilities = vulnerabilities;
	return findings;
}
