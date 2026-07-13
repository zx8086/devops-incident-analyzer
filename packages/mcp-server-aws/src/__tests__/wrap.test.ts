// src/__tests__/wrap.test.ts

import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_TOOL_RESULT_CAP_BYTES, TRUNCATION_OVERHEAD_BYTES } from "@devops-agent/shared";
import { mapAwsError, preferSdkParam, setDefaultCapBytes, wrapBlobTool, wrapListTool } from "../tools/wrap.ts";

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

	// SIO-841: the security-findings projection (Id/Severity/Type) must survive truncation
	// so the model still sees complete severity coverage when the heavy Findings[] is sliced.
	test("preserves a complete findings severity projection in _summary when truncating", async () => {
		const wrapped = wrapListTool({
			name: "aws_guardduty_get_findings",
			listField: "Findings",
			fn: async () => ({
				Findings: Array.from({ length: 40 }, (_, i) => ({
					Id: `find-${i}`,
					Severity: i % 10,
					Type: "Recon:EC2/Portscan",
					Title: "x".repeat(300),
				})),
			}),
			capBytes: 2000,
			summarize: (r: { Findings: Array<{ Id: string; Severity: number; Type: string }> }) =>
				r.Findings.map((f) => ({ Id: f.Id, Severity: f.Severity, Type: f.Type })),
		});
		const result = (await wrapped({})) as {
			Findings: unknown[];
			_truncated: { total: number };
			_summary: Array<{ Id: string; Severity: number }>;
		};
		expect(result.Findings.length).toBeLessThan(40);
		expect(result._truncated.total).toBe(40);
		expect(result._summary).toHaveLength(40);
		// Severity is preserved for every finding even though the bodies were dropped.
		expect(result._summary.every((s) => typeof s.Severity === "number")).toBe(true);
	});
});

// SIO-840: post-merge validation of SIO-833 at the PRODUCTION 128KB cap with
// realistic large fixtures, as an offline, CI-runnable proxy for the two live
// replay cases (the AgentCore runtime path could not run in PR #140's CI container).
// These exercise DEFAULT_TOOL_RESULT_CAP_BYTES (131_072), not synthetic small caps.
describe("SIO-840 replay validation (128KB cap, realistic fixtures)", () => {
	// Case B: aws_ec2_describe_instances for a ~17-node estate serializes to ~155KB.
	// The wrapped result must reach the model at <=128KB (NOT re-truncated to 64KB),
	// be flagged Case B (no continuation token), and keep a complete _summary.
	function buildEc2DescribeFixture(nodeCount: number) {
		// Each instance is a heavy object so nodeCount=17 lands well over the 128KB cap
		// (mirrors the eu-mendix-platform-prd EKS-node describe shape).
		const Reservations = Array.from({ length: nodeCount }, (_, i) => ({
			ReservationId: `r-${i}`,
			Instances: [
				{
					InstanceId: `i-${i.toString().padStart(17, "0")}`,
					InstanceType: "m5.2xlarge",
					State: { Code: 16, Name: "running" },
					PrivateIpAddress: `10.34.51.${i}`,
					Tags: Array.from({ length: 30 }, (_, t) => ({ Key: `tag-${t}`, Value: "v".repeat(400) })),
					BlockDeviceMappings: Array.from({ length: 4 }, (_, b) => ({
						DeviceName: `/dev/sd${b}`,
						Ebs: { VolumeId: `vol-${i}-${b}`, Status: "attached", AttachTime: "2026-01-01T00:00:00Z" },
					})),
				},
			],
		}));
		return { Reservations };
	}

	test("Case B: ~155KB EC2 describe reaches model at <=128KB, not re-truncated to 64KB", async () => {
		const fixture = buildEc2DescribeFixture(17);
		const fixtureBytes = JSON.stringify(fixture).length;
		// Sanity: the fixture genuinely exceeds the 128KB cap so truncation is exercised.
		expect(fixtureBytes).toBeGreaterThan(DEFAULT_TOOL_RESULT_CAP_BYTES);

		const wrapped = wrapListTool({
			name: "aws_ec2_describe_instances",
			listField: "Reservations",
			fn: async () => fixture,
			// No capBytes -> uses the production DEFAULT_TOOL_RESULT_CAP_BYTES (128KB).
			summarize: (r: { Reservations: Array<{ ReservationId: string; Instances: Array<{ InstanceId: string }> }> }) =>
				r.Reservations.flatMap((res) => res.Instances.map((inst) => ({ InstanceId: inst.InstanceId }))),
		});
		const result = (await wrapped({})) as unknown as {
			Reservations: unknown[];
			_truncated: { shown: number; total: number; cursor?: string; advice: string };
			_summary: Array<{ InstanceId: string }>;
		};

		// Reached the model within the 128KB budget (the SIO-833 raise), and crucially
		// the wrapped payload is well ABOVE the old 64KB cap -- proving no re-truncation to 64KB.
		const wrappedBytes = JSON.stringify(result).length;
		expect(wrappedBytes).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_CAP_BYTES + TRUNCATION_OVERHEAD_BYTES);
		expect(wrappedBytes).toBeGreaterThan(65_536);

		// Consistent truncation marker.
		expect(result._truncated.total).toBe(17);
		expect(result._truncated.shown).toBe(result.Reservations.length);
		expect(result._truncated.shown).toBeLessThan(result._truncated.total);

		// Case B: a byte-truncation with no real continuation token -> no cursor.
		expect(result._truncated.cursor).toBeUndefined();
		expect(result._truncated.advice).toContain("Case B");

		// _summary stays complete (all 17 instance IDs) even though Reservations[] was sliced.
		expect(result._summary).toHaveLength(17);
		expect(result._summary.every((s) => typeof s.InstanceId === "string")).toBe(true);
	});

	// Pagination completeness: aws_cloudwatch_describe_alarms with enough alarms to
	// truncate the heavy MetricAlarms[] must keep the per-alarm projection COMPLETE in
	// _summary, so the AWSFindingsCard count equals the true total (50/50, not 28/50).
	test("_summary count equals the true alarm total when MetricAlarms[] is truncated", async () => {
		const total = 50;
		const fixture = {
			MetricAlarms: Array.from({ length: total }, (_, i) => ({
				AlarmName: `alarm-${i}`,
				StateValue: i % 3 === 0 ? "ALARM" : "OK",
				MetricName: "CPUUtilization",
				Namespace: "AWS/EC2",
				AlarmDescription: "d".repeat(600),
				Dimensions: Array.from({ length: 8 }, (_, d) => ({ Name: `dim-${d}`, Value: "x".repeat(400) })),
			})),
			CompositeAlarms: [],
		};
		expect(JSON.stringify(fixture).length).toBeGreaterThan(DEFAULT_TOOL_RESULT_CAP_BYTES);

		const wrapped = wrapListTool({
			name: "aws_cloudwatch_describe_alarms",
			listField: "MetricAlarms",
			fn: async () => fixture,
			summarize: (r: { MetricAlarms: Array<{ AlarmName: string; StateValue: string }> }) =>
				r.MetricAlarms.map((a) => ({ AlarmName: a.AlarmName, StateValue: a.StateValue })),
		});
		const result = (await wrapped({})) as unknown as {
			MetricAlarms: unknown[];
			_truncated: { total: number };
			_summary: Array<{ AlarmName: string; StateValue: string }>;
		};

		// Heavy list truncated, but the finding-bearing projection is complete: 50/50.
		expect(result.MetricAlarms.length).toBeLessThan(total);
		expect(result._truncated.total).toBe(total);
		expect(result._summary).toHaveLength(total);
		// The ALARM-state count (what the findings card reports) is complete, not partial.
		const alarmCount = result._summary.filter((a) => a.StateValue === "ALARM").length;
		const trueAlarmCount = fixture.MetricAlarms.filter((a) => a.StateValue === "ALARM").length;
		expect(alarmCount).toBe(trueAlarmCount);
	});

	// SIO-833 Case A is exercised at small caps above; confirm a Lambda NextMarker still
	// surfaces as a cursor at the production cap so the sub-agent chains rather than reporting partial.
	test("Case A: Lambda NextMarker surfaces as a chainable cursor at the 128KB cap", async () => {
		const fixture = {
			Functions: Array.from({ length: 200 }, (_, i) => ({
				FunctionName: `fn-${i}`,
				Runtime: "nodejs20.x",
				Description: "d".repeat(900),
			})),
			NextMarker: "page-2-token",
		};
		expect(JSON.stringify(fixture).length).toBeGreaterThan(DEFAULT_TOOL_RESULT_CAP_BYTES);
		const wrapped = wrapListTool({
			name: "aws_lambda_list_functions",
			listField: "Functions",
			fn: async () => fixture,
		});
		const result = (await wrapped({})) as unknown as { _truncated: { cursor?: string; advice: string } };
		expect(result._truncated.cursor).toBe("page-2-token");
		expect(result._truncated.advice).toContain("Case A");
	});
});

// SIO-838: canonical limit/cursor aliases resolve to each tool's SDK param via preferSdkParam.
// The SDK-named value always wins so existing call patterns are never overridden.
describe("preferSdkParam", () => {
	test("SDK-named value wins when both are supplied", () => {
		expect(preferSdkParam("sdk", "alias")).toBe("sdk");
		expect(preferSdkParam(50, 10)).toBe(50);
	});

	test("falls back to the alias when the SDK param is undefined", () => {
		expect(preferSdkParam(undefined, "alias")).toBe("alias");
		expect(preferSdkParam(undefined, 10)).toBe(10);
	});

	test("returns undefined when neither is set", () => {
		expect(preferSdkParam<string>(undefined, undefined)).toBeUndefined();
	});

	test("treats 0 and empty string as present (not falsy-coalesced)", () => {
		// Uses ?? not || so a legitimately-zero SDK page size or empty token is respected.
		expect(preferSdkParam(0, 100)).toBe(0);
		expect(preferSdkParam("", "alias")).toBe("");
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

	// SIO-1087: a novel/unmapped AWS error name now classifies by the documented
	// $metadata.httpStatusCode / $fault instead of always falling to aws-unknown -- a 5xx is a
	// retryable server error, a 4xx is bad-input, and only a truly statusless error is aws-unknown.
	test("Unknown error name with 5xx status -> aws-server-error", () => {
		const err = Object.assign(new Error("???"), {
			name: "SomeNewAwsErrorType",
			$metadata: { httpStatusCode: 500 },
		});
		expect(mapAwsError(err).kind).toBe("aws-server-error");
	});

	test("Unknown error name with 4xx status -> bad-input", () => {
		const err = Object.assign(new Error("???"), {
			name: "SomeNewAwsErrorType",
			$metadata: { httpStatusCode: 400 },
		});
		expect(mapAwsError(err).kind).toBe("bad-input");
	});

	test("Unknown error name with no status/$fault -> aws-unknown", () => {
		const err = Object.assign(new Error("???"), { name: "SomeNewAwsErrorType" });
		expect(mapAwsError(err).kind).toBe("aws-unknown");
	});

	// SIO-1087: $fault is the documented smithy discriminator; it must classify even when
	// $metadata.httpStatusCode is absent (some SDK errors set only $fault).
	test("Unknown error name with $fault='server' and no httpStatusCode -> aws-server-error", () => {
		const err = Object.assign(new Error("???"), { name: "SomeNewAwsErrorType", $fault: "server" });
		expect(mapAwsError(err).kind).toBe("aws-server-error");
	});

	test("Unknown error name with $fault='client' and no httpStatusCode -> bad-input", () => {
		const err = Object.assign(new Error("???"), { name: "SomeNewAwsErrorType", $fault: "client" });
		expect(mapAwsError(err).kind).toBe("bad-input");
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
