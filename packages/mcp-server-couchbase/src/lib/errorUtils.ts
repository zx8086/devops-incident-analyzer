/* src/lib/errorUtils.ts */

import { logger } from './logger';
import { createError } from './errors';
import type { OperationResult } from './types';

export interface CouchbaseError extends Error {
  code?: number;
  cause?: Error;
}

export function isCouchbaseError(error: unknown): error is CouchbaseError {
  return error instanceof Error && 'code' in error;
}

export async function handleOperation<T>(
  operation: () => Promise<T>,
  errorCode: string,
  operationName: string,
  context: Record<string, unknown> = {}
): Promise<OperationResult<T>> {
  try {
    const result = await operation();
    return {
      success: true,
      data: result
    };
  } catch (error) {
    logger.error(`Error during ${operationName}`, {
      error: error instanceof Error ? error.message : String(error),
      ...context
    });

    return {
      success: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}

export function handleAppError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message.includes('document not found')) {
      logger.warn("Document not found", { error });
      throw createError('DOCUMENT_NOT_FOUND', error.message);
    }
    if (error.message.includes('invalid scope')) {
      logger.warn("Invalid scope name", { error });
      throw createError('VALIDATION_ERROR', error.message);
    }
    if (error.message.includes('invalid collection')) {
      logger.warn("Invalid collection name", { error });
      throw createError('VALIDATION_ERROR', error.message);
    }
    if (error.message.includes('authentication failed')) {
      logger.error("Authentication failed", { error });
      throw createError('AUTH_ERROR', error.message);
    }
    if (error.message.includes('query')) {
      logger.error("Query error", { error });
      throw createError('QUERY_ERROR', error.message);
    }
    if (error.message.includes('validation')) {
      logger.warn("Validation error", { error });
      throw createError('VALIDATION_ERROR', error.message);
    }
  }

  logger.error("Unhandled database error", { error });
  throw createError('DB_ERROR', 'An unexpected database error occurred');
}
