/* src/lib/errorUtils.ts */

import { logger } from "../utils/logger";
import { createError } from "./errors";
import type { OperationResult } from "./types";

export interface CouchbaseError extends Error {
	code?: number;
	cause?: Error;
}

export function isCouchbaseError(error: unknown): error is CouchbaseError {
	return error instanceof Error && "code" in error;
}

export async function handleOperation<T>(
	operation: () => Promise<T>,
	_errorCode: string,
	operationName: string,
	context: Record<string, unknown> = {},
): Promise<OperationResult<T>> {
	try {
		const result = await operation();
		return {
			success: true,
			data: result,
		};
	} catch (error) {
		logger.error(
			{
				error: error instanceof Error ? error.message : String(error),
				...context,
			},
			`Error during ${operationName}`,
		);

		return {
			success: false,
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}

export function handleAppError(error: unknown): never {
	if (error instanceof Error) {
		if (error.message.includes("document not found")) {
			throw createError("DOCUMENT_NOT_FOUND", error.message);
		}
		if (error.message.includes("invalid scope")) {
			throw createError("VALIDATION_ERROR", error.message);
		}
		if (error.message.includes("invalid collection")) {
			throw createError("VALIDATION_ERROR", error.message);
		}
		if (error.message.includes("authentication failed")) {
			throw createError("AUTH_ERROR", error.message);
		}
		if (error.message.includes("query")) {
			throw createError("QUERY_ERROR", error.message);
		}
		if (error.message.includes("validation")) {
			throw createError("VALIDATION_ERROR", error.message);
		}
	}

	throw createError("DB_ERROR", "An unexpected database error occurred");
}
