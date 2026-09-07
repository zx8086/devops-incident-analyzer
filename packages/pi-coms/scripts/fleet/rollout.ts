// scripts/fleet/rollout.ts
// SIO-1653: converge a spoke host on the published bundle and prove it on the
// hub. Normal rollouts go through /usr/local/bin/pi-coms-update, which writes
// the reload sentinel the agent relaunch depends on (SIO-1599); a token change
// re-runs the bootstrap with the sentinel touched first, because pi-coms-update
// would see an unchanged bundle version and exit early.
import type { FleetAws } from "./aws.ts";
import { type FleetManifest, spokeFor } from "./manifest.ts";

export const AGENT_INSTANCE_TAG = "pi-agent-agent";
// The hub instance Name tag: <name_prefix>-hub with the module default prefix
// "pi-coms". Was "pi-coms-hub-hub" until the prefix dropped its redundant -hub
// (it already said hub, and the module appends the component).
export const HUB_INSTANCE_TAG = "pi-coms-hub";

export function rolloutCommands(opts: { tokenChanged: boolean }): string[] {
	if (opts.tokenChanged) {
		return [
			"touch /home/piagent/.pi-agent-reload",
			"chown piagent:piagent /home/piagent/.pi-agent-reload || true",
			"bash /var/lib/cloud/instance/user-data.txt",
		];
	}
	return ["/usr/local/bin/pi-coms-update"];
}

export async function triggerRollout(
	manifest: FleetManifest,
	name: string,
	aws: FleetAws,
	opts: { tokenChanged: boolean },
): Promise<{ instanceId: string; commandId: string }> {
	const spoke = spokeFor(manifest, name);
	const region = manifest.defaults.region;
	const instanceId = await aws.instanceIdByName(spoke.profile, region, AGENT_INSTANCE_TAG);
	if (!instanceId) throw new Error(`${name}: no running instance tagged Name=${AGENT_INSTANCE_TAG}; apply first`);
	const commandId = await aws.runShell(spoke.profile, region, instanceId, rolloutCommands(opts));
	return { instanceId, commandId };
}
