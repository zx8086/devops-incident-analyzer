// checkpointer/src/memory.ts
import { MemorySaver } from "@langchain/langgraph-checkpoint";

export function createMemoryCheckpointer(): MemorySaver {
  return new MemorySaver();
}
