// scripts/hub-tunnel-target.ts
// SIO-1653: resolve an environment name to its hub's connection details for the
// `just hub-tunnel` and `just coms-env` recipes. Prints shell assignments
// (PROFILE/REGION/PORT, plus PROJECT when set) for eval. The manifest is
// gitignored, so an absent one is not an error: hub-tunnel falls back to
// built-in defaults. A manifest that EXISTS but lacks the environment is an
// error -- the name is wrong or that hub is undeployed.
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

const [manifestPath, env] = process.argv.slice(2);
if (!manifestPath || !env) {
	console.error("usage: hub-tunnel-target.ts <manifest> <env>");
	process.exit(2);
}
if (!existsSync(manifestPath)) process.exit(0);

const doc = parse(readFileSync(manifestPath, "utf8")) as {
	hubs?: Record<string, { profile?: string; region?: string; url?: string; project?: string }>;
};
const hubs = doc?.hubs ?? {};
const hub = hubs[env];
if (!hub) {
	const known = Object.keys(hubs).sort().join(", ") || "none";
	console.error(`no hub "${env}" in ${manifestPath} (have: ${known})`);
	process.exit(1);
}
// The hub port lives in the url (http://<ip>:<port>); default when absent.
const port = hub.url?.match(/:(\d+)\s*$/)?.[1] ?? "8787";
const sh = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
if (hub.profile) console.log(`PROFILE=${sh(hub.profile)}`);
if (hub.region) console.log(`REGION=${sh(hub.region)}`);
console.log(`PORT=${sh(port)}`);
// The coms-net project namespace, for `just coms-env`. One project per
// ENVIRONMENT, so a console cannot silently address the wrong fleet.
if (hub.project) console.log(`PROJECT=${sh(hub.project)}`);
