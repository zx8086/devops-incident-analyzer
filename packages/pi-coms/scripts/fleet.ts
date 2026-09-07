#!/usr/bin/env bun
// scripts/fleet.ts
//
// SIO-1653: manifest-driven fleet deploy.
//
//   just fleet preflight [names]
//   just fleet tokens ensure|rotate [names]
//   just fleet render [names]
//   just fleet backend-init <env>
//   just fleet plan [names]
//   just fleet apply [names] [--yes]
//   just fleet publish [--env dev|prd]
//   just fleet rollout [names] [--token-changed]
//   just fleet status [names]
//   just fleet deploy [names] [--yes]
//
// Manifest: deploy/fleet.yaml (--manifest to override). Every step is idempotent
// and resumable per account; production accounts plan by default and apply only
// with --yes. main() is guarded by import.meta.main.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { type FleetAws, realFleetAws } from "./fleet/aws.ts";
import { listAgents, missingOnHub } from "./fleet/hub.ts";
import {
	DEFAULT_HUB_PORT,
	type FleetEnvironment,
	type FleetManifest,
	hubFor,
	loadManifest,
	spokeFor,
	spokeNames,
} from "./fleet/manifest.ts";
import { formatPreflight, preflight, preflightPassed } from "./fleet/preflight.ts";
import { renderRoot, stateBucketName } from "./fleet/render.ts";
import { HUB_INSTANCE_TAG, triggerRollout } from "./fleet/rollout.ts";
import { terraformApply, terraformInit, terraformPlan } from "./fleet/terraform.ts";
import { ensureToken } from "./fleet/tokens.ts";

const PKG_ROOT = path.resolve(import.meta.dir, "..");
const ACCOUNTS_DIR = path.join(PKG_ROOT, "deploy", "accounts");

export type FleetArgs = {
	command: string;
	sub?: string;
	names: string[];
	manifest: string;
	yes: boolean;
	env?: FleetEnvironment;
	tokenChanged: boolean;
	localPort: number;
};

export function parseFleetArgs(argv: string[]): FleetArgs {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			manifest: { type: "string", default: path.join(PKG_ROOT, "deploy", "fleet.yaml") },
			yes: { type: "boolean", default: false },
			env: { type: "string" },
			"token-changed": { type: "boolean", default: false },
			"local-port": { type: "string", default: "8788" },
		},
		allowPositionals: true,
	});
	const [command, ...rest] = positionals;
	if (!command)
		throw new Error(
			"usage: fleet <preflight|tokens|render|backend-init|plan|apply|publish|rollout|status|deploy> [names]",
		);
	const sub = command === "tokens" || command === "backend-init" ? rest.shift() : undefined;
	const env = values.env as FleetEnvironment | undefined;
	return {
		command,
		...(sub ? { sub } : {}),
		names: rest,
		manifest: values.manifest ?? "",
		yes: values.yes ?? false,
		...(env ? { env } : {}),
		tokenChanged: values["token-changed"] ?? false,
		localPort: Number(values["local-port"] ?? 8788),
	};
}

function rootDir(name: string): string {
	return path.join(ACCOUNTS_DIR, name);
}

function isProduction(manifest: FleetManifest, name: string): boolean {
	return spokeFor(manifest, name).env === "prd";
}

function renderAll(manifest: FleetManifest, names: string[]): void {
	for (const name of spokeNames(manifest, names)) {
		const dir = rootDir(name);
		mkdirSync(dir, { recursive: true });
		const tfvarsPath = path.join(dir, "terraform.tfvars");
		const existing = existsSync(tfvarsPath) ? readFileSync(tfvarsPath, "utf-8") : undefined;
		const files = renderRoot(manifest, name, existing);
		for (const [file, content] of Object.entries(files)) {
			writeFileSync(path.join(dir, file), content, { mode: file === "terraform.tfvars" ? 0o600 : 0o644 });
		}
		console.log(`rendered ${dir} (${Object.keys(files).join(", ")})`);
	}
}

async function runPreflight(manifest: FleetManifest, names: string[], aws: FleetAws): Promise<boolean> {
	const rows = await preflight(manifest, names, aws);
	console.log(formatPreflight(rows));
	const ok = preflightPassed(rows);
	console.log(ok ? "preflight: all checks passed" : "preflight: FAILED (nothing was changed)");
	return ok;
}

async function runTokens(
	manifest: FleetManifest,
	sub: string | undefined,
	names: string[],
	aws: FleetAws,
): Promise<boolean> {
	if (sub !== "ensure" && sub !== "rotate") throw new Error("usage: fleet tokens ensure|rotate [names]");
	let changed = false;
	for (const name of spokeNames(manifest, names)) {
		const result = await ensureToken(manifest, name, aws, { accountsDir: ACCOUNTS_DIR, rotate: sub === "rotate" });
		changed = changed || result.minted;
		console.log(`${result.minted ? "minted " : "kept   "} ${name}: ${result.reason}`);
	}
	return changed;
}

async function runBackendInit(manifest: FleetManifest, env: string | undefined, aws: FleetAws): Promise<void> {
	if (env !== "dev" && env !== "stg" && env !== "prd") throw new Error("usage: fleet backend-init <dev|stg|prd>");
	const hub = hubFor(manifest, env);
	const id = await aws.callerIdentity(hub.profile, hub.region);
	const bucket = `pi-coms-tfstate-${id.account}`;
	if (await aws.bucketExists(hub.profile, hub.region, bucket)) {
		console.log(`state bucket ${bucket} already exists in ${hub.profile}`);
		return;
	}
	await aws.createStateBucket(hub.profile, hub.region, bucket);
	console.log(`created state bucket ${bucket} (versioned, public access blocked) in ${hub.profile}`);
	if (hub.account_id !== id.account) {
		console.log(
			`note: set hubs.${env}.account_id: "${id.account}" in the manifest so render names the bucket (${stateBucketName(manifest, env)} today)`,
		);
	}
}

async function runTerraform(
	manifest: FleetManifest,
	names: string[],
	mode: "plan" | "apply",
	yes: boolean,
): Promise<void> {
	for (const name of spokeNames(manifest, names)) {
		const root = rootDir(name);
		if (!existsSync(path.join(root, "backend.hcl")) || !existsSync(path.join(root, "terraform.tfvars"))) {
			throw new Error(`${name}: backend.hcl or terraform.tfvars missing; run: fleet render ${name}`);
		}
		console.log(`== ${mode} ${name} (${root})`);
		await terraformInit(root);
		if (mode === "plan") await terraformPlan(root);
		else await terraformApply(root, { production: isProduction(manifest, name), yes });
	}
}

async function runPublish(manifest: FleetManifest, env: FleetEnvironment | undefined): Promise<void> {
	const envs = (env ? [env] : (Object.keys(manifest.hubs) as FleetEnvironment[])).filter((e) => manifest.hubs[e]);
	for (const e of envs) {
		const hub = hubFor(manifest, e);
		const bucket = hub.dist_bucket ?? `pi-coms-dist-${hub.account_id ?? ""}`;
		if (!bucket.endsWith("-") && hub.account_id === undefined && !hub.dist_bucket)
			throw new Error(`hubs.${e}: set dist_bucket or account_id`);
		console.log(`== publish ${e} -> s3://${bucket}/fleet (profile ${hub.profile})`);
		const proc = Bun.spawn(["bash", path.join(PKG_ROOT, "deploy", "publish-fleet.sh"), bucket, hub.profile], {
			cwd: PKG_ROOT,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await proc.exited;
		if (code !== 0) throw new Error(`publish-fleet.sh failed for ${e} (exit ${code})`);
	}
}

async function withHubTunnel<T>(
	manifest: FleetManifest,
	env: FleetEnvironment,
	localPort: number,
	aws: FleetAws,
	fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
	const hub = hubFor(manifest, env);
	const hubId = await aws.instanceIdByName(hub.profile, hub.region, HUB_INSTANCE_TAG);
	if (!hubId) throw new Error(`${env}: no running hub instance tagged Name=${HUB_INSTANCE_TAG}`);
	const port = hub.port ?? DEFAULT_HUB_PORT;
	const tunnel = Bun.spawn(
		[
			"aws",
			"ssm",
			"start-session",
			"--profile",
			hub.profile,
			"--region",
			hub.region,
			"--target",
			hubId,
			"--document-name",
			"AWS-StartPortForwardingSession",
			"--parameters",
			JSON.stringify({ portNumber: [String(port)], localPortNumber: [String(localPort)] }),
		],
		{ stdout: "ignore", stderr: "inherit" },
	);
	try {
		const baseUrl = `http://127.0.0.1:${localPort}`;
		for (let i = 0; i < 30; i++) {
			try {
				const r = await fetch(`${baseUrl}/health`);
				if (r.ok) break;
			} catch {
				// tunnel not up yet
			}
			await Bun.sleep(1000);
		}
		return await fn(baseUrl);
	} finally {
		tunnel.kill();
		await tunnel.exited;
	}
}

function hubToken(manifest: FleetManifest, env: FleetEnvironment): string {
	const hub = hubFor(manifest, env);
	const varName = hub.token_env ?? `PI_COMS_NET_AUTH_TOKEN_${env.toUpperCase()}`;
	const token = process.env[varName];
	if (!token)
		throw new Error(`${varName} is not set (an operator token for the ${env} hub is needed to read its registry)`);
	return token;
}

async function runRollout(
	manifest: FleetManifest,
	names: string[],
	aws: FleetAws,
	opts: { tokenChanged: boolean; localPort: number },
): Promise<boolean> {
	const targets = spokeNames(manifest, names);
	for (const name of targets) {
		const { instanceId, commandId } = await triggerRollout(manifest, name, aws, { tokenChanged: opts.tokenChanged });
		console.log(`rollout ${name}: instance ${instanceId}, command ${commandId}`);
	}
	const persona = manifest.persona?.min_version;
	let allOk = true;
	const byEnv = new Map<FleetEnvironment, string[]>();
	for (const name of targets) {
		const env = spokeFor(manifest, name).env;
		byEnv.set(env, [...(byEnv.get(env) ?? []), name]);
	}
	for (const [env, envNames] of byEnv) {
		const token = hubToken(manifest, env);
		const ok = await withHubTunnel(manifest, env, opts.localPort, aws, async (baseUrl) => {
			const deadline = Date.now() + 10 * 60_000;
			let pending = envNames;
			while (pending.length > 0 && Date.now() < deadline) {
				const agents = await listAgents(baseUrl, token, hubFor(manifest, env).project);
				pending = pending.filter((name) => {
					const problems = missingOnHub(agents, name, persona ? { persona } : {});
					if (problems.length === 0)
						console.log(`${name}: online with monitor${persona ? ` and persona v${persona}` : ""}`);
					else console.log(`${name}: waiting (${problems.join("; ")})`);
					return problems.length > 0;
				});
				if (pending.length > 0) await Bun.sleep(15_000);
			}
			return pending.length === 0;
		});
		allOk = allOk && ok;
	}
	return allOk;
}

async function runStatus(manifest: FleetManifest, names: string[], aws: FleetAws, localPort: number): Promise<void> {
	const rows = await preflight(manifest, names, aws);
	const credentialRows = rows.filter((r) => r.check === "credentials");
	console.log(formatPreflight(credentialRows));
	const targets = spokeNames(manifest, names);
	const byEnv = new Map<FleetEnvironment, string[]>();
	for (const name of targets) {
		const env = spokeFor(manifest, name).env;
		byEnv.set(env, [...(byEnv.get(env) ?? []), name]);
	}
	for (const [env, envNames] of byEnv) {
		const token = hubToken(manifest, env);
		await withHubTunnel(manifest, env, localPort, aws, async (baseUrl) => {
			const agents = await listAgents(baseUrl, token, hubFor(manifest, env).project);
			for (const name of envNames) {
				const problems = missingOnHub(agents, name, {});
				const agent = agents.find((a) => a.name === name);
				console.log(
					`${env} ${name.padEnd(28)} ${problems.length === 0 ? "online" : problems.join("; ")}${agent ? `  purpose: ${agent.purpose}` : ""}`,
				);
			}
		});
	}
}

export async function main(argv: string[], aws: FleetAws = realFleetAws): Promise<number> {
	const args = parseFleetArgs(argv);
	const manifest = loadManifest(args.manifest);
	switch (args.command) {
		case "preflight":
			return (await runPreflight(manifest, args.names, aws)) ? 0 : 1;
		case "tokens":
			await runTokens(manifest, args.sub, args.names, aws);
			return 0;
		case "render":
			renderAll(manifest, args.names);
			return 0;
		case "backend-init":
			await runBackendInit(manifest, args.sub, aws);
			return 0;
		case "plan":
			await runTerraform(manifest, args.names, "plan", false);
			return 0;
		case "apply":
			await runTerraform(manifest, args.names, "apply", args.yes);
			return 0;
		case "publish":
			await runPublish(manifest, args.env);
			return 0;
		case "rollout":
			return (await runRollout(manifest, args.names, aws, {
				tokenChanged: args.tokenChanged,
				localPort: args.localPort,
			}))
				? 0
				: 1;
		case "status":
			await runStatus(manifest, args.names, aws, args.localPort);
			return 0;
		case "deploy": {
			if (!(await runPreflight(manifest, args.names, aws))) return 1;
			const tokenChanged = await runTokens(manifest, "ensure", args.names, aws);
			renderAll(manifest, args.names);
			await runTerraform(manifest, args.names, "apply", args.yes);
			const envs = new Set(spokeNames(manifest, args.names).map((n) => spokeFor(manifest, n).env));
			for (const env of envs) await runPublish(manifest, env);
			const ok = await runRollout(manifest, args.names, aws, { tokenChanged, localPort: args.localPort });
			await runStatus(manifest, args.names, aws, args.localPort);
			return ok ? 0 : 1;
		}
		default:
			throw new Error(`unknown command "${args.command}"`);
	}
}

if (import.meta.main) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error("fleet failed:", error instanceof Error ? error.message : String(error));
			process.exit(1);
		});
}
