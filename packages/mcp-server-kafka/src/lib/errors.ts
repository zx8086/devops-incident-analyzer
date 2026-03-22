// src/lib/errors.ts

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export class KafkaToolError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "KafkaToolError";
  }

  toMcpError(): McpError {
    return new McpError(this.code, this.message);
  }
}

export function invalidParams(message: string, details?: Record<string, unknown>): KafkaToolError {
  return new KafkaToolError(message, ErrorCode.InvalidParams, details);
}

export function invalidRequest(message: string, details?: Record<string, unknown>): KafkaToolError {
  return new KafkaToolError(message, ErrorCode.InvalidRequest, details);
}

export function internalError(message: string, details?: Record<string, unknown>): KafkaToolError {
  return new KafkaToolError(message, ErrorCode.InternalError, details);
}

export function normalizeError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  if (error instanceof KafkaToolError) return error.toMcpError();
  if (error instanceof z.ZodError) {
    const message = error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    return new McpError(ErrorCode.InvalidParams, message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new McpError(ErrorCode.InternalError, message);
}
