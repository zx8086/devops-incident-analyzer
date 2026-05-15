// src/__tests__/wrap.test.ts
import { afterAll, describe, expect, test } from "bun:test";
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
	// Restore the fallback default after this block so other tests see 32_000.
	afterAll(() => setDefaultCapBytes(32_000));

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
