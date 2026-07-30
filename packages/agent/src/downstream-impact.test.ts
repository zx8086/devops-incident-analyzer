// agent/src/downstream-impact.test.ts
import { describe, expect, test } from "bun:test";
import type { GraphBlastRadiusHit, OrbitBlastRadius } from "@devops-agent/shared";
import {
	buildDownstreamImpact,
	resolveOrbitConsumerEdges,
	summarizeDownstreamImpactForPrompt,
} from "./downstream-impact.ts";

function nameMatchFinding(over: Partial<OrbitBlastRadius>): OrbitBlastRadius {
	return {
		definitionName: "getStyleByStyleCode",
		importedByProjects: [],
		importedByFiles: [],
		importSiteCount: 0,
		radiusMode: "definition-name-match",
		...over,
	};
}

function edgeFinding(over: Partial<OrbitBlastRadius>): OrbitBlastRadius {
	return {
		definitionName: "Auth::verify",
		importedByProjects: ["pvhcorp/checkout"],
		importedByFiles: [{ project: "pvhcorp/checkout", file: "pvhcorp/checkout/app.rb" }],
		importSiteCount: 1,
		...over,
	};
}

describe("resolveOrbitConsumerEdges", () => {
	test("resolves a name-match consumer repo to a DEPENDS_ON edge when both endpoints are known services", () => {
		const findings = [
			nameMatchFinding({ sourceProject: "pvhcorp/styles-v3-service" }),
			nameMatchFinding({ sourceProject: "pvhcorp/lists-api" }),
		];
		const edges = resolveOrbitConsumerEdges(findings, ["styles-v3-service"], ["styles-v3-service", "lists-api"]);
		expect(edges).toContainEqual({ kind: "depends-on", from: "lists-api", to: "styles-v3-service" });
	});

	test("skips edge-confirmed (non-fallback) findings entirely", () => {
		const findings = [edgeFinding({ sourceProject: "pvhcorp/styles-v3-service" })];
		const edges = resolveOrbitConsumerEdges(findings, ["styles-v3-service"], ["styles-v3-service"]);
		expect(edges).toEqual([]);
	});

	test("P6: skips a consumer repo that does not normalize-match a known service (never guesses)", () => {
		const findings = [
			nameMatchFinding({ sourceProject: "pvhcorp/styles-v3-service" }),
			nameMatchFinding({ sourceProject: "pvhcorp/totally-unknown-repo" }),
		];
		const edges = resolveOrbitConsumerEdges(findings, ["styles-v3-service"], ["styles-v3-service"]);
		expect(edges).toEqual([]);
	});

	test("does not self-edge when the only finding is the definition's own repo", () => {
		const findings = [nameMatchFinding({ sourceProject: "pvhcorp/styles-v3-service" })];
		const edges = resolveOrbitConsumerEdges(findings, ["styles-v3-service"], ["styles-v3-service"]);
		expect(edges).toEqual([]);
	});

	test("dedupes repeated from/to pairs across multiple findings", () => {
		const findings = [
			nameMatchFinding({ definitionName: "a", sourceProject: "pvhcorp/styles-v3-service" }),
			nameMatchFinding({ definitionName: "b", sourceProject: "pvhcorp/styles-v3-service" }),
			nameMatchFinding({ definitionName: "c", sourceProject: "pvhcorp/lists-api" }),
		];
		const edges = resolveOrbitConsumerEdges(findings, ["styles-v3-service"], ["styles-v3-service", "lists-api"]);
		expect(edges).toHaveLength(1);
	});

	// CodeRabbit (PR #547, round 2): normalize() does not trim whitespace, so a
	// known-service-name list entry with incidental padding would fail to match.
	test("whitespace-padded known service names still resolve", () => {
		const findings = [
			nameMatchFinding({ sourceProject: "pvhcorp/styles-v3-service" }),
			nameMatchFinding({ sourceProject: "pvhcorp/lists-api" }),
		];
		const edges = resolveOrbitConsumerEdges(findings, [" styles-v3-service "], [" styles-v3-service ", " lists-api "]);
		expect(edges).toContainEqual({ kind: "depends-on", from: " lists-api ", to: " styles-v3-service " });
	});
});

describe("buildDownstreamImpact", () => {
	const apmHit: GraphBlastRadiusHit = {
		service: "styles-v3-service",
		neighbour: "lists-api",
		via: "depends-on",
		sharedResource: "",
	};

	test("APM-only hit renders as single-source apm", () => {
		const entries = buildDownstreamImpact([apmHit], [], ["styles-v3-service"]);
		expect(entries).toEqual([{ incidentService: "styles-v3-service", dependent: "lists-api", source: "apm" }]);
	});

	test("Orbit-only edge renders as single-source code", () => {
		const entries = buildDownstreamImpact(
			[],
			[{ kind: "depends-on", from: "lists-api", to: "styles-v3-service" }],
			["styles-v3-service"],
		);
		expect(entries).toEqual([{ incidentService: "styles-v3-service", dependent: "lists-api", source: "code" }]);
	});

	test("both sources naming the same dependent -> confirmed (two-source)", () => {
		const entries = buildDownstreamImpact(
			[apmHit],
			[{ kind: "depends-on", from: "lists-api", to: "styles-v3-service" }],
			["styles-v3-service"],
		);
		expect(entries).toEqual([{ incidentService: "styles-v3-service", dependent: "lists-api", source: "confirmed" }]);
	});

	// CodeRabbit (PR #547): apmDependents/codeDependents were keyed by raw names
	// while incidentSet used normalize() -- a casing/whitespace mismatch between
	// the two sources silently prevented a real match from merging into "confirmed".
	test("differently-cased service/dependent names from the two sources still merge into confirmed", () => {
		const casedHit: GraphBlastRadiusHit = {
			service: "Styles-V3-Service",
			neighbour: "Lists-API",
			via: "depends-on",
			sharedResource: "",
		};
		const entries = buildDownstreamImpact(
			[casedHit],
			[{ kind: "depends-on", from: "lists-api", to: "styles-v3-service" }],
			["styles-v3-service"],
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.source).toBe("confirmed");
	});

	// CodeRabbit (PR #547, round 2): normalize() does not trim whitespace, so a
	// leading/trailing-space variant from one source would not merge with the
	// other even after the casing fix above.
	test("leading/trailing whitespace in one source's names still merges into confirmed", () => {
		const paddedHit: GraphBlastRadiusHit = {
			service: " styles-v3-service ",
			neighbour: " lists-api ",
			via: "depends-on",
			sharedResource: "",
		};
		const entries = buildDownstreamImpact(
			[paddedHit],
			[{ kind: "depends-on", from: "lists-api", to: "styles-v3-service" }],
			["styles-v3-service"],
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.source).toBe("confirmed");
	});

	test("excludes the reverse-direction APM hit (incident service depends on X, not X depends on incident service)", () => {
		// service=lists-api, neighbour=styles-v3-service is the OTHER direction of
		// the same depends-on edge -- not anchored on the incident service.
		const reverseHit: GraphBlastRadiusHit = {
			service: "lists-api",
			neighbour: "styles-v3-service",
			via: "depends-on",
			sharedResource: "",
		};
		const entries = buildDownstreamImpact([reverseHit], [], ["styles-v3-service"]);
		expect(entries).toEqual([]);
	});

	test("excludes non-depends-on via kinds (kafka-topic, telemetry-source, aws-resource)", () => {
		const kafkaHit: GraphBlastRadiusHit = {
			service: "styles-v3-service",
			neighbour: "refunds",
			via: "kafka-topic",
			sharedResource: "events",
		};
		const entries = buildDownstreamImpact([kafkaHit], [], ["styles-v3-service"]);
		expect(entries).toEqual([]);
	});

	test("empty-KG behavior: no hits and no edges -> empty enumeration, no fabricated radius", () => {
		expect(buildDownstreamImpact([], [], ["styles-v3-service"])).toEqual([]);
	});

	test("deterministic order: confirmed first, then alphabetical", () => {
		const entries = buildDownstreamImpact(
			[apmHit, { service: "styles-v3-service", neighbour: "zzz-service", via: "depends-on", sharedResource: "" }],
			[{ kind: "depends-on", from: "lists-api", to: "styles-v3-service" }],
			["styles-v3-service"],
		);
		expect(entries.map((e) => e.dependent)).toEqual(["lists-api", "zzz-service"]);
		expect(entries[0]?.source).toBe("confirmed");
		expect(entries[1]?.source).toBe("apm");
	});
});

describe("summarizeDownstreamImpactForPrompt", () => {
	test("empty entries -> empty string", () => {
		expect(summarizeDownstreamImpactForPrompt([])).toBe("");
	});

	test("renders one labeled bullet per entry", () => {
		const text = summarizeDownstreamImpactForPrompt([
			{ incidentService: "styles-v3-service", dependent: "lists-api", source: "confirmed" },
		]);
		expect(text).toContain("lists-api depends on styles-v3-service");
		expect(text).toContain("CONFIRMED");
	});
});
