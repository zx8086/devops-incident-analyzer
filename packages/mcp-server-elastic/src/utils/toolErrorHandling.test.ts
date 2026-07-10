// packages/mcp-server-elastic/src/utils/toolErrorHandling.test.ts
import { describe, expect, test } from "bun:test";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { throwZodValidationMcpError } from "./toolErrorHandling.ts";

// Mirrors the per-tool `create<X>McpError` shape used at every clone-group d161427f call site.
function createFakeToolMcpError(
	error: Error | string,
	context: { type: "validation" | "execution" | "some_tool_specific_type"; details?: unknown },
): McpError {
	const message = error instanceof Error ? error.message : error;
	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		some_tool_specific_type: ErrorCode.InternalError,
	};
	return new McpError(errorCodeMap[context.type], `[fake_tool] ${message}`, context.details);
}

function zodErrorFor(schema: z.ZodTypeAny, value: unknown): z.ZodError {
	const result = schema.safeParse(value);
	if (result.success) throw new Error("expected schema parse to fail in test setup");
	return result.error;
}

describe("throwZodValidationMcpError", () => {
	const nameValidator = z.object({ name: z.string().min(1, "Policy name cannot be empty") });

	test("throws an McpError with InvalidParams code", () => {
		const zodError = zodErrorFor(nameValidator, { name: "" });
		expect(() => throwZodValidationMcpError(zodError, { name: "" }, createFakeToolMcpError)).toThrow(McpError);

		try {
			throwZodValidationMcpError(zodError, { name: "" }, createFakeToolMcpError);
			throw new Error("expected throw");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(McpError);
			expect((thrown as McpError).code).toBe(ErrorCode.InvalidParams);
		}
	});

	test("message is prefixed by the tool-specific factory and joins Zod issue messages", () => {
		const zodError = zodErrorFor(nameValidator, { name: "" });
		try {
			throwZodValidationMcpError(zodError, { name: "" }, createFakeToolMcpError);
			throw new Error("expected throw");
		} catch (thrown) {
			const err = thrown as McpError;
			expect(err.message).toContain("[fake_tool]");
			expect(err.message).toContain("Validation failed: Policy name cannot be empty");
		}
	});

	test("details carries validationErrors (Zod issues) and providedArgs (raw pre-validation input)", () => {
		const rawArgs = { name: "", extra: "unvalidated-field" };
		const zodError = zodErrorFor(nameValidator, rawArgs);
		try {
			throwZodValidationMcpError(zodError, rawArgs, createFakeToolMcpError);
			throw new Error("expected throw");
		} catch (thrown) {
			const err = thrown as McpError;
			const details = err.data as { validationErrors: unknown; providedArgs: unknown };
			expect(details.validationErrors).toEqual(zodError.issues);
			expect(details.providedArgs).toBe(rawArgs);
		}
	});

	test("joins multiple Zod issue messages with a comma", () => {
		const multiFieldValidator = z.object({
			name: z.string().min(1, "Policy name cannot be empty"),
			masterTimeout: z.string().min(1, "Timeout cannot be empty"),
		});
		const rawArgs = { name: "", masterTimeout: "" };
		const zodError = zodErrorFor(multiFieldValidator, rawArgs);
		try {
			throwZodValidationMcpError(zodError, rawArgs, createFakeToolMcpError);
			throw new Error("expected throw");
		} catch (thrown) {
			const err = thrown as McpError;
			expect(err.message).toContain("Policy name cannot be empty, Timeout cannot be empty");
		}
	});

	test("providedArgs echoes back undefined args verbatim (no coercion)", () => {
		const zodError = zodErrorFor(nameValidator, undefined);
		try {
			throwZodValidationMcpError(zodError, undefined, createFakeToolMcpError);
			throw new Error("expected throw");
		} catch (thrown) {
			const err = thrown as McpError;
			const details = err.data as { providedArgs: unknown };
			expect(details.providedArgs).toBeUndefined();
		}
	});
});
