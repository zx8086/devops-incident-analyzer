// src/services/schema-registry-service.ts

import type { AppConfig } from "../config/schemas.ts";

export interface SchemaInfo {
  subject: string;
  id: number;
  version: number;
  schemaType: string;
  schema: string;
}

export interface CompatibilityResult {
  is_compatible: boolean;
  messages?: string[];
}

export class SchemaRegistryService {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: AppConfig) {
    this.baseUrl = config.schemaRegistry.url.replace(/\/$/, "");
    this.headers = {
      "Content-Type": "application/vnd.schemaregistry.v1+json",
      Accept: "application/vnd.schemaregistry.v1+json",
    };

    if (config.schemaRegistry.apiKey && config.schemaRegistry.apiSecret) {
      this.headers.Authorization = `Basic ${btoa(`${config.schemaRegistry.apiKey}:${config.schemaRegistry.apiSecret}`)}`;
    }
  }

  async listSubjects(): Promise<string[]> {
    const response = await this.request<string[]>("GET", "/subjects");
    return response;
  }

  async getSchemaVersions(subject: string): Promise<number[]> {
    return this.request<number[]>("GET", `/subjects/${encodeURIComponent(subject)}/versions`);
  }

  async getSchema(subject: string, version: number | "latest" = "latest"): Promise<SchemaInfo> {
    return this.request<SchemaInfo>(
      "GET",
      `/subjects/${encodeURIComponent(subject)}/versions/${version}`,
    );
  }

  async getSchemaById(id: number): Promise<{ schema: string; schemaType?: string }> {
    return this.request<{ schema: string; schemaType?: string }>("GET", `/schemas/ids/${id}`);
  }

  async registerSchema(
    subject: string,
    schema: string,
    schemaType: "AVRO" | "JSON" | "PROTOBUF" = "AVRO",
  ): Promise<{ id: number }> {
    return this.request<{ id: number }>(
      "POST",
      `/subjects/${encodeURIComponent(subject)}/versions`,
      { schema, schemaType },
    );
  }

  async checkCompatibility(
    subject: string,
    schema: string,
    schemaType: "AVRO" | "JSON" | "PROTOBUF" = "AVRO",
    version: number | "latest" = "latest",
  ): Promise<CompatibilityResult> {
    return this.request<CompatibilityResult>(
      "POST",
      `/compatibility/subjects/${encodeURIComponent(subject)}/versions/${version}`,
      { schema, schemaType },
    );
  }

  async getSubjectConfig(subject?: string): Promise<{ compatibilityLevel: string }> {
    const path = subject ? `/config/${encodeURIComponent(subject)}` : "/config";
    return this.request<{ compatibilityLevel: string }>("GET", path);
  }

  async setSubjectConfig(
    compatibilityLevel: string,
    subject?: string,
  ): Promise<{ compatibility: string }> {
    const path = subject ? `/config/${encodeURIComponent(subject)}` : "/config";
    return this.request<{ compatibility: string }>("PUT", path, {
      compatibility: compatibilityLevel,
    });
  }

  async deleteSubject(subject: string, permanent = false): Promise<number[]> {
    const query = permanent ? "?permanent=true" : "";
    return this.request<number[]>("DELETE", `/subjects/${encodeURIComponent(subject)}${query}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers: this.headers,
    };

    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "Unknown error");
      throw new Error(`Schema Registry error ${response.status}: ${errorBody}`);
    }

    return (await response.json()) as T;
  }
}
