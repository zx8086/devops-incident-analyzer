// scripts/hub-tunnel-target.ts
// SIO-1653: resolve a hub SELECTOR to its connection details for the
// `just hub-tunnel` and `just coms-env` recipes. Prints shell assignments
// (PROFILE/REGION/PORT/LOCAL_PORT, plus PROJECT when set) for eval.
//
// The selector is an environment key ("prd"), an AWS profile
// ("eu-shared-services-prd") or an account id, because a fleet can run more
// than one hub per environment: keying only on the environment would make a
// second prd hub unaddressable. Profile and account are matched across every
// hub entry, so they stay unambiguous as hubs are added.
//
// The manifest is gitignored, so an absent one is not an error: hub-tunnel
// falls back to built-in defaults. A manifest that EXISTS but does not match
// is an error -- the selector is wrong or that hub is undeployed.
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";

type Hub = {
	profile?: string;
	region?: string;
	url?: string;
	project?: string;
	account_id?: string;
	local_port?: number | string;
};

const [manifestPath, selector] = process.argv.slice(2);
if (!manifestPath || !selector) {
	console.error("usage: hub-tunnel-target.ts <manifest> <env|profile|account-id>");
	process.exit(2);
}
if (!existsSync(manifestPath)) process.exit(0);

const doc = parse(readFileSync(manifestPath, "utf8")) as { hubs?: Record<string, Hub> };
const entries = Object.entries(doc?.hubs ?? {});

const matches = entries.filter(
	([env, h]) => env === selector || h.profile === selector || String(h.account_id ?? "") === selector,
);
if (matches.length === 0) {
	const known = entries
		.map(([env, h]) => (h.profile ? `${env} (${h.profile})` : env))
		.sort()
		.join(", ");
	console.error(`no hub "${selector}" in ${manifestPath} (have: ${known || "none"})`);
	process.exit(1);
}
// Two hubs answering one selector would silently pick one; name them instead.
if (matches.length > 1) {
	const names = matches.map(([env, h]) => (h.profile ? `${env} (${h.profile})` : env)).join(", ");
	console.error(`selector "${selector}" matches more than one hub: ${names}; use the environment key`);
	process.exit(1);
}

const [env, hub] = matches[0];
// The hub port lives in the url (http://<ip>:<port>); default when absent.
const port = hub.url?.match(/:(\d+)\s*$/)?.[1] ?? "8787";
// Each hub needs a distinct LOCAL port so several tunnels coexist. An explicit
// manifest `local_port` wins; otherwise derive from the environment suffix,
// which is what the old profile-suffix rule actually meant.
const derived = (() => {
	const base = Number(port);
	if (/-?(prd|prod)$/.test(env)) return base + 1;
	if (/-?stg$/.test(env)) return base + 2;
	return base;
})();
const localPort = hub.local_port !== undefined ? String(hub.local_port) : String(derived);

const sh = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
console.log(`ENV_KEY=${sh(env)}`);
if (hub.profile) console.log(`PROFILE=${sh(hub.profile)}`);
if (hub.region) console.log(`REGION=${sh(hub.region)}`);
console.log(`PORT=${sh(port)}`);
console.log(`LOCAL_PORT=${sh(localPort)}`);
// The coms-net project namespace, for `just coms-env`.
if (hub.project) console.log(`PROJECT=${sh(hub.project)}`);
