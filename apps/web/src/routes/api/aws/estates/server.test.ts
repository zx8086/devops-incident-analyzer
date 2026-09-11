// apps/web/src/routes/api/aws/estates/server.test.ts
// SIO-1696: the estate selector is production-only, and the AWS_ESTATES parsing
// it rides on was untested. This route imports nothing from @devops-agent/agent,
// so no module mocking is needed -- only the env it reads at request time.
import { afterEach, describe, expect, test } from "bun:test";
import { GET } from "./+server.ts";

const ORIGINAL_ESTATES = process.env.AWS_ESTATES;
const ORIGINAL_REGION = process.env.AWS_REGION;

function restore(key: "AWS_ESTATES" | "AWS_REGION", value: string | undefined) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

afterEach(() => {
	restore("AWS_ESTATES", ORIGINAL_ESTATES);
	restore("AWS_REGION", ORIGINAL_REGION);
});

async function estates(): Promise<{ id: string; region: string }[]> {
	// The handler ignores its request/params; the route takes no input.
	const res = await GET({} as never);
	const body = (await res.json()) as { estates: { id: string; region: string }[] };
	return body.estates;
}

describe("GET /api/aws/estates", () => {
	test("drops every non-prd estate from the selector", async () => {
		process.env.AWS_ESTATES = JSON.stringify({
			"eu-oit-prd": { region: "eu-central-1" },
			"eu-shared-services-prd": { region: "eu-central-1" },
			"eu-oit-dev": { region: "eu-central-1" },
			"eu-oit-stg": { region: "eu-central-1" },
			sandbox: { region: "eu-central-1" },
		});
		expect((await estates()).map((e) => e.id)).toEqual(["eu-oit-prd", "eu-shared-services-prd"]);
	});

	test("matches the suffix, not a substring", async () => {
		// `prd-archive` ends in neither; `-prd` must be terminal.
		process.env.AWS_ESTATES = JSON.stringify({
			"eu-oit-prd": {},
			"prd-archive": {},
			"eu-prd-dev": {},
		});
		expect((await estates()).map((e) => e.id)).toEqual(["eu-oit-prd"]);
	});

	test("falls back to AWS_REGION when an estate omits its region", async () => {
		process.env.AWS_REGION = "eu-west-1";
		process.env.AWS_ESTATES = JSON.stringify({
			"a-prd": { region: "eu-central-1" },
			"b-prd": {},
			"c-prd": { region: 42 },
		});
		expect(await estates()).toEqual([
			{ id: "a-prd", region: "eu-central-1" },
			{ id: "b-prd", region: "eu-west-1" },
			{ id: "c-prd", region: "eu-west-1" },
		]);
	});

	test("region is empty when neither the estate nor AWS_REGION supplies one", async () => {
		delete process.env.AWS_REGION;
		process.env.AWS_ESTATES = JSON.stringify({ "a-prd": {} });
		expect(await estates()).toEqual([{ id: "a-prd", region: "" }]);
	});

	// SIO-836: validation mirrors aws-estate-router.ts -- anything malformed
	// yields an empty list rather than a partial one or a 500.
	test("returns an empty list for unset, malformed, array, and primitive values", async () => {
		delete process.env.AWS_ESTATES;
		expect(await estates()).toEqual([]);

		process.env.AWS_ESTATES = "{not json";
		expect(await estates()).toEqual([]);

		process.env.AWS_ESTATES = JSON.stringify(["eu-oit-prd"]);
		expect(await estates()).toEqual([]);

		process.env.AWS_ESTATES = JSON.stringify("eu-oit-prd");
		expect(await estates()).toEqual([]);

		process.env.AWS_ESTATES = JSON.stringify(null);
		expect(await estates()).toEqual([]);
	});
});
