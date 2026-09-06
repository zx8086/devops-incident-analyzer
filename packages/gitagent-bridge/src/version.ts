// gitagent-bridge/src/version.ts
// SIO-1649: agent.yaml `version` becomes load-bearing. Semver validation runs
// in loadAgent, the tag gate runs in the release workflow and the exporter,
// and the provenance header stamps every exported context file.

export const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export type Semver = { major: number; minor: number; patch: number; prerelease?: string };

export function parseSemver(version: string): Semver | undefined {
	const m = SEMVER_RE.exec(version);
	if (!m?.[1] || !m[2] || !m[3]) return undefined;
	const parsed: Semver = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
	if (m[4]) parsed.prerelease = m[4];
	return parsed;
}

export function assertValidVersion(agentName: string, version: string): void {
	if (!parseSemver(version)) {
		throw new Error(`agent "${agentName}": version "${version}" is not semver (MAJOR.MINOR.PATCH[-prerelease])`);
	}
}

// The release tag is the version marker (no release asset): pi-fleet-vX.Y.Z
// must name exactly the manifest version it was cut from.
export function assertVersionMatchesTag(version: string, tag: string, prefix = "pi-fleet-v"): void {
	if (!tag.startsWith(prefix)) {
		throw new Error(`tag "${tag}" does not start with "${prefix}"`);
	}
	const tagVersion = tag.slice(prefix.length);
	if (tagVersion !== version) {
		throw new Error(`tag "${tag}" names version "${tagVersion}" but the manifest says "${version}"`);
	}
}

export function provenanceHeader(name: string, version: string, sha?: string): string {
	return sha ? `<!-- ${name} v${version} (analyzer ${sha}) -->` : `<!-- ${name} v${version} -->`;
}
