// src/tools/schema/operations.ts

import type { SchemaRegistryService } from "../../services/schema-registry-service.ts";

export async function listSchemas(service: SchemaRegistryService) {
  const subjects = await service.listSubjects();
  return { subjects, count: subjects.length };
}

export async function getSchema(
  service: SchemaRegistryService,
  params: { subject: string; version?: number | "latest" },
) {
  return service.getSchema(params.subject, params.version ?? "latest");
}

export async function getSchemaVersions(
  service: SchemaRegistryService,
  params: { subject: string },
) {
  const versions = await service.getSchemaVersions(params.subject);
  return { subject: params.subject, versions };
}

export async function registerSchema(
  service: SchemaRegistryService,
  params: {
    subject: string;
    schema: string;
    schemaType?: "AVRO" | "JSON" | "PROTOBUF";
  },
) {
  const result = await service.registerSchema(
    params.subject,
    params.schema,
    params.schemaType ?? "AVRO",
  );
  return { subject: params.subject, ...result };
}

export async function checkCompatibility(
  service: SchemaRegistryService,
  params: {
    subject: string;
    schema: string;
    schemaType?: "AVRO" | "JSON" | "PROTOBUF";
    version?: number | "latest";
  },
) {
  const result = await service.checkCompatibility(
    params.subject,
    params.schema,
    params.schemaType ?? "AVRO",
    params.version ?? "latest",
  );
  return { subject: params.subject, ...result };
}

export async function getSchemaConfig(
  service: SchemaRegistryService,
  params: { subject?: string },
) {
  const config = await service.getSubjectConfig(params.subject);
  return {
    scope: params.subject ?? "global",
    ...config,
  };
}

export async function setSchemaConfig(
  service: SchemaRegistryService,
  params: { subject?: string; compatibilityLevel: string },
) {
  const result = await service.setSubjectConfig(params.compatibilityLevel, params.subject);
  return {
    scope: params.subject ?? "global",
    ...result,
  };
}

export async function deleteSchemaSubject(
  service: SchemaRegistryService,
  params: { subject: string; permanent?: boolean },
) {
  const deletedVersions = await service.deleteSubject(params.subject, params.permanent ?? false);
  return {
    subject: params.subject,
    deletedVersions,
    permanent: params.permanent ?? false,
  };
}
