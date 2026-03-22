/* src/lib/responseBuilder.ts */

import { logger } from "./logger";
import { AppError, getErrorCode, getErrorMessage } from "./errors";

export type ResponseType = "json" | "text" | "error";

export interface ResponseContent {
  type: ResponseType;
  data: unknown;
  metadata?: Record<string, unknown>;
}

export class ResponseBuilder {
  private content: ResponseContent[] = [];
  private metadata: Record<string, unknown> = {};

  static success(data: unknown, type: ResponseType = "json", metadata?: Record<string, unknown>): ResponseBuilder {
    const builder = new ResponseBuilder();
    return builder.addContent(data, type, metadata);
  }

  static error(message: string, error?: unknown): ResponseBuilder {
    const builder = new ResponseBuilder();
    return builder.addError(message, error);
  }

  addContent(data: unknown, type: ResponseType = "json", metadata?: Record<string, unknown>): ResponseBuilder {
    this.content.push({
      type,
      data,
      metadata,
    });
    return this;
  }

  addError(message: string, error?: unknown): ResponseBuilder {
    const errorCode = error ? getErrorCode(error) : "UNKNOWN_ERROR";
    const errorMessage = error ? getErrorMessage(error) : message;

    logger.error("Error response", {
      code: errorCode,
      message: errorMessage,
      originalError: error,
    });

    this.content.push({
      type: "error",
      data: {
        code: errorCode,
        message: errorMessage,
      },
    });
    return this;
  }

  setMetadata(metadata: Record<string, unknown>): ResponseBuilder {
    this.metadata = { ...this.metadata, ...metadata };
    return this;
  }

  build(): { content: Array<{ type: string; text: string }> } {
    return {
      content: this.content.map((item) => {
        switch (item.type) {
          case "json":
            return {
              type: "text",
              text: JSON.stringify(item.data, null, 2),
            };
          case "text":
            return {
              type: "text",
              text: String(item.data),
            };
          case "error":
            return {
              type: "text",
              text: `Error: ${(item.data as { message: string }).message}`,
            };
          default:
            return {
              type: "text",
              text: String(item.data),
            };
        }
      }),
    };
  }
} 