// src/providers/msk.ts

import { KafkaProviderError } from "./errors.ts";
import type { KafkaConnectionConfig, KafkaProvider } from "./types.ts";

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class MskKafkaProvider implements KafkaProvider {
  readonly type = "msk" as const;
  readonly name = "AWS MSK";
  private cachedToken: CachedToken | null = null;
  private resolvedBrokers: string | null = null;

  constructor(
    private readonly bootstrapBrokers: string,
    private readonly clusterArn: string,
    private readonly region: string,
    private readonly clientId: string,
  ) {}

  async getConnectionConfig(): Promise<KafkaConnectionConfig> {
    const brokers = await this.resolveBrokers();

    return {
      clientId: this.clientId,
      bootstrapBrokers: brokers.split(",").map((s) => s.trim()),
      sasl: {
        mechanism: "OAUTHBEARER",
        token: () => this.getToken(),
      },
      tls: { rejectUnauthorized: true },
    };
  }

  async getClusterMetadata(): Promise<Record<string, unknown>> {
    if (!this.clusterArn) {
      return { provider: "msk", note: "Cluster ARN not configured" };
    }

    try {
      const { KafkaClient, DescribeClusterV2Command } = await import("@aws-sdk/client-kafka");
      const client = new KafkaClient({ region: this.region });
      const response = await client.send(
        new DescribeClusterV2Command({ ClusterArn: this.clusterArn }),
      );
      return {
        provider: "msk",
        clusterArn: this.clusterArn,
        region: this.region,
        ...(response.ClusterInfo ?? {}),
      };
    } catch (error) {
      return {
        provider: "msk",
        clusterArn: this.clusterArn,
        region: this.region,
        awsError: error instanceof Error ? error.message : String(error),
      };
    }
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
      this.cachedToken = {
        token: result.token,
        expiresAt: result.expiryTime,
      };
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
    if (this.bootstrapBrokers) {
      return this.bootstrapBrokers;
    }

    if (this.resolvedBrokers) {
      return this.resolvedBrokers;
    }

    if (!this.clusterArn) {
      throw new KafkaProviderError(
        "MSK provider requires either bootstrapBrokers or clusterArn",
        "PROVIDER_CONFIG_INVALID",
        "msk",
      );
    }

    try {
      const { KafkaClient, GetBootstrapBrokersCommand } = await import("@aws-sdk/client-kafka");
      const client = new KafkaClient({ region: this.region });
      const response = await client.send(
        new GetBootstrapBrokersCommand({ ClusterArn: this.clusterArn }),
      );

      const brokers =
        response.BootstrapBrokerStringSaslIam ??
        response.BootstrapBrokerStringPublicSaslIam ??
        response.BootstrapBrokerString;

      if (!brokers) {
        throw new KafkaProviderError(
          "No bootstrap brokers found for MSK cluster",
          "PROVIDER_CONFIG_INVALID",
          "msk",
        );
      }

      this.resolvedBrokers = brokers;
      return brokers;
    } catch (error) {
      if (error instanceof KafkaProviderError) throw error;
      throw new KafkaProviderError(
        `Failed to discover MSK brokers: ${error instanceof Error ? error.message : String(error)}`,
        "PROVIDER_CONNECTION_FAILED",
        "msk",
        error,
      );
    }
  }
}
