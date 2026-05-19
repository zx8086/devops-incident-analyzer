# Kafka Provider Factory

A portable, single-interface pattern for connecting to **local Kafka**, **AWS MSK**, or **Confluent Cloud** from the same codebase. The application asks the factory for a `KafkaProvider`, gets back a `KafkaConnectionConfig`, and hands that to its Kafka client. The provider type stays out of the business logic.

This document is self-contained so it can be reimplemented in another repo. Source of truth: `packages/mcp-server-kafka/src/providers/`.

## Why a factory

Each Kafka flavor has a different auth + connection contract:

- **Local** — PLAINTEXT, bootstrap servers from env, no auth.
- **MSK** — SASL/OAUTHBEARER with a short-lived IAM token (rotated every ~15min), TLS, optional broker discovery from a cluster ARN. Or SASL-less TLS-only, or PLAINTEXT.
- **Confluent Cloud** — SASL/PLAIN with API key/secret, TLS, optional REST API for cluster metadata.

Without a factory you end up with `if (provider === "msk") { ... } else if (...)` scattered through the codebase. The factory funnels all of that into one place and returns a uniform interface.

## The contract

```ts
// providers/types.ts
import type { ConnectionOptions, SASLOptions } from "@platformatic/kafka";

export type MskAuthMode = "iam" | "tls" | "none";

export interface KafkaConnectionConfig {
  clientId: string;
  bootstrapBrokers: string[];
  sasl?: SASLOptions;
  tls?: ConnectionOptions["tls"];
  connectTimeout?: number;
  timeout?: number;
  retries?: number | boolean;
  retryDelay?: number;
}

export interface KafkaProvider {
  readonly type: "msk" | "confluent" | "local";
  readonly name: string;
  getConnectionConfig(): Promise<KafkaConnectionConfig>;
  getClusterMetadata?(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
```

`KafkaConnectionConfig` is shaped for `@platformatic/kafka`, but the fields map cleanly to `kafkajs` or `node-rdkafka` — substitute the SASL/TLS option names from your library.

`getClusterMetadata()` is optional; it surfaces broker/cluster info for ops tools (UI, health checks) without coupling to the SDK.

`close()` is mandatory because MSK caches an IAM token and Confluent holds a REST HTTP client.

## The factory

```ts
// providers/factory.ts
export function createProvider(config: AppConfig): KafkaProvider {
  const { kafka } = config;

  // Surface the resolved auth posture before connecting.
  // Critical for MSK because it now defaults to PLAINTEXT (none) when MSK_AUTH_MODE is unset.
  if (kafka.provider === "msk" && !process.env.MSK_AUTH_MODE) {
    logger.warn(
      { resolvedAuthMode: config.msk.authMode },
      "MSK_AUTH_MODE is unset; defaulting to 'none' (PLAINTEXT). " +
        "If your MSK cluster requires IAM, set MSK_AUTH_MODE=iam (or =tls for TLS-only).",
    );
  }

  switch (kafka.provider) {
    case "local":
      return new LocalKafkaProvider(config.local.bootstrapServers, kafka.clientId);

    case "confluent":
      return new ConfluentKafkaProvider(
        config.confluent.bootstrapServers,
        config.confluent.apiKey,
        config.confluent.apiSecret,
        kafka.clientId,
        config.confluent.restEndpoint || undefined,
        config.confluent.clusterId || undefined,
      );

    case "msk":
      return new MskKafkaProvider(
        config.msk.bootstrapBrokers,
        config.msk.clusterArn,
        config.msk.region,
        kafka.clientId,
        config.msk.authMode,
      );

    default:
      throw new KafkaProviderError(`Unknown provider: ${kafka.provider}`, "PROVIDER_NOT_FOUND", kafka.provider);
  }
}
```

The factory does three things and nothing else: warn about ambiguous defaults, dispatch on `kafka.provider`, and throw a typed error on unknown values. All field validation happens upstream in the Zod schema (see *Config schema* below).

## Provider implementations

### Local

```ts
// providers/local.ts
export class LocalKafkaProvider implements KafkaProvider {
  readonly type = "local" as const;
  readonly name = "Local Kafka";

  constructor(private readonly bootstrapServers: string, private readonly clientId: string) {}

  async getConnectionConfig(): Promise<KafkaConnectionConfig> {
    return {
      clientId: this.clientId,
      bootstrapBrokers: this.bootstrapServers.split(",").map((s) => s.trim()),
    };
  }

  async close(): Promise<void> {}
}
```

Nothing to clean up; no auth.

### Confluent Cloud

```ts
// providers/confluent.ts
export class ConfluentKafkaProvider implements KafkaProvider {
  readonly type = "confluent" as const;
  readonly name = "Confluent Cloud";
  private restClient: ConfluentRestClient | null = null;

  constructor(
    private readonly bootstrapServers: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly clientId: string,
    private readonly restEndpoint?: string,
    private readonly clusterId?: string,
  ) {
    if (this.restEndpoint && this.clusterId) {
      this.restClient = new ConfluentRestClient(this.restEndpoint, this.apiKey, this.apiSecret);
    }
  }

  async getConnectionConfig(): Promise<KafkaConnectionConfig> {
    return {
      clientId: this.clientId,
      bootstrapBrokers: this.bootstrapServers.split(",").map((s) => s.trim()),
      sasl: {
        mechanism: "PLAIN",
        username: this.apiKey,
        password: this.apiSecret,
      },
      tls: { rejectUnauthorized: true },
    };
  }

  async getClusterMetadata(): Promise<Record<string, unknown>> {
    if (!this.restClient || !this.clusterId) {
      return { provider: "confluent", note: "REST API not configured" };
    }
    try {
      return await this.restClient.getClusterInfo(this.clusterId);
    } catch (error) {
      return { provider: "confluent", restApiError: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    this.restClient = null;
  }
}
```

`SASL/PLAIN + TLS` is the documented Confluent Cloud contract. Metadata enrichment is additive — a REST failure doesn't break connections.

```ts
// providers/confluent-rest.ts
export class ConfluentRestClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(restEndpoint: string, apiKey: string, apiSecret: string) {
    this.baseUrl = restEndpoint.replace(/\/$/, "");
    this.authHeader = `Basic ${btoa(`${apiKey}:${apiSecret}`)}`;
  }

  async getClusterInfo(clusterId: string): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}/kafka/v3/clusters/${clusterId}`;
    const response = await fetch(url, {
      headers: { Authorization: this.authHeader, "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new KafkaProviderError(
        `Confluent REST API error: ${response.status} ${response.statusText}`,
        "PROVIDER_CONNECTION_FAILED",
        "confluent",
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }
}
```

### AWS MSK

```ts
// providers/msk.ts
export class MskKafkaProvider implements KafkaProvider {
  readonly type = "msk" as const;
  readonly name: string;
  private cachedToken: { token: string; expiresAt: number } | null = null;
  private resolvedBrokers: string | null = null;

  constructor(
    private readonly bootstrapBrokers: string,
    private readonly clusterArn: string,
    private readonly region: string,
    private readonly clientId: string,
    private readonly authMode: MskAuthMode = "iam",
  ) {
    this.name = `AWS MSK (${authMode})`;
  }

  async getConnectionConfig(): Promise<KafkaConnectionConfig> {
    const brokers = await this.resolveBrokers();
    const bootstrapBrokers = brokers.split(",").map((s) => s.trim());

    if (this.authMode === "none") {
      return { clientId: this.clientId, bootstrapBrokers };
    }
    if (this.authMode === "tls") {
      return { clientId: this.clientId, bootstrapBrokers, tls: { rejectUnauthorized: true } };
    }
    // iam (default)
    return {
      clientId: this.clientId,
      bootstrapBrokers,
      sasl: { mechanism: "OAUTHBEARER", token: () => this.getToken() },
      tls: { rejectUnauthorized: true },
      // MSK Serverless has cold-start latency
      connectTimeout: 60_000,
      timeout: 60_000,
      retries: 5,
      retryDelay: 2_000,
    };
  }

  async close(): Promise<void> {
    this.cachedToken = null;
    this.resolvedBrokers = null;
  }

  private async getToken(): Promise<string> {
    // Proactive refresh: 60s before expiry
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) {
      return this.cachedToken.token;
    }
    try {
      const { generateAuthToken } = await import("aws-msk-iam-sasl-signer-js");
      const result = await generateAuthToken({ region: this.region });
      this.cachedToken = { token: result.token, expiresAt: result.expiryTime };
      return this.cachedToken.token;
    } catch (error) {
      throw new KafkaProviderError(
        `Failed to generate MSK IAM token: ${error instanceof Error ? error.message : String(error)}`,
        "PROVIDER_AUTH_FAILED",
        "msk",
        error,
      );
    }
  }

  private async resolveBrokers(): Promise<string> {
    if (this.bootstrapBrokers) return this.bootstrapBrokers;
    if (this.resolvedBrokers) return this.resolvedBrokers;

    if (!this.clusterArn) {
      throw new KafkaProviderError(
        "MSK provider requires either bootstrapBrokers or clusterArn",
        "PROVIDER_CONFIG_INVALID",
        "msk",
      );
    }

    const { KafkaClient, GetBootstrapBrokersCommand } = await import("@aws-sdk/client-kafka");
    const client = new KafkaClient({ region: this.region });
    const response = await client.send(new GetBootstrapBrokersCommand({ ClusterArn: this.clusterArn }));
    const brokers = pickBrokerString(response, this.authMode);
    if (!brokers) {
      throw new KafkaProviderError(
        `No bootstrap brokers found for MSK cluster (authMode=${this.authMode})`,
        "PROVIDER_CONFIG_INVALID",
        "msk",
      );
    }
    this.resolvedBrokers = brokers;
    return brokers;
  }
}

export function pickBrokerString(response: BootstrapBrokersResponse, authMode: MskAuthMode): string | undefined {
  if (authMode === "iam") {
    return response.BootstrapBrokerStringSaslIam ?? response.BootstrapBrokerStringPublicSaslIam ?? undefined;
  }
  if (authMode === "tls") {
    return response.BootstrapBrokerStringTls ?? response.BootstrapBrokerStringPublicTls ?? undefined;
  }
  return response.BootstrapBrokerString ?? response.BootstrapBrokerStringPublic ?? undefined;
}
```

Three non-obvious things to keep when porting MSK:

1. **Token caching with a 60s safety margin.** `aws-msk-iam-sasl-signer-js` returns a ~15-minute token. Refresh before it expires, not on auth failure — recovering from a mid-connection token expiry is much harder than rotating early.
2. **Broker discovery from cluster ARN.** Either `MSK_BOOTSTRAP_BROKERS` or `MSK_CLUSTER_ARN` is required. If only the ARN is set, `GetBootstrapBrokersCommand` resolves brokers once and caches them. `pickBrokerString` picks the right field for the chosen auth mode (private endpoints first, public endpoints as fallback).
3. **Generous timeouts.** MSK Serverless cold-starts can take 30-60s. Defaulting `connectTimeout`/`timeout` to 60s + 5 retries avoids spurious failures during the first connection of a deployment.

### Error type

```ts
// providers/errors.ts
export type ProviderErrorCode =
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_CONFIG_INVALID"
  | "PROVIDER_CONNECTION_FAILED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_TIMEOUT";

export class KafkaProviderError extends Error {
  public readonly code: ProviderErrorCode;
  public readonly provider: string;
  public override readonly cause?: unknown;

  constructor(message: string, code: ProviderErrorCode, provider: string, cause?: unknown) {
    super(message);
    this.name = "KafkaProviderError";
    this.code = code;
    this.provider = provider;
    this.cause = cause;
  }
}
```

A single typed error class lets callers distinguish config bugs (`PROVIDER_CONFIG_INVALID`) from runtime auth failures (`PROVIDER_AUTH_FAILED`) without inspecting message strings.

## Config schema (Zod)

The factory takes a validated `AppConfig`. Validation happens once at startup, so factory + provider code can assume well-formed input:

```ts
// config/schemas.ts (excerpt)
export const kafkaSchema = z.object({
  provider: z.enum(["local", "msk", "confluent"]),
  clientId: z.string(),
  // ...feature flags like allowWrites, allowDestructive, timeouts
}).strict();

export const mskSchema = z.object({
  bootstrapBrokers: z.string(),     // may be empty if clusterArn is set
  clusterArn: z.string(),           // may be empty if bootstrapBrokers is set
  region: z.string(),
  authMode: z.enum(["iam", "tls", "none"]),
}).strict();

export const confluentSchema = z.object({
  bootstrapServers: z.string(),
  apiKey: z.string(),
  apiSecret: z.string(),
  restEndpoint: z.string(),
  clusterId: z.string(),
}).strict();

export const localSchema = z.object({
  bootstrapServers: z.string(),
}).strict();

export const configSchema = z.object({
  kafka: kafkaSchema,
  msk: mskSchema,
  confluent: confluentSchema,
  local: localSchema,
}).superRefine((config, ctx) => {
  if (config.kafka.provider === "msk") {
    if (!config.msk.bootstrapBrokers && !config.msk.clusterArn) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["msk"],
        message: "MSK provider requires msk.bootstrapBrokers or msk.clusterArn to be set",
      });
    }
  }
  if (config.kafka.provider === "confluent") {
    for (const field of ["bootstrapServers", "apiKey", "apiSecret"] as const) {
      if (!config.confluent[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["confluent", field],
          message: `Confluent provider requires confluent.${field} to be set`,
        });
      }
    }
  }
});
```

The `superRefine` cross-field validation is the part most ports get wrong. Per-field `.min(1)` doesn't work because `msk.bootstrapBrokers` is legitimately empty when `clusterArn` is set, and Confluent fields are only required when `provider === "confluent"`.

## Environment variable mapping

```ts
// config/envMapping.ts
export const envMapping: Record<string, string> = {
  KAFKA_PROVIDER: "kafka.provider",
  KAFKA_CLIENT_ID: "kafka.clientId",

  MSK_BOOTSTRAP_BROKERS: "msk.bootstrapBrokers",
  MSK_CLUSTER_ARN: "msk.clusterArn",
  AWS_REGION: "msk.region",
  MSK_AUTH_MODE: "msk.authMode",

  CONFLUENT_BOOTSTRAP_SERVERS: "confluent.bootstrapServers",
  CONFLUENT_API_KEY: "confluent.apiKey",
  CONFLUENT_API_SECRET: "confluent.apiSecret",
  CONFLUENT_REST_ENDPOINT: "confluent.restEndpoint",
  CONFLUENT_CLUSTER_ID: "confluent.clusterId",

  LOCAL_BOOTSTRAP_SERVERS: "local.bootstrapServers",
};
```

The mapping flattens env vars to dotted Zod-schema paths. A small loader reads each env var, sets it at the dotted path in a plain object, then runs the object through `configSchema.parse()`. This decouples "how config arrives" (env, file, secret manager) from "what config means."

## Usage

```ts
// app bootstrap
import { loadConfig } from "./config/loader.ts";
import { createProvider } from "./providers/factory.ts";

const config = loadConfig();                       // env -> validated AppConfig
const provider = createProvider(config);           // dispatch on kafka.provider
const { bootstrapBrokers, sasl, tls } = await provider.getConnectionConfig();

const client = new Client({
  clientId: config.kafka.clientId,
  bootstrapBrokers,
  sasl,
  tls,
});

// later, on shutdown:
await provider.close();
```

Switching environments is a single env var:

```bash
KAFKA_PROVIDER=local LOCAL_BOOTSTRAP_SERVERS=localhost:9092 bun start
KAFKA_PROVIDER=msk MSK_CLUSTER_ARN=arn:... AWS_REGION=eu-west-1 MSK_AUTH_MODE=iam bun start
KAFKA_PROVIDER=confluent CONFLUENT_BOOTSTRAP_SERVERS=pkc-....confluent.cloud:9092 CONFLUENT_API_KEY=... CONFLUENT_API_SECRET=... bun start
```

## Porting checklist

1. Copy `providers/{types,errors,local,confluent,confluent-rest,msk,factory}.ts` and adapt the Zod schema fields you need.
2. Add `@aws-sdk/client-kafka` and `aws-msk-iam-sasl-signer-js` as optional deps. The MSK provider lazy-imports them, so projects that only use local/Confluent never pay the cost.
3. Decide your client library. If you're not using `@platformatic/kafka`, swap the `KafkaConnectionConfig` field names for your library's (e.g., `kafkajs` uses `brokers` not `bootstrapBrokers`, and `ssl` not `tls`).
4. Wire the factory once at startup. Pass the resulting `KafkaProvider` to whatever owns the Kafka client lifecycle. Never call `createProvider` from request-handling code.
5. Call `await provider.close()` in your SIGTERM handler. For MSK this clears the cached token; for Confluent it drops the REST client.
6. Add a startup log line with `provider.name`. Operators need to see *which* flavor connected, including the auth mode for MSK (`AWS MSK (iam)` vs `AWS MSK (none)`).

## What this pattern deliberately does NOT do

- **No runtime provider switching.** `KAFKA_PROVIDER` is read once. Supporting hot-swap would force every consumer to handle reconnects.
- **No connection pooling at the provider layer.** Pooling belongs in whatever wraps the Kafka client (e.g., a `KafkaClientManager`). The provider only describes *how* to connect.
- **No automatic IAM token refresh during a live connection.** `@platformatic/kafka` calls `token()` again when the broker requests reauth; the provider just caches with a 60s safety margin. If your library doesn't re-invoke the token callback, you'll need a wrapper that reconnects on token expiry.
