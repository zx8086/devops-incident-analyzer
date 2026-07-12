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
// tool returns { queryTag, result: { rows: [...] }, ... } (or the raw envelope
// for the escape hatch). We branch on queryTag -- stamped by the DSL builder --
// and map Orbit's node/aggregation rows to the typed OrbitFindings shape.
//
// Orbit row shapes (format:"raw"):
//  - traversal rows: node aliases as keys, each { type, id, properties: {...} }
//  - aggregation rows: group-by aliases (scalar or nested node) + aggregate cols
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

function queryTagOf(rawJson: unknown): string | undefined {
	const top = asRecord(rawJson);
	return top ? str(top.queryTag) : undefined;
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
function pushBlastRadius(out: OrbitBlastRadius[], rows: Row[], mrByFile: Record<string, Row>, focus: string[]): void {
	const byDef = new Map<string, OrbitBlastRadius>();
	for (const row of rows) {
		const def = nodeProps(row.def);
		const sym = nodeProps(row.sym);
		const defName = str(def.fqn) ?? str(def.name);
		if (!defName) continue;
		const symFile = str(sym.file_path);
		// The downstream (importing) project is the file DOING the import -- i.e.
		// the ImportedSymbol's own file_path, NOT its import_path (which names the
		// imported source lib and would point back at the changed definition).
		const symProject = projectFromPath(symFile);
		const sourceFile = str(def.file_path);
		const existing = byDef.get(defName) ?? {
			definitionName: defName,
			definitionKind: str(def.definition_type),
			sourceProject: projectFromPath(sourceFile),
			sourceFile,
			importedByProjects: [],
			importedByFiles: [],
			importSiteCount: 0,
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
		if (symFile) existing.importedByFiles.push({ project: symProject, file: symFile });
		if (symProject && !existing.importedByProjects.includes(symProject)) existing.importedByProjects.push(symProject);
		existing.importSiteCount += 1;
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
		const rows = rowsOf(o.rawJson);
		if (rows.length === 0) continue;
		switch (queryTagOf(o.rawJson)) {
			case "orbit_blast_radius":
			case "orbit_cross_project_callers":
				pushBlastRadius(blastRadius, rows, mrByFileOf(o.rawJson), focusServices);
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
