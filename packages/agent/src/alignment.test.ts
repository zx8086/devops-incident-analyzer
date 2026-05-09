// packages/agent/src/alignment.test.ts

import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { summarizeFirstAttempts } from "./alignment.ts";

describe("summarizeFirstAttempts", () => {
	test("flags first-failed retry-succeeded as recovered", () => {
		// Recursion-limit failures fall through classifyToolError's pattern set to "unknown" --
		// the alignment retry path treats unknown as retryable, so functionally it behaves the
		// same as transient. The category is preserved verbatim in the summary so an operator
		// reading the WARN can tell apart a recursion-limit failure from a 503 timeout.
		const results: DataSourceResult[] = [
			{
				dataSourceId: "elastic",
				data: null,
				status: "error",
				duration: 202609,
				isAlignmentRetry: false,
				error: "Recursion limit of 25 reached without hitting a stop condition.",
			},
			{
				dataSourceId: "elastic",
				data: "ok",
				status: "success",
				duration: 139900,
				isAlignmentRetry: true,
			},
		];
		const summary = summarizeFirstAttempts(results);
		expect(summary).toEqual([
			{
				dataSourceId: "elastic",
				firstStatus: "error",
				firstCategory: "unknown",
				firstDurationMs: 202609,
				recovered: true,
			},
		]);
	});

	test("classifies a real timeout/transient error as 'transient'", () => {
		const results: DataSourceResult[] = [
			{
				dataSourceId: "elastic",
				data: null,
				status: "error",
				duration: 60000,
				isAlignmentRetry: false,
				error: "ECONNRESET while talking to elasticsearch",
			},
			{
				dataSourceId: "elastic",
				data: "ok",
				status: "success",
				duration: 10000,
				isAlignmentRetry: true,
			},
		];
		const summary = summarizeFirstAttempts(results);
		expect(summary[0]?.firstCategory).toBe("transient");
		expect(summary[0]?.recovered).toBe(true);
	});

	test("clean first attempt has no recovered flag and no category", () => {
		const results: DataSourceResult[] = [
			{
				dataSourceId: "kafka",
				data: "ok",
				status: "success",
				duration: 4200,
				isAlignmentRetry: false,
			},
		];
		expect(summarizeFirstAttempts(results)).toEqual([
			{
				dataSourceId: "kafka",
				firstStatus: "success",
				firstDurationMs: 4200,
				recovered: false,
			},
		]);
	});

	test("first failure with no retry stays failed", () => {
		const results: DataSourceResult[] = [
			{
				dataSourceId: "konnect",
				data: null,
				status: "error",
				duration: 1234,
				isAlignmentRetry: false,
				error: "session not found",
			},
		];
		expect(summarizeFirstAttempts(results)).toEqual([
			{
				dataSourceId: "konnect",
				firstStatus: "error",
				firstCategory: "session",
				firstDurationMs: 1234,
				recovered: false,
			},
		]);
	});

	test("uses tool-error categories when present, falls back to top-level error classification", () => {
		const results: DataSourceResult[] = [
			{
				dataSourceId: "gitlab",
				data: null,
				status: "error",
				duration: 5000,
				isAlignmentRetry: false,
				error: "All 3 tool calls failed",
				toolErrors: [
					{ toolName: "gitlab_search", category: "auth", message: "401", retryable: false },
					{ toolName: "gitlab_diff", category: "transient", message: "timeout", retryable: true },
				],
			},
		];
		const summary = summarizeFirstAttempts(results);
		expect(summary[0]?.firstCategory).toBe("auth");
	});

	test("dedupes by dataSourceId taking the failing first-attempt result over a successful sibling", () => {
		const results: DataSourceResult[] = [
			{
				dataSourceId: "elastic",
				deploymentId: "eu-b2c",
				data: null,
				status: "error",
				duration: 100,
				isAlignmentRetry: false,
				error: "timeout",
			},
			{
				dataSourceId: "elastic",
				deploymentId: "eu-plm",
				data: "ok",
				status: "success",
				duration: 200,
				isAlignmentRetry: false,
			},
			{
				dataSourceId: "elastic",
				data: "ok",
				status: "success",
				duration: 150,
				isAlignmentRetry: true,
			},
		];
		const summary = summarizeFirstAttempts(results);
		expect(summary).toHaveLength(1);
		expect(summary[0]?.dataSourceId).toBe("elastic");
		expect(summary[0]?.firstStatus).toBe("error");
		expect(summary[0]?.recovered).toBe(true);
	});
});
