/* src/lib/errors.ts */

/**
 * Application-level error codes
 * These are used for internal application errors and are mapped to
 * human-readable messages and HTTP status codes.
 */
export type ErrorCode =
	| "DB_ERROR"
	| "QUERY_ERROR"
	| "VALIDATION_ERROR"
	| "AUTH_ERROR"
	| "CONFIG_ERROR"
	| "DOCUMENT_NOT_FOUND"
	| "NOT_FOUND"
	| "UNKNOWN_ERROR";

/**
 * Application Error class
 * Used for application-specific errors that relate to business logic
 * and application operations.
 */
export class AppError extends Error {
	public details?: Record<string, unknown>;

	constructor(
		public code: string,
		message: string,
		public originalError?: Error,
	) {
		super(message);
		this.name = "AppError";
	}
}

export const errorMessages: Record<ErrorCode, string> = {
	DB_ERROR: "Database operation failed",
	QUERY_ERROR: "Query execution failed",
	VALIDATION_ERROR: "Input validation failed",
	AUTH_ERROR: "Authentication failed",
	CONFIG_ERROR: "Configuration error",
	DOCUMENT_NOT_FOUND: "Document not found",
	NOT_FOUND: "Resource not found",
	UNKNOWN_ERROR: "An unexpected error occurred",
};

/**
 * Create an application error
 * @param code Error code
 * @param message Error message
 * @param originalError Original error
 */
export function createError(code: ErrorCode, message?: string, originalError?: Error): AppError {
	const errorMessage = message || errorMessages[code];
	return new AppError(code, errorMessage, originalError);
}

/**
 * Handle an error and return an AppError
 * @param error Error to handle
 */
export function handleError(error: unknown): AppError {
	if (error instanceof AppError) {
		return error;
	}

	if (error instanceof Error) {
		return createError("UNKNOWN_ERROR", error.message, error);
	}

	return createError("UNKNOWN_ERROR", String(error));
}

/**
 * Check if an error is an instance of AppError
 * @param error Error to check
 */
export function isAppError(error: unknown): error is AppError {
	return error instanceof AppError;
}

/**
 * Get error code from an error
 * @param error Error to get code from
 */
export function getErrorCode(error: unknown): ErrorCode {
	if (isAppError(error)) {
		return error.code as ErrorCode;
	}
	return "UNKNOWN_ERROR";
}

/**
 * Get error message from an error
 * @param error Error to get message from
 */
export function getErrorMessage(error: unknown): string {
	if (isAppError(error)) {
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

// Map error codes to HTTP status codes
const _statusCodes: Record<ErrorCode, number> = {
	DOCUMENT_NOT_FOUND: 404,
	NOT_FOUND: 404,
	QUERY_ERROR: 400,
	VALIDATION_ERROR: 400,
	CONFIG_ERROR: 500,
	DB_ERROR: 500,
	UNKNOWN_ERROR: 500,
	AUTH_ERROR: 401,
};

/**
 * Format an error for HTTP responses
 * @param error Error to format
 */
export function formatErrorResponse(error: Error): {
	error: string;
	code: string;
	message: string;
	details?: Record<string, unknown>;
} {
	if (error instanceof AppError) {
		return {
			error: error.name,
			code: error.code,
			message: error.message,
			details: error.details,
		};
	}

	return {
		error: "InternalServerError",
		code: "UNKNOWN_ERROR",
		message: error.message || "An unexpected error occurred",
	};
}
