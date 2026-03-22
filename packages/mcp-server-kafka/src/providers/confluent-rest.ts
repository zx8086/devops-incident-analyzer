// src/providers/confluent-rest.ts
import { KafkaProviderError } from "./errors.ts";

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
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      },
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
