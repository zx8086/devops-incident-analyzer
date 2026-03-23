# Unified MCP Server Logger

## Problem

The 4 MCP servers (elastic, kafka, couchbase, konnect) each have custom loggers with different formats, APIs, and output mechanisms. This makes cross-server log correlation impossible and complicates debugging.

| Server | Implementation | Output Format | API Signature |
|--------|---------------|---------------|---------------|
| Elastic | `MCPCompatibleLogger` class | Manual JSON to stderr | `(msg, metadata?)` |
| Couchbase | `Logger` class | Manual JSON to stderr | `(msg, metadata?)` |
| Kafka | Pino via `wrapPino` adapter | ECS JSON / pino-pretty | `(msg, ...args)` -- metadata nested under `args` |
| Konnect | `MCPLogger` class | `console.error` + MCP notifications | `(loggerName, msg, context?)` |

## Design

### Shared Logger Factory

Create `packages/shared/src/logger.ts` exporting `createMcpLogger(serviceName: string)`.

Returns a Pino logger instance configured for MCP servers:
- **Output**: stderr (fd 2) -- stdout reserved for MCP protocol
- **Dev mode** (`NODE_ENV !== "production"`): pino-pretty with colorize
- **Prod mode**: structured JSON with OTEL trace context via Pino `mixin()` -- injects `trace.id` and `span.id` from active span
- **Redaction**: Pino `redact` option for sensitive paths (`*.token`, `*.password`, `*.secret`, `*.apiKey`, `*.authorization`, `*.key`)
- **Service label**: `{ service: serviceName }` binding on every log line

### API

```typescript
// Create logger
const logger = createMcpLogger("elastic-mcp-server");

// Standard Pino API
logger.info("Server started");
logger.info({ port: 8080, transport: "http" }, "Transport ready");
logger.error({ error: err.message }, "Connection failed");

// Child loggers for component scoping
const transportLogger = logger.child({ component: "transport" });
transportLogger.info("HTTP transport initialized");

// Flush for shutdown
logger.flush();
```

### Optional MCP Notification Dispatch

```typescript
// After McpServer is created, optionally attach for client-visible logs
attachMcpNotifications(logger, mcpServer);
```

This adds a secondary Pino destination that sends `notifications/message` to the connected MCP client. Servers that don't call this only log to stderr.

### Convenience Utilities

Re-exported from `packages/shared/src/logger.ts`:

```typescript
// Child logger shorthand
export function getChildLogger(parent: pino.Logger, component: string): pino.Logger;

// Operation measurement (replaces Couchbase/Konnect measureOperation)
export function measureOperation<T>(
  logger: pino.Logger,
  operation: string,
  fn: () => Promise<T>,
): Promise<T>;
```

### Exports from @devops-agent/shared

```typescript
export { createMcpLogger, getChildLogger, measureOperation, attachMcpNotifications } from "./logger.ts";
```

## Migration Strategy

Each server's logger file becomes a thin re-export. This means **import sites don't change** -- files that `import { logger } from "./utils/logger.js"` keep that import.

### Elastic (`packages/mcp-server-elastic/src/utils/logger.ts`)

```typescript
import { createMcpLogger } from "@devops-agent/shared";
export const logger = createMcpLogger("elastic-mcp-server");
```

Removes: `MCPCompatibleLogger` class (120 lines), manual JSON serialization, manual OTEL injection.

### Couchbase (`packages/mcp-server-couchbase/src/lib/logger.ts`)

```typescript
import { createMcpLogger, getChildLogger, measureOperation } from "@devops-agent/shared";
export const logger = createMcpLogger("couchbase-mcp-server");
export function createContextLogger(context: string) {
  return logger.child({ component: context });
}
export { measureOperation };
```

Removes: `Logger` class (125 lines), manual JSON serialization, manual OTEL injection. The `createContextLogger` and `measureOperation` functions are preserved as thin wrappers for backward compatibility.

### Kafka (`packages/mcp-server-kafka/src/logging/container.ts`)

```typescript
import { createMcpLogger } from "@devops-agent/shared";
import type pino from "pino";

let _logger: pino.Logger = createMcpLogger("kafka-mcp-server");

export function getLogger(): pino.Logger { return _logger; }
export function setLogger(logger: pino.Logger) { _logger = logger; }
export function resetLoggerContainer() { _logger = createMcpLogger("kafka-mcp-server"); }
export function createContextLogger(context: string) { return _logger.child({ component: context }); }
```

Removes: `create-logger.ts` (87 lines), `wrapPino` adapter, `ILogger` interface, ECS format dependency. The `getLogger()`/`setLogger()` container pattern is preserved. Files importing `getLogger()` don't change.

Additional changes: The `ILogger` interface in `ports/logger.port.ts` is replaced with Pino's native `Logger` type. Files that type-hint `ILogger` switch to `pino.Logger`.

### Konnect (`packages/mcp-server-konnect/src/utils/mcp-logger.ts`)

```typescript
import { attachMcpNotifications, createMcpLogger } from "@devops-agent/shared";
const _logger = createMcpLogger("konnect-mcp-server");

export const mcpLogger = {
  debug: (ctx: string, msg: string, data?: Record<string, unknown>) => _logger.child({ component: ctx }).debug(data ?? {}, msg),
  info: (ctx: string, msg: string, data?: Record<string, unknown>) => _logger.child({ component: ctx }).info(data ?? {}, msg),
  notice: (ctx: string, msg: string, data?: Record<string, unknown>) => _logger.child({ component: ctx }).info(data ?? {}, msg),
  warning: (ctx: string, msg: string, data?: Record<string, unknown>) => _logger.child({ component: ctx }).warn(data ?? {}, msg),
  error: (ctx: string, msg: string, data?: Record<string, unknown>) => _logger.child({ component: ctx }).error(data ?? {}, msg),
  critical: (ctx: string, msg: string, data?: Record<string, unknown>) => _logger.child({ component: ctx }).fatal(data ?? {}, msg),
  startup: (ctx: string, data?: Record<string, unknown>) => _logger.child({ component: ctx }).info(data ?? {}, "Server starting"),
  ready: (ctx: string, data?: Record<string, unknown>) => _logger.child({ component: ctx }).info(data ?? {}, "Server ready"),
  setMinLevelFromConfig: (level: string) => { _logger.level = level === "warn" ? "warn" : level; },
  initialize: (server: McpServer) => attachMcpNotifications(_logger, server),
};
```

Removes: `MCPLogger` class (330 lines), manual rate limiting, manual sanitization, manual OTEL injection. The `mcpLogger` facade preserves the `(loggerName, message, context?)` API so 27 import sites don't change. RFC 5424 `notice` maps to Pino `info`, `critical`/`alert`/`emergency` map to Pino `fatal`.

## Files Changed

### New
- `packages/shared/src/logger.ts`

### Modified (logger re-exports)
- `packages/mcp-server-elastic/src/utils/logger.ts`
- `packages/mcp-server-couchbase/src/lib/logger.ts`
- `packages/mcp-server-kafka/src/logging/container.ts`
- `packages/mcp-server-konnect/src/utils/mcp-logger.ts`

### Removed
- `packages/mcp-server-kafka/src/logging/create-logger.ts`
- `packages/mcp-server-kafka/src/logging/ports/logger.port.ts`

### Updated (ILogger -> pino.Logger)
- All Kafka files importing `ILogger`: `client-manager.ts`, `kafka-service.ts`, etc.

### Dependencies
- Add `pino` to `packages/shared/package.json`
- Add `pino-pretty` to `packages/shared/devDependencies`
- Remove `@elastic/ecs-pino-format` from Kafka (no longer needed)

## Output Format (all servers, prod)

```json
{"level":30,"time":1711234567890,"service":"elastic-mcp-server","msg":"Tool call completed: list_indices","tool":"list_indices","duration":142,"trace.id":"abc123","span.id":"def456"}
```

## Output Format (all servers, dev)

```
[12:34:56.789] INFO (elastic-mcp-server): Tool call completed: list_indices
    tool: "list_indices"
    duration: 142
```

## Verification

- `bun run typecheck` passes for all 4 servers + shared
- `bun run lint` passes
- Each server starts with identical log format
- OTEL trace.id/span.id appear in prod logs when TELEMETRY_MODE is set
- Sensitive fields are redacted in log output
