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
import { DEFAULT_HUB_PORT, type FleetManifest, hubFor, loadManifest, spokeFor, spokeNames } from "./fleet/manifest.ts";
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
	// SIO-1666: selects a HUB by key (an AWS profile), not an environment -- an
	// environment no longer identifies one hub. `--env` is gone rather than
	// aliased: silently accepting it would pick an arbitrary hub of that
	// environment once a second one exists.
	hub?: string;
	tokenChanged: boolean;
	localPort: number;
};

export function parseFleetArgs(argv: string[]): FleetArgs {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			manifest: { type: "string", default: path.join(PKG_ROOT, "deploy", "fleet.yaml") },
			yes: { type: "boolean", default: false },
			hub: { type: "string" },
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
	const hub = values.hub as string | undefined;
	return {
		command,
		...(sub ? { sub } : {}),
		names: rest,
		manifest: values.manifest ?? "",
		yes: values.yes ?? false,
		...(hub ? { hub } : {}),
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

// SIO-1666: takes a HUB key. The state bucket lives in the hub's own account, so
// "the prd bucket" stops meaning anything once two prd hubs exist.
async function runBackendInit(manifest: FleetManifest, hubKey: string | undefined, aws: FleetAws): Promise<void> {
	if (!hubKey) throw new Error(`usage: fleet backend-init <hub>; hubs are ${Object.keys(manifest.hubs).join(", ")}`);
	const hub = hubFor(manifest, hubKey);
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
			`note: set hubs.${hubKey}.account_id: "${id.account}" in the manifest so render names the bucket (${stateBucketName(manifest, hubKey)} today)`,
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

// SIO-1666: publishes to one hub, or to every hub when none is named.
async function runPublish(manifest: FleetManifest, hubKey: string | undefined): Promise<void> {
	const keys = hubKey ? [hubKey] : Object.keys(manifest.hubs);
	for (const e of keys) {
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

// SIO-1666: the local port comes from the HUB, not a shared CLI default -- two
// hubs must be able to tunnel side by side.
async function withHubTunnel<T>(
	manifest: FleetManifest,
	hubKey: string,
	aws: FleetAws,
	fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
	const hub = hubFor(manifest, hubKey);
	const localPort = hub.local_port;
	const hubId = await aws.instanceIdByName(hub.profile, hub.region, HUB_INSTANCE_TAG);
	if (!hubId) throw new Error(`${hubKey}: no running hub instance tagged Name=${HUB_INSTANCE_TAG}`);
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

// SIO-1666: token_env is required per hub. The old
// PI_COMS_NET_AUTH_TOKEN_<ENV> default collided the moment two hubs shared an
// environment -- both would read one variable, and the second would authenticate
// against the wrong hub's token.
function hubToken(manifest: FleetManifest, hubKey: string): string {
	const hub = hubFor(manifest, hubKey);
	const token = process.env[hub.token_env];
	if (!token)
		throw new Error(
			`${hub.token_env} is not set (an operator token for hub "${hubKey}" is needed to read its registry)`,
		);
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
	// SIO-1666: group by HUB. Two hubs may share an environment, so grouping by
	// env would open one tunnel and poll the wrong registry for half the spokes.
	const byHub = new Map<string, string[]>();
	for (const name of targets) {
		const key = spokeFor(manifest, name).hub;
		byHub.set(key, [...(byHub.get(key) ?? []), name]);
	}
	for (const [hubKey, envNames] of byHub) {
		const token = hubToken(manifest, hubKey);
		const ok = await withHubTunnel(manifest, hubKey, aws, async (baseUrl) => {
			const deadline = Date.now() + 10 * 60_000;
			let pending = envNames;
			while (pending.length > 0 && Date.now() < deadline) {
				const agents = await listAgents(baseUrl, token, hubFor(manifest, hubKey).project);
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

async function runStatus(manifest: FleetManifest, names: string[], aws: FleetAws): Promise<void> {
	const rows = await preflight(manifest, names, aws);
	const credentialRows = rows.filter((r) => r.check === "credentials");
	console.log(formatPreflight(credentialRows));
	const targets = spokeNames(manifest, names);
	const byHub = new Map<string, string[]>();
	for (const name of targets) {
		const key = spokeFor(manifest, name).hub;
		byHub.set(key, [...(byHub.get(key) ?? []), name]);
	}
	for (const [hubKey, envNames] of byHub) {
		const token = hubToken(manifest, hubKey);
		await withHubTunnel(manifest, hubKey, aws, async (baseUrl) => {
			const agents = await listAgents(baseUrl, token, hubFor(manifest, hubKey).project);
			for (const name of envNames) {
				const problems = missingOnHub(agents, name, {});
				const agent = agents.find((a) => a.name === name);
				console.log(
					`${hubKey} ${name.padEnd(28)} ${problems.length === 0 ? "online" : problems.join("; ")}${agent ? `  purpose: ${agent.purpose}` : ""}`,
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
			await runPublish(manifest, args.hub);
			return 0;
		case "rollout":
			return (await runRollout(manifest, args.names, aws, {
				tokenChanged: args.tokenChanged,
				localPort: args.localPort,
			}))
				? 0
				: 1;
		case "status":
			await runStatus(manifest, args.names, aws);
			return 0;
		case "deploy": {
			if (!(await runPreflight(manifest, args.names, aws))) return 1;
			const tokenChanged = await runTokens(manifest, "ensure", args.names, aws);
			renderAll(manifest, args.names);
			await runTerraform(manifest, args.names, "apply", args.yes);
			// SIO-1685: publish per HUB of the selected spokes. This used to pass the
			// environment, which the SIO-1666 rekey turned into an unknown hub key.
			const hubs = new Set(spokeNames(manifest, args.names).map((n) => spokeFor(manifest, n).hub));
			for (const hubKey of hubs) await runPublish(manifest, hubKey);
			const ok = await runRollout(manifest, args.names, aws, { tokenChanged, localPort: args.localPort });
			await runStatus(manifest, args.names, aws);
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
