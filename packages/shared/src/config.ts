// shared/src/config.ts
import { z } from "zod";

export const AgentConfigSchema = z.object({
  llm: z.object({
    model: z.string(),
    haikuModel: z.string().optional(),
    region: z.string(),
  }),
  mcp: z.object({
    elasticUrl: z.string().url().optional(),
    kafkaUrl: z.string().url().optional(),
    capellaUrl: z.string().url().optional(),
    konnectUrl: z.string().url().optional(),
  }),
  checkpointer: z.object({
    type: z.enum(["memory", "sqlite"]),
    sqlitePath: z.string().optional(),
  }),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ServerConfigSchema = z.object({
  port: z.number().positive(),
  host: z.string(),
  cors: z.object({
    origins: z.array(z.string()),
  }),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
