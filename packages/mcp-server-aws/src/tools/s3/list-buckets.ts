// src/tools/s3/list-buckets.ts
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getS3Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapListTool } from "../wrap.ts";

// No tool-specific args; the registration layer merges in `estate`.
// Keep the schema permissive so WithEstate<> intersection stays valid (an
// empty z.object infers as Record<string, never>, which intersects to never).
export const listBucketsSchema = z.object({}).passthrough();

export type ListBucketsParams = WithEstate<z.infer<typeof listBucketsSchema>>;

export function listBuckets(config: AwsConfig) {
	return wrapListTool({
		name: "aws_s3_list_buckets",
		listField: "Buckets",
		fn: async (params: ListBucketsParams) => {
			const client = getS3Client(config, params.estate);
			return client.send(new ListBucketsCommand({}));
		},
	});
}
