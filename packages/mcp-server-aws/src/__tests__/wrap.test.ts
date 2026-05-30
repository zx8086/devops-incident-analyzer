// src/__tests__/wrap.test.ts

import { afterAll, describe, expect, test } from "bun:test";
import { TRUNCATION_OVERHEAD_BYTES } from "@devops-agent/shared";
import { mapAwsError, setDefaultCapBytes, wrapBlobTool, wrapListTool } from "../tools/wrap.ts";

describe("wrapListTool", () => {
	test("returns response unchanged when under cap", async () => {
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => ({ items: [1, 2, 3], other: "ok" }),
			capBytes: 1_000_000,
		});
		const result = await wrapped({});
		expect(result).toEqual({ items: [1, 2, 3], other: "ok" });
	});

	test("truncates the list when over cap and emits structured marker", async () => {
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => ({ items: Array.from({ length: 100 }, (_, i) => ({ id: i, payload: "x".repeat(100) })) }),
			capBytes: 2000,
		});
		const result = (await wrapped({})) as { items: unknown[]; _truncated: { shown: number; total: number } };
		expect(result.items.length).toBeLessThan(100);
		expect(result._truncated.total).toBe(100);
		expect(result._truncated.shown).toBe(result.items.length);
		expect(result._truncated).toHaveProperty("advice");
	});

	test("preserves non-list fields unchanged when truncating", async () => {
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => ({ items: Array.from({ length: 50 }, (_, i) => ({ id: i })), nextToken: "abc", count: 50 }),
			capBytes: 200,
		});
		const result = (await wrapped({})) as { nextToken: string; count: number };
		expect(result.nextToken).toBe("abc");
		expect(result.count).toBe(50);
	});

	test("surfaces a real continuation token as _truncated.cursor (Case A, SIO-833)", async () => {
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			// Marker (RDS/Lambda style), not nextToken -- exercises the multi-name probe.
			fn: async () => ({ items: Array.from({ length: 50 }, (_, i) => ({ id: i })), Marker: "page2" }),
			capBytes: 200,
		});
		const result = (await wrapped({})) as unknown as { _truncated: { cursor?: string; advice: string } };
		expect(result._truncated.cursor).toBe("page2");
		expect(result._truncated.advice).toContain("Case A");
	});

	test("omits cursor and flags Case B when byte-truncated with no token (SIO-833)", async () => {
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => ({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, payload: "p".repeat(50) })) }),
			capBytes: 300,
		});
		const result = (await wrapped({})) as { items: unknown[]; _truncated: { cursor?: string; advice: string } };
		expect(result._truncated.cursor).toBeUndefined();
		expect(result._truncated.advice).toContain("Case B");
	});

	test("attaches _summary with the COMPLETE projected list when truncating (SIO-833)", async () => {
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => ({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, payload: "x".repeat(200) })) }),
			capBytes: 2000,
			summarize: (r) => r.items.map((it) => ({ id: it.id })),
		});
		const result = (await wrapped({})) as {
			items: unknown[];
			_truncated: { total: number; advice: string };
			_summary: Array<{ id: number }>;
		};
		expect(result.items.length).toBeLessThan(50);
		expect(result._truncated.total).toBe(50);
		// _summary is complete even though the heavy items[] was truncated.
		expect(result._summary).toHaveLength(50);
		expect(result._truncated.advice).toContain("_summary");
	});

	test("surfaces Lambda's NextMarker as _truncated.cursor (Case A, SIO-833)", async () => {
		const wrapped = wrapListTool({
			name: "test",
			listField: "Functions",
			// aws_lambda_list_functions returns its continuation token as NextMarker (a name
			// difference from the Marker input arg) -- must still be detected as a Case A cursor.
			fn: async () => ({ Functions: Array.from({ length: 50 }, (_, i) => ({ id: i })), NextMarker: "page2" }),
			capBytes: 200,
		});
		const result = (await wrapped({})) as unknown as { _truncated: { cursor?: string; advice: string } };
		expect(result._truncated.cursor).toBe("page2");
		expect(result._truncated.advice).toContain("Case A");
	});

	test("reserves _summary bytes so the wrapped result stays within cap (SIO-833)", async () => {
		const cap = 6000;
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			// Heavy list forces truncation; the _summary projects every original item, so it is
			// several KB. Without budgeting it, the final object would exceed cap by ~that much and
			// the agent-side truncator could byte-slice the tail _summary off.
			fn: async () => ({ items: Array.from({ length: 80 }, (_, i) => ({ id: i, payload: "x".repeat(120) })) }),
			capBytes: cap,
			summarize: (r) => r.items.map((it) => ({ id: it.id, p: "s".repeat(30) })),
		});
		const result = (await wrapped({})) as { items: unknown[]; _summary: unknown[] };
		// _summary stays COMPLETE (all 80) even though items[] is truncated...
		expect(result.items.length).toBeLessThan(80);
		expect(result._summary).toHaveLength(80);
		// ...and the whole wrapped payload now respects the cap (only the small _truncated marker,
		// not the multi-KB _summary, is unaccounted for). Pre-fix this was ~_summary bytes over.
		expect(JSON.stringify(result).length).toBeLessThanOrEqual(cap + TRUNCATION_OVERHEAD_BYTES);
	});

	test("omits _summary when under cap (no truncation)", async () => {
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => ({ items: [{ id: 1 }] }),
			capBytes: 1_000_000,
			summarize: (r) => r.items.map((it) => ({ id: it.id })),
		});
		const result = await wrapped({});
		expect(result).not.toHaveProperty("_summary");
		expect(result).toEqual({ items: [{ id: 1 }] });
	});

	test("maps AccessDeniedException to _error.kind=iam-permission-missing", async () => {
		const err = Object.assign(new Error("User is not authorized to perform: rds:DescribeDBInstances"), {
			name: "AccessDeniedException",
			$metadata: { httpStatusCode: 403, requestId: "abc" },
		});
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => {
				throw err;
			},
		});
		const result = (await wrapped({})) as { _error: { kind: string; action?: string } };
		expect(result._error.kind).toBe("iam-permission-missing");
		expect(result._error.action).toBe("rds:DescribeDBInstances");
	});
});

describe("wrapBlobTool", () => {
	test("returns response unchanged when under cap", async () => {
		const wrapped = wrapBlobTool({
			name: "test",
			fn: async () => ({ data: "small" }),
			capBytes: 1_000_000,
		});
		const result = await wrapped({});
		expect(result).toEqual({ data: "small" });
	});

	test("truncates serialized response when over cap with valid-JSON walkback", async () => {
		const wrapped = wrapBlobTool({
			name: "test",
			fn: async () => ({ data: Array.from({ length: 1000 }, (_, i) => ({ id: i, payload: "y".repeat(50) })) }),
			capBytes: 500,
		});
		const result = (await wrapped({})) as { _raw: string; _truncated: { atBytes: number; advice: string } };
		expect(result._raw).toBeDefined();
		expect(result._truncated.atBytes).toBeLessThanOrEqual(500);
		expect(result._truncated.advice).toBeDefined();
		// Walkback should leave the raw substring ending on a safe boundary
		// (the raw is for the model — not required to be parseable, only readable).
		expect(typeof result._raw).toBe("string");
	});

	test("maps ThrottlingException to _error.kind=aws-throttled", async () => {
		const err = Object.assign(new Error("Rate exceeded"), {
			name: "ThrottlingException",
			$metadata: { httpStatusCode: 400 },
		});
		const wrapped = wrapBlobTool({
			name: "test",
			fn: async () => {
				throw err;
			},
		});
		const result = (await wrapped({})) as { _error: { kind: string } };
		expect(result._error.kind).toBe("aws-throttled");
	});
});

describe("mapAwsError", () => {
	test("STS AccessDenied -> assume-role-denied", () => {
		const err = Object.assign(new Error("Not authorized to perform: sts:AssumeRole"), {
			name: "AccessDenied",
			$metadata: { httpStatusCode: 403 },
		});
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("assume-role-denied");
	});

	test("S3 bare AccessDenied with service action -> iam-permission-missing", () => {
		// S3 v3 SDK throws with name="AccessDenied" (no Exception suffix) for IAM
		// permission denials; must be classified as iam-permission-missing, not as
		// the trust-policy/STS bucket (bug_018).
		const err = Object.assign(
			new Error("User is not authorized to perform: s3:GetBucketPolicyStatus on resource: arn:aws:s3:::foo"),
			{ name: "AccessDenied", $metadata: { httpStatusCode: 403 } },
		);
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("iam-permission-missing");
		expect(mapped.action).toBe("s3:GetBucketPolicyStatus");
	});

	test("AccessDeniedException with sts:AssumeRole action -> assume-role-denied", () => {
		const err = Object.assign(new Error("User is not authorized to perform: sts:AssumeRole"), {
			name: "AccessDeniedException",
			$metadata: { httpStatusCode: 403 },
		});
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("assume-role-denied");
	});

	test("Service AccessDeniedException -> iam-permission-missing with action extracted", () => {
		const err = Object.assign(new Error("User is not authorized to perform: ec2:DescribeVpcs"), {
			name: "AccessDeniedException",
			$metadata: { httpStatusCode: 403 },
		});
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("iam-permission-missing");
		expect(mapped.action).toBe("ec2:DescribeVpcs");
	});

	test("ResourceNotFoundException -> resource-not-found", () => {
		const err = Object.assign(new Error("Requested resource not found: Table: missing-table not found"), {
			name: "ResourceNotFoundException",
			$metadata: { httpStatusCode: 400 },
		});
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("resource-not-found");
		expect(mapped.advice).toContain("does not exist");
	});

	test("ValidationException -> bad-input", () => {
		const err = Object.assign(new Error("missing required field"), {
			name: "ValidationException",
			$metadata: { httpStatusCode: 400 },
		});
		expect(mapAwsError(err).kind).toBe("bad-input");
	});

	test("ServiceUnavailable -> aws-server-error", () => {
		const err = Object.assign(new Error("Service unavailable"), {
			name: "ServiceUnavailable",
			$metadata: { httpStatusCode: 503 },
		});
		expect(mapAwsError(err).kind).toBe("aws-server-error");
	});

	test("Network error (no $metadata) -> aws-network-error", () => {
		const err = new Error("getaddrinfo ENOTFOUND ec2.eu-central-1.amazonaws.com");
		expect(mapAwsError(err).kind).toBe("aws-network-error");
	});

	test("Unknown error name -> aws-unknown", () => {
		const err = Object.assign(new Error("???"), {
			name: "SomeNewAwsErrorType",
			$metadata: { httpStatusCode: 500 },
		});
		expect(mapAwsError(err).kind).toBe("aws-unknown");
	});
});

describe("setDefaultCapBytes", () => {
	// Restore the shared default after this block so other tests see the 128KB cap (SIO-833).
	afterAll(() => setDefaultCapBytes(131_072));

	test("applies to wrappers created without an explicit capBytes", async () => {
		setDefaultCapBytes(200);
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => ({ items: Array.from({ length: 100 }, (_, i) => ({ id: i, payload: "z".repeat(50) })) }),
		});
		const result = (await wrapped({})) as { items: unknown[]; _truncated: { total: number } };
		expect(result._truncated.total).toBe(100);
		expect(result.items.length).toBeLessThan(100);
	});

	test("per-call capBytes still overrides the module default", async () => {
		setDefaultCapBytes(200);
		const wrapped = wrapListTool({
			name: "test",
			listField: "items",
			fn: async () => ({ items: [1, 2, 3] }),
			capBytes: 1_000_000,
		});
		const result = await wrapped({});
		expect(result).toEqual({ items: [1, 2, 3] });
	});
});
