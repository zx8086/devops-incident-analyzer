// tests/monitor-typesafe.test.ts
// Greptile PR #912: parse a REAL jev-1.13.0 response through askSystemOne rather
// than an injected, already-typed one. The body is verbatim from a live call on
// 2026-09-26 (triage choice + a noul); a schema drift here would void every
// round and silently send every finding.
import { afterEach, describe, expect, test } from "bun:test";
import { classifyFailure, judgeActionability } from "../scripts/monitor/actionability-judge.ts";
import { askSystemOne } from "../scripts/monitor/typesafe.ts";

const CAPTURED = {
	model: "jev-1.13.0",
	answers: {
		triage: {
			type: "choice",
			choice: "investigate_now",
			confidence: 0.48,
			probabilities: { critical: 0.39, investigate_now: 0.61, investigate_later: 0, routine: 0 },
		},
		dup: { type: "noul", noul: 0.03 },
	},
	usage: { input_tokens: 460, output_tokens: 76 },
};

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown): void {
	globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("askSystemOne", () => {
	test("parses the captured choice + noul response", async () => {
		stubFetch(200, CAPTURED);
		const out = await askSystemOne({ state: {}, questions: {}, apiKey: "k" });
		const triage = out.answers.triage;
		expect(triage?.type).toBe("choice");
		if (triage?.type === "choice") expect(triage.probabilities.routine).toBe(0);
		expect(out.answers.dup).toEqual({ type: "noul", noul: 0.03 });
	});

	test("rejects a choice answer missing its probabilities", async () => {
		const broken = structuredClone(CAPTURED) as { answers: { triage: Record<string, unknown> } };
		delete broken.answers.triage.probabilities;
		stubFetch(200, broken);
		await expect(askSystemOne({ state: {}, questions: {}, apiKey: "k" })).rejects.toThrow();
	});

	test("reports a non-2xx by status only", async () => {
		stubFetch(503, { echo: "state text that must not reach a log" });
		await expect(askSystemOne({ state: {}, questions: {}, apiKey: "k" })).rejects.toThrow(
			"TypeSafe request failed with status 503",
		);
	});
});

// SIO-1885: a failed round names WHY, as a fixed label, and never the response text.
describe("gate failure reasons", () => {
	const SECRET = "planted-secret-7f3a9c";
	const finding = {
		family: "logs" as const,
		severity: "warn" as const,
		resource: "r",
		summary: "s",
		dedup_key: "k",
		evidence: {},
		at: "2026-09-29T00:00:00.000Z",
	};

	async function failure(respond: () => Promise<Response>): Promise<string> {
		globalThis.fetch = (async () => respond()) as unknown as typeof fetch;
		try {
			await judgeActionability([finding], [], { apiKey: "k" });
		} catch (e) {
			return (e as Error).message;
		}
		throw new Error("expected the round to fail");
	}

	test("http status", async () => {
		const m = await failure(async () => new Response(SECRET, { status: 503 }));
		expect(m).toBe("actionability: 1/1 requests failed (http 503)");
	});

	test("a body that is not JSON", async () => {
		const m = await failure(async () => new Response(`{"answers": ${SECRET}`, { status: 200 }));
		expect(m).toBe("actionability: 1/1 requests failed (invalid json)");
	});

	test("a body that does not match the schema", async () => {
		const m = await failure(async () =>
			Response.json({ model: SECRET, answers: { triage: { type: "choice", choice: SECRET } } }),
		);
		expect(m).toBe("actionability: 1/1 requests failed (schema)");
	});

	test("our own deadline", async () => {
		const m = await failure(async () => {
			throw new DOMException(SECRET, "TimeoutError");
		});
		expect(m).toBe("actionability: 1/1 requests failed (timeout)");
	});

	test("anything else is network, with its message dropped", async () => {
		const m = await failure(async () => {
			throw new TypeError(`fetch failed: ${SECRET}`);
		});
		expect(m).toBe("actionability: 1/1 requests failed (network)");
		expect(m).not.toContain(SECRET);
	});

	test("mixed failures are counted per class", () => {
		expect(classifyFailure(new DOMException("x", "AbortError"))).toBe("timeout");
		expect(classifyFailure("a string")).toBe("network");
		expect(classifyFailure(new Error("TypeSafe request failed with status 429"))).toBe("http 429");
		// A look-alike message with extra text is not trusted as a status.
		expect(classifyFailure(new Error(`TypeSafe request failed with status 500 ${SECRET}`))).toBe("network");
	});
});

test("several failures of one class carry a count (SIO-1885)", async () => {
	let n = 0;
	globalThis.fetch = (async () => {
		n += 1;
		return new Response("", { status: n === 3 ? 500 : 503 });
	}) as unknown as typeof fetch;
	const f = (k: string) => ({
		family: "logs" as const,
		severity: "warn" as const,
		resource: k,
		summary: k,
		dedup_key: k,
		evidence: {},
		at: "2026-09-29T00:00:00.000Z",
	});
	await expect(judgeActionability([f("a"), f("b"), f("c")], [], { apiKey: "k" })).rejects.toThrow(
		"actionability: 3/3 requests failed (http 503 x2, http 500)",
	);
});
