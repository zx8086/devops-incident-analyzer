// packages/agent/src/landing-zone/topology-reconcile.ts

import type {
	LandingZoneTopologyEntity,
	LandingZoneTopologyRelationship,
	LandingZoneTopologySnapshot,
	TopologyProvenance,
} from "./topology-extractor.ts";

export type TopologyReconciliationStatus = "aligned" | "drifted" | "pending" | "unknown" | "conflicting-evidence";

export interface ReconciledTopologyFact<T> {
	id: string;
	fact: T;
	provenance: TopologyProvenance[];
	reconciliation: { status: TopologyReconciliationStatus; confidence: "verified" | "unverified" };
	validFrom: string;
	validTo?: string;
	observedAt?: string;
	consecutiveMisses: number;
}

export interface ReconciledTopology {
	entities: Array<ReconciledTopologyFact<LandingZoneTopologyEntity>>;
	relationships: Array<ReconciledTopologyFact<LandingZoneTopologyRelationship>>;
}

export interface ReconcileTopologyInput {
	desired?: LandingZoneTopologySnapshot;
	observed?: LandingZoneTopologySnapshot;
	proposed?: LandingZoneTopologySnapshot;
	previous?: ReconciledTopology;
	missThreshold: number;
	now: string;
}

function comparable(value: LandingZoneTopologyEntity | LandingZoneTopologyRelationship): string {
	const record =
		"from" in value
			? { kind: value.kind, from: value.from, to: value.to, properties: value.properties }
			: value.kind === "vpc" || value.kind === "subnet"
				? {
						kind: value.kind,
						accountId: value.accountId,
						region: value.region,
						properties: value.properties,
					}
				: {
						kind: value.kind,
						name: value.name,
						accountId: value.accountId,
						region: value.region,
						properties: value.properties,
					};
	return stableStringify(record);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function factsAlign(
	desired: LandingZoneTopologyEntity | LandingZoneTopologyRelationship,
	observed: LandingZoneTopologyEntity | LandingZoneTopologyRelationship,
): boolean {
	if (desired.kind !== observed.kind || "from" in desired !== "from" in observed) return false;
	if ("from" in desired && "from" in observed) {
		if (desired.from !== observed.from || desired.to !== observed.to) return false;
	} else if (!("from" in desired) && !("from" in observed)) {
		if (desired.accountId && observed.accountId && desired.accountId !== observed.accountId) return false;
		if (desired.region && observed.region && desired.region !== observed.region) return false;
		if (desired.name && observed.name && desired.name !== observed.name && observed.name !== observed.id) return false;
	}
	for (const [key, expected] of Object.entries(desired.properties)) {
		const actual = observed.properties[key];
		if (actual !== undefined && actual !== expected) return false;
	}
	return true;
}

function entityIdentityKey(entity: LandingZoneTopologyEntity): string {
	if ((entity.kind === "vpc" || entity.kind === "subnet") && entity.accountId && entity.region) {
		const cidr = entity.properties.cidr;
		if (typeof cidr === "string" && cidr) return `${entity.kind}:${entity.accountId}:${entity.region}:${cidr}`;
	}
	if (entity.kind === "ip-address" && typeof entity.properties.ip === "string")
		return `${entity.kind}:${entity.properties.ip}`;
	if (entity.kind === "cidr-block" && typeof entity.properties.cidr === "string")
		return `${entity.kind}:${entity.properties.cidr}`;
	if (entity.kind === "region" && entity.name) return `${entity.kind}:${entity.name}`;
	if (entity.kind === "availability-zone" && entity.name) return `${entity.kind}:${entity.name}`;
	return entity.id;
}

function reconcileFacts<T extends LandingZoneTopologyEntity | LandingZoneTopologyRelationship>(
	desired: T[],
	observed: T[] | undefined,
	proposed: T[],
	previous: Array<ReconciledTopologyFact<T>>,
	missThreshold: number,
	now: string,
	identityKey: (fact: T) => string = (fact) => fact.id,
): Array<ReconciledTopologyFact<T>> {
	const desiredById = new Map(desired.map((fact) => [identityKey(fact), fact]));
	const observedById = new Map((observed ?? []).map((fact) => [identityKey(fact), fact]));
	const proposedById = new Map(proposed.map((fact) => [identityKey(fact), fact]));
	const previousById = new Map(previous.map((fact) => [identityKey(fact.fact), fact]));
	const conflictingKeys = new Set<string>();
	for (const facts of [desired, observed ?? []]) {
		const grouped = new Map<string, T[]>();
		for (const fact of facts) grouped.set(identityKey(fact), [...(grouped.get(identityKey(fact)) ?? []), fact]);
		for (const [key, group] of grouped) if (new Set(group.map(comparable)).size > 1) conflictingKeys.add(key);
	}
	const ids = new Set([...desiredById.keys(), ...observedById.keys(), ...proposedById.keys(), ...previousById.keys()]);
	const output: Array<ReconciledTopologyFact<T>> = [];

	for (const id of [...ids].sort()) {
		const desiredFact = desiredById.get(id);
		const observedFact = observedById.get(id);
		const proposedFact = proposedById.get(id);
		const prior = previousById.get(id);
		const fact = desiredFact ?? observedFact ?? proposedFact ?? prior?.fact;
		if (!fact) continue;
		const currentProvenance = [
			desiredFact?.provenance,
			observedFact?.provenance,
			proposedFact ? { ...proposedFact.provenance, state: "proposed" as const } : undefined,
		].filter((item): item is TopologyProvenance => Boolean(item));
		const provenance = [...(prior?.provenance ?? []), ...currentProvenance].filter(
			(item, index, all) =>
				all.findIndex(
					(candidate) =>
						candidate.state === item.state &&
						candidate.source === item.source &&
						candidate.resourceId === item.resourceId &&
						candidate.commitSha === item.commitSha,
				) === index,
		);
		let status: TopologyReconciliationStatus;
		if (conflictingKeys.has(id)) status = "conflicting-evidence";
		else if (desiredFact && observedFact) status = factsAlign(desiredFact, observedFact) ? "aligned" : "drifted";
		else if (proposedFact) status = "pending";
		else status = "unknown";

		const observationWasAttempted = observed !== undefined;
		const missed =
			observationWasAttempted &&
			!observedFact &&
			Boolean(
				prior &&
					(prior.provenance.some((item) => item.state === "observed") ||
						prior.reconciliation.status === "aligned" ||
						prior.consecutiveMisses > 0),
			);
		const consecutiveMisses = observedFact
			? 0
			: missed
				? (prior?.consecutiveMisses ?? 0) + 1
				: (prior?.consecutiveMisses ?? 0);
		const reactivated = Boolean(observedFact && prior?.validTo);
		const validTo = reactivated
			? undefined
			: consecutiveMisses >= missThreshold
				? (prior?.validTo ?? now)
				: prior?.validTo;
		output.push({
			id: desiredFact?.id ?? observedFact?.id ?? proposedFact?.id ?? prior?.id ?? id,
			fact,
			provenance,
			reconciliation: { status, confidence: status === "aligned" ? "verified" : "unverified" },
			validFrom: reactivated ? now : (prior?.validFrom ?? now),
			...(validTo && { validTo }),
			...(observedFact?.provenance.observedAt && { observedAt: observedFact.provenance.observedAt }),
			consecutiveMisses,
		});
	}
	return output;
}

export function reconcileTopology(input: ReconcileTopologyInput): ReconciledTopology {
	if (!Number.isInteger(input.missThreshold) || input.missThreshold < 1)
		throw new Error("missThreshold must be a positive integer");
	if (Number.isNaN(Date.parse(input.now))) throw new Error("now must be an ISO timestamp");
	const entityGroups = new Map<string, LandingZoneTopologyEntity[]>();
	for (const entity of [
		...(input.desired?.entities ?? []),
		...(input.observed?.entities ?? []),
		...(input.proposed?.entities ?? []),
		...(input.previous?.entities.map((item) => item.fact) ?? []),
	]) {
		const key = entityIdentityKey(entity);
		const group = entityGroups.get(key) ?? [];
		group.push(entity);
		entityGroups.set(key, group);
	}
	const canonicalEntityIds = new Map<string, string>();
	for (const group of entityGroups.values()) {
		const desiredId = group.find((entity) => entity.provenance.state === "desired")?.id;
		const canonicalId = desiredId ?? group[0]?.id;
		if (!canonicalId) continue;
		for (const entity of group) canonicalEntityIds.set(entity.id, canonicalId);
	}
	const normalizeRelationship = (relationship: LandingZoneTopologyRelationship): LandingZoneTopologyRelationship => ({
		...relationship,
		from: canonicalEntityIds.get(relationship.from) ?? relationship.from,
		to: canonicalEntityIds.get(relationship.to) ?? relationship.to,
	});
	return {
		entities: reconcileFacts(
			input.desired?.entities ?? [],
			input.observed?.entities,
			input.proposed?.entities ?? [],
			input.previous?.entities ?? [],
			input.missThreshold,
			input.now,
			entityIdentityKey,
		),
		relationships: reconcileFacts(
			(input.desired?.relationships ?? []).map(normalizeRelationship),
			input.observed?.relationships.map(normalizeRelationship),
			(input.proposed?.relationships ?? []).map(normalizeRelationship),
			(input.previous?.relationships ?? []).map((item) => ({ ...item, fact: normalizeRelationship(item.fact) })),
			input.missThreshold,
			input.now,
			(relationship) => `${relationship.kind}:${relationship.from}:${relationship.to}`,
		),
	};
}
