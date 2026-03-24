/* src/lib/mcpErrors.ts */

import { AppError } from "./errors";

/**
 * MCP Protocol Error Codes
 * These are standardized error codes defined by the MCP protocol specification.
 *
 * @see https://github.com/modelcontextprotocol/spec/blob/main/spec.md#error-object
 */
export const MCP_ERROR_CODES = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	SERVER_ERROR_START: -32099,
	SERVER_ERROR_END: -32000,
	SERVER_NOT_INITIALIZED: -32002,
	UNKNOWN_ERROR_CODE: -32001,
} as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[keyof typeof MCP_ERROR_CODES];

/**
 * MCP Protocol Error Class
 * Used specifically for protocol-level errors that conform to the MCP specification.
 * These errors are typically used for transport/RPC-level errors rather than
 * application business logic.
 */
export class McpError extends Error {
	constructor(
		public code: McpErrorCode,
		message: string,
		public data?: unknown,
	) {
		super(message);
		this.name = "McpError";
	}

	/**
	 * Converts the error to the format expected by the MCP protocol
	 */
	toResponseError() {
		return {
			code: this.code,
			message: this.message,
			data: this.data,
		};
	}

	/**
	 * Converts to an application error if needed
	 * This provides a bridge between protocol errors and app errors
	 */
	toAppError(): AppError {
		const { createError } = require("./errors");

		// Map MCP error codes to app error codes
		switch (this.code) {
			case MCP_ERROR_CODES.INVALID_PARAMS:
				return createError("VALIDATION_ERROR", this.message, this.data);
			case MCP_ERROR_CODES.METHOD_NOT_FOUND:
				return createError("UNKNOWN_ERROR", this.message, this.data);
			case MCP_ERROR_CODES.SERVER_NOT_INITIALIZED:
				return createError("CONFIG_ERROR", this.message, this.data);
			default:
				return createError("UNKNOWN_ERROR", this.message, this.data);
		}
	}
}

/**
 * Create an MCP protocol error
 * @param code Error code from MCP_ERROR_CODES
 * @param message Error message
 * @param data Additional error data
 */
export function createMcpError(code: McpErrorCode, message: string, data?: unknown): McpError {
	return new McpError(code, message, data);
}

// Helper functions for common error cases
export function createParseError(message: string = "Parse error"): McpError {
	return createMcpError(MCP_ERROR_CODES.PARSE_ERROR, message);
}

export function createInvalidRequestError(message: string = "Invalid request"): McpError {
	return createMcpError(MCP_ERROR_CODES.INVALID_REQUEST, message);
}

export function createMethodNotFoundError(method: string): McpError {
	return createMcpError(MCP_ERROR_CODES.METHOD_NOT_FOUND, `Method '${method}' not found`);
}

export function createInvalidParamsError(message: string = "Invalid parameters"): McpError {
	return createMcpError(MCP_ERROR_CODES.INVALID_PARAMS, message);
}

export function createInternalError(message: string = "Internal error"): McpError {
	return createMcpError(MCP_ERROR_CODES.INTERNAL_ERROR, message);
}

export function createServerNotInitializedError(): McpError {
	return createMcpError(MCP_ERROR_CODES.SERVER_NOT_INITIALIZED, "Server not initialized");
}

/**
 * Converts any error to an MCP error
 * @param error The error to convert
 * @param defaultCode Default MCP error code to use
 */
export function errorToMcpError(error: unknown, defaultCode: McpErrorCode = MCP_ERROR_CODES.INTERNAL_ERROR): McpError {
	if (error instanceof McpError) {
		return error;
	}

	if (error instanceof AppError) {
		return error.toMcpError() as McpError;
	}

	const message = error instanceof Error ? error.message : String(error);
	return createMcpError(defaultCode, message);
}
