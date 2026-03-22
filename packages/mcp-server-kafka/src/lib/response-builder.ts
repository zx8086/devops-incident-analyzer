// src/lib/response-builder.ts

interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

// biome-ignore lint/complexity/noStaticOnlyClass: namespace for tool response helpers used across all tools
export class ResponseBuilder {
  static success(data: unknown): ToolResponse {
    const text = typeof data === "string" ? data : JSON.stringify(data, bigintReplacer, 2);
    return { content: [{ type: "text", text }] };
  }

  static error(message: string): ToolResponse {
    return { content: [{ type: "text", text: message }], isError: true };
  }
}
