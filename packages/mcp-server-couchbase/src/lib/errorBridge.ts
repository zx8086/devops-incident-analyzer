/* src/lib/errorBridge.ts */

import { AppError, ErrorCode, createError } from './errors';
import { McpError, McpErrorCode, createMcpError, MCP_ERROR_CODES } from './mcpErrors';

/**
 * Convert any error to the appropriate type
 * This function centralizes error conversion logic
 */
export function normalizeError(error: unknown): AppError | McpError {
  if (error instanceof AppError || error instanceof McpError) {
    return error;
  }
  
  const message = error instanceof Error ? error.message : String(error);
  return createError('UNKNOWN_ERROR', message);
}

/**
 * Convert any error to an MCP error
 */
export function toMcpError(error: unknown): McpError {
  const normalized = normalizeError(error);
  
  if (normalized instanceof McpError) {
    return normalized;
  }
  
  if (normalized instanceof AppError) {
    return normalized.toMcpError();
  }
  
  // This should never happen due to normalizeError's implementation
  return createMcpError(MCP_ERROR_CODES.UNKNOWN_ERROR_CODE, normalized.message);
}

/**
 * Convert any error to an application error
 */
export function toAppError(error: unknown): AppError {
  const normalized = normalizeError(error);
  
  if (normalized instanceof AppError) {
    return normalized;
  }
  
  if (normalized instanceof McpError) {
    return normalized.toAppError();
  }
  
  // This should never happen due to normalizeError's implementation
  return createError('UNKNOWN_ERROR', normalized.message);
} 