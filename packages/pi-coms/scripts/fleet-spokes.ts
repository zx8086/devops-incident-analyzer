// scripts/fleet-spokes.ts
// SIO-1762: the spokes bound to a hub, for the read-only observer layout.
//   fleet-spokes.ts <manifest> <hub-selector>   one "name profile region" line per spoke
//   fleet-spokes.ts <manifest> --spoke <name>   that spoke's "name profile region"
// The selector is a hub key, its AWS profile or its account id, matching
// hub-tunnel-target.ts so `just coms <selector> ... --observe` reuses the word.
import { loadManifest } from "./fleet/manifest.ts";

const argv = process.argv.slice(2);
const [manifestPath, a, b] = argv;
if (!manifestPath || !a) {
	console.error("usage: fleet-spokes.ts <manifest> <hub-selector> | --spoke <name>");
	process.exit(2);
}
const manifest = loadManifest(manifestPath);

const line = (name: string): string => {
	const spoke = manifest.spokes[name];
	if (!spoke) throw new Error(`unknown spoke "${name}"`);
	const region = manifest.hubs[spoke.hub]?.region ?? manifest.defaults.region;
	return `${name} ${spoke.profile} ${region}`;
};

if (a === "--spoke") {
	if (!b) {
		console.error("--spoke needs a name");
		process.exit(2);
	}
	console.log(line(b));
} else {
	const key = Object.keys(manifest.hubs).find(
		(k) => k === a || manifest.hubs[k]?.profile === a || manifest.hubs[k]?.account_id === a,
	);
	if (!key) {
		console.error(`no hub "${a}" in ${manifestPath} (have: ${Object.keys(manifest.hubs).sort().join(", ")})`);
		process.exit(3);
	}
	const names = Object.keys(manifest.spokes)
		.filter((n) => manifest.spokes[n]?.hub === key)
		.sort();
	for (const n of names) console.log(line(n));
}
