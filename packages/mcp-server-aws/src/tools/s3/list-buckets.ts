// src/tools/s3/list-buckets.ts
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getS3Client } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const listBucketsSchema = z.object({});

export type ListBucketsParams = z.infer<typeof listBucketsSchema>;

export function listBuckets(config: AwsConfig) {
	return wrapListTool({
		name: "aws_s3_list_buckets",
		listField: "Buckets",
		fn: async (_params: ListBucketsParams) => {
			const client = getS3Client(config);
			return client.send(new ListBucketsCommand({}));
		},
	});
}
