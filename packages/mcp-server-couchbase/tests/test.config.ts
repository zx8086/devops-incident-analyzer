/* tests/test.config.ts */

import { z } from "zod";

export const testConfig = {
  server: {
    name: "couchbase-capella-mcp",
    version: "1.0.0",
    readOnlyQueryMode: true,
    transportMode: "stdio",
    port: 8080
  },
  database: {
    connectionString: "couchbases://cb.3qpvkzizaf9npz7s.cloud.couchbase.com",
    bucketName: "default"
  },
  logging: {
    level: "info",
    format: "json"
  }
};

export const testConfigSchema = z.object({
  server: z.object({
    name: z.string(),
    version: z.string(),
    readOnlyQueryMode: z.boolean(),
    transportMode: z.string(),
    port: z.number()
  }),
  database: z.object({
    connectionString: z.string(),
    bucketName: z.string()
  }),
  logging: z.object({
    level: z.string(),
    format: z.string()
  })
}); 