// packages/agent/src/eval/tool-probe.ts
//
// SIO-1398: DIRECT tool testing -- calls every coverage target against its live MCP server with
// no agent, no model, no steering in the loop.
//
// Why this exists: the LangSmith eval can only observe a tool the MODEL chose to call, so its
// scores conflate two unrelated questions -- "does this tool work" and "does the model pick
// it". A perfectly healthy tool scores zero simply because the agent answered another way
// (gitlab sat at 8/22 for exactly that reason, with every probed tool working). Conversely a
// tool can be selected and still be broken. Those are different failure classes with different
// owners, and mixing them makes both unreadable.
//
// Division of labour:
//   this file        -- is the TOOL healthy? (deterministic, no model, ~free, every target)
//   the LangSmith eval -- does the MODEL call it correctly? (needs the agent, costs money)
//
// A target that fails here is a tool/environment defect. A target that passes here but is never
// exercised in the eval is a STEERING gap. Reporting them separately is the point.

import { buildCoverageTargets, type CoverageTarget } from "./coverage-targets.ts";

// Read-only by construction: probes send `{}` or a curated read-only argument set, never a
// payload that could mutate. Write tools are excluded from coverage targets upstream (see the
// no-write-tool guard in coverage-targets.test.ts).
export interface ProbeResult {
	toolName: string;
	dataSource: string;
	verdict: "ok" | "needs-args" | "tool-error" | "unreachable" | "no-server";
	// Structured error kind when the server returned an { _error } envelope.
	kind?: string;
	// Required parameter the schema named, when the rejection identified one.
	missingParam?: string;
	detail?: string;
	durationMs: number;
}

export interface ProbeReport {
	results: ProbeResult[];
	byDatasource: Map<string, { total: number; ok: number; needsArgs: number; failed: number }>;
}

// Server URLs come from the same env vars the agent uses, so a probe run and an eval run target
// identical infrastructure.
export function probeUrls(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
	return {
		elastic: env.ELASTIC_MCP_URL,
		kafka: env.KAFKA_MCP_URL,
		couchbase: env.COUCHBASE_MCP_URL,
		konnect: env.KONNECT_MCP_URL,
		gitlab: env.GITLAB_MCP_URL,
		atlassian: env.ATLASSIAN_MCP_URL,
		aws: env.AWS_MCP_URL,
	};
}

// Curated read-only arguments for tools whose schema requires a parameter. Values are the
// verified LIVE_ANCHORS -- a probe with a real anchor tests the tool end to end, whereas a bare
// {} only tests its schema. Anything absent here is probed with {} and reports `needs-args`,
// which is a legitimate outcome (it still proves registration and schema wiring).
export type ProbeArgs = Record<string, Record<string, unknown>>;

// isError is the authoritative failure signal and MUST be checked before any text matching. An
// earlier version of this classifier regexed /required/i over the whole body and matched the
// literal string inside SUCCESSFUL payloads (a Couchbase index named
// `idx_variant_required_fields_covered`), reporting working tools as needs-args.
export function classifyProbeResponse(text: string): Pick<ProbeResult, "verdict" | "kind" | "missingParam" | "detail"> {
	if (/Method not found|-32601/i.test(text)) return { verdict: "unreachable", detail: "tool not registered" };
	if (!/"isError":\s*true/.test(text)) return { verdict: "ok" };

	// Schema-layer rejection (zod / MCP -32602).
	if (/-32602|Invalid arguments|invalid_type|invalid input|expected .*received undefined/i.test(text)) {
		const param = text.match(/"path":\s*\[\s*\\?"([^"\\]+)/)?.[1] ?? text.match(/\\"path\\":\s*\[\s*\\"([^"\\]+)/)?.[1];
		return { verdict: "needs-args", missingParam: param, detail: "schema rejected the probe arguments" };
	}

	// HANDLER-layer argument validation. Some tools accept `{}` at the schema (their params are
	// individually optional because several combinations are valid) and enforce the requirement
	// inside the handler instead -- gitlab_get_merge_request_notes is the live example: its
	// schema has no `required`, but the handler answers "Provide either url, or project_id and
	// merge_request_iid". That is still a missing-argument outcome, not a tool defect, and
	// classifying it as one would report a healthy tool as broken.
	const handlerArgError = text.match(/(Validation error:[^"\\]{0,120}|Provide either[^"\\]{0,120})/i)?.[1];
	if (handlerArgError) {
		return { verdict: "needs-args", detail: handlerArgError.trim() };
	}

	const kind = text.match(/\\?"kind\\?":\s*\\?"([a-z-]+)/)?.[1];
	return { verdict: "tool-error", kind: kind ?? "unknown", detail: text.slice(0, 200) };
}

async function callTool(
	url: string,
	toolName: string,
	args: Record<string, unknown>,
	headers: Record<string, string>,
	timeoutMs: number,
): Promise<string> {
	const res = await fetch(url.endsWith("/mcp") ? url : `${url.replace(/\/$/, "")}/mcp`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	return res.text();
}

export interface ProbeOptions {
	urls?: Record<string, string | undefined>;
	args?: ProbeArgs;
	// Per-datasource headers, e.g. the elastic deployment router.
	headers?: Record<string, Record<string, string>>;
	timeoutMs?: number;
	targets?: CoverageTarget[];
	onResult?: (result: ProbeResult) => void;
}

export async function probeTools(options: ProbeOptions = {}): Promise<ProbeReport> {
	const urls = options.urls ?? probeUrls();
	const argsByTool = options.args ?? {};
	const headersByDs = options.headers ?? {};
	const timeoutMs = options.timeoutMs ?? 60_000;
	const targets = options.targets ?? buildCoverageTargets();
	const results: ProbeResult[] = [];

	for (const target of targets) {
		const url = urls[target.dataSource];
		const startedAt = Date.now();
		let result: ProbeResult;

		if (!url) {
			result = {
				toolName: target.toolName,
				dataSource: target.dataSource,
				verdict: "no-server",
				detail: `no URL configured for ${target.dataSource}`,
				durationMs: 0,
			};
		} else {
			try {
				const text = await callTool(
					url,
					target.toolName,
					argsByTool[target.toolName] ?? {},
					headersByDs[target.dataSource] ?? {},
					timeoutMs,
				);
				result = {
					toolName: target.toolName,
					dataSource: target.dataSource,
					...classifyProbeResponse(text),
					durationMs: Date.now() - startedAt,
				};
			} catch (error) {
				result = {
					toolName: target.toolName,
					dataSource: target.dataSource,
					verdict: "unreachable",
					detail: error instanceof Error ? error.message.slice(0, 120) : String(error),
					durationMs: Date.now() - startedAt,
				};
			}
		}

		results.push(result);
		options.onResult?.(result);
	}

	const byDatasource = new Map<string, { total: number; ok: number; needsArgs: number; failed: number }>();
	for (const r of results) {
		const e = byDatasource.get(r.dataSource) ?? { total: 0, ok: 0, needsArgs: 0, failed: 0 };
		e.total++;
		if (r.verdict === "ok") e.ok++;
		else if (r.verdict === "needs-args") e.needsArgs++;
		else e.failed++;
		byDatasource.set(r.dataSource, e);
	}

	return { results, byDatasource };
}

// A probe run FAILS only on a genuine tool defect. `needs-args` is not a failure -- the schema
// correctly rejected an empty probe, which still proves registration and schema wiring. Neither
// is `no-server` for an intentionally disabled datasource (konnect); that is reported, and the
// caller decides.
export function probeFailures(report: ProbeReport): ProbeResult[] {
	return report.results.filter((r) => r.verdict === "tool-error" || r.verdict === "unreachable");
}
