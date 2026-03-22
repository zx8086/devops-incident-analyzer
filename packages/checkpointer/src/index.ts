// checkpointer/src/index.ts
import { createMemoryCheckpointer } from "./memory.ts";

export type CheckpointerType = "memory" | "sqlite";

export function createCheckpointer(type: CheckpointerType = "memory") {
  switch (type) {
    case "memory":
      return createMemoryCheckpointer();
    case "sqlite":
      // SIO-557: bun:sqlite checkpointer will be implemented in production phase
      throw new Error("SQLite checkpointer not yet implemented. Use 'memory' for development.");
    default:
      throw new Error(`Unknown checkpointer type: ${type}`);
  }
}

export { createMemoryCheckpointer } from "./memory.ts";
