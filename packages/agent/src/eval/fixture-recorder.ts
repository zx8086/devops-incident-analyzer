// packages/agent/src/eval/fixture-recorder.ts
//
// SIO-1379: the "sound freeze" layer -- two recorders, deliberately NO tool-level replay.
// Deterministic tool-level replay was evaluated and REJECTED: the A/B varies sub-agent models,
// different models issue different tool calls, and replaying model A's recorded results to
// model B would grade B on canned answers to questions it never asked (see eval README).
// What IS frozen:
// - recordingToolMiddleware: a per-call MCP audit trail (JSONL, gitignored) so every future
//   score dispute is resolvable from data ("what did the elastic sub-agent actually get back").
// - the output store: each example's final runAgent output, so judge/harness iteration
//   (EVAL_FIXTURE_MODE=replay-outputs) re-grades frozen agent behavior without MCP or Bedrock.
//
// Recording is soft-fail by design: a recorder error must never alter an eval result.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { currentAwsEstate, currentElasticDeploymentForTest } from "../mcp-bridge.ts";

// Gitignored except MANIFEST.json: the repo is PUBLIC and recorded payloads carry real
// account ids, hostnames, and IPs -- fixture content is never committable. The manifest
// carries only query hashes, previews of already-committed dataset text, and counts.
export function fixturesDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.EVAL_FIXTURES_DIR?.trim() || join(import.meta.dir, "fixtures");
}

// 16 hex chars of sha256 -- collision-safe at dataset scale (32 examples), short enough for
// filenames and manifest keys. The full query text is recoverable via the manifest preview.
export function exampleKey(query: string): string {
	return createHash("sha256").update(query).digest("hex").slice(0, 16);
}

// Same ALS idiom as mcp-bridge's deploymentStorage: runAgent enters the scope per example, so
// concurrent examples (a future maxConcurrency > 1) can never cross-tag each other's calls.
const exampleStorage = new AsyncLocalStorage<{ key: string }>();

export function runWithExampleTag<T>(key: string, fn: () => Promise<T>): Promise<T> {
	return exampleStorage.run({ key }, fn);
}

export function currentExampleTag(): string {
	return exampleStorage.getStore()?.key ?? "untagged";
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		// Circular or otherwise unserializable -- degrade to its string form, never throw.
		return JSON.stringify(String(value));
	}
}

function appendJsonl(filePath: string, record: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		appendFileSync(filePath, `${safeJson(record)}\n`);
	} catch (error) {
		console.warn(`fixture-recorder: append to ${filePath} failed (${String(error)}); eval result unaffected`);
	}
}

export interface RecorderContext {
	dir: string;
	// The A/B leg this run belongs to (sub-agent model override, or "manifest-default").
	leg: string;
}

// Proxy-on-invoke, same idiom as aws-tool-estate-wrapper.ts: intercept only `invoke`,
// delegate every other property. The audit record is appended in `finally`, so the caller
// always sees the exact result or error it would have seen with no recorder installed.
export function recordingToolMiddleware(ctx: RecorderContext) {
	return (serverName: string, tool: StructuredToolInterface): StructuredToolInterface =>
		new Proxy(tool, {
			get(target, prop, receiver) {
				if (prop !== "invoke") {
					const value = Reflect.get(target, prop, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				}
				return async (input: unknown, config?: unknown) => {
					const startedAt = Date.now();
					let outcome: { result?: unknown; error?: string } = {};
					try {
						const result = await target.invoke(input as never, config as never);
						outcome = { result };
						return result;
					} catch (error) {
						outcome = { error: error instanceof Error ? error.message : String(error) };
						throw error;
					} finally {
						appendJsonl(join(ctx.dir, `tool-calls-${ctx.leg}.jsonl`), {
							example: currentExampleTag(),
							server: serverName,
							tool: tool.name,
							args: input,
							// Fan-out context that disambiguates otherwise-identical calls: the elastic
							// deployment (header-routed via ALS) and the AWS estate (ALS-injected arg).
							elasticDeployment: currentElasticDeploymentForTest(),
							awsEstate: currentAwsEstate(),
							ms: Date.now() - startedAt,
							...outcome,
						});
					}
				};
			},
		});
}

export function appendRecordedOutput(dir: string, leg: string, query: string, output: unknown): void {
	appendJsonl(join(dir, `outputs-${leg}.jsonl`), {
		key: exampleKey(query),
		query,
		leg,
		recordedAt: new Date().toISOString(),
		output,
	});
	updateManifest(dir, leg, query);
}

// Loads a leg's recorded outputs keyed by exampleKey; the LAST record per key wins, so
// re-recording an example (or a --repetitions run) replays the newest behavior.
export function readRecordedOutputs(dir: string, leg: string): Map<string, unknown> {
	const filePath = join(dir, `outputs-${leg}.jsonl`);
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (error) {
		throw new Error(
			`EVAL_FIXTURE_MODE=replay-outputs needs recorded outputs at ${filePath} -- run the live eval with EVAL_FIXTURE_MODE=record for leg "${leg}" first (${String(error)})`,
		);
	}
	const outputs = new Map<string, unknown>();
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line) as { key?: unknown; output?: unknown };
			if (typeof parsed.key === "string" && parsed.output !== undefined) {
				outputs.set(parsed.key, parsed.output);
			}
		} catch {
			// A torn line from a crash mid-append must not poison the rest of the store.
		}
	}
	return outputs;
}

// The ONLY committable file in the fixtures dir: query hash -> preview of the (already
// public, dataset-committed) query text + per-leg record counts. No payload content.
export function updateManifest(dir: string, leg: string, query: string): void {
	try {
		const manifestPath = join(dir, "MANIFEST.json");
		let manifest: Record<string, { queryPreview: string; legs: Record<string, number> }> = {};
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		} catch {
			// First write, or a hand-mangled manifest -- start fresh rather than fail the run.
		}
		const key = exampleKey(query);
		const entry = manifest[key] ?? { queryPreview: query.slice(0, 100), legs: {} };
		entry.legs[leg] = (entry.legs[leg] ?? 0) + 1;
		manifest[key] = entry;
		mkdirSync(dir, { recursive: true });
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	} catch (error) {
		console.warn(`fixture-recorder: manifest update failed (${String(error)}); eval result unaffected`);
	}
}
