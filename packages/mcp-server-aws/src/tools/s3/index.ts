// src/tools/s3/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { AWS_READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type GetBucketLocationParams, getBucketLocation, getBucketLocationSchema } from "./get-bucket-location.ts";
import {
	type GetBucketPolicyStatusParams,
	getBucketPolicyStatus,
	getBucketPolicyStatusSchema,
} from "./get-bucket-policy-status.ts";
import { type ListBucketsParams, listBuckets, listBucketsSchema } from "./list-buckets.ts";

export function registerS3Tools(server: McpServer, config: AwsConfig): void {
	const buckets = listBuckets(config);
	server.registerTool(
		"aws_s3_list_buckets",
		{
			description: "List all S3 buckets in the account with name and creation date.",
			inputSchema: withEstate(config, listBucketsSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await buckets(params as ListBucketsParams)),
	);

	const bucketLocation = getBucketLocation(config);
	server.registerTool(
		"aws_s3_get_bucket_location",
		{
			description: "Get the AWS region where an S3 bucket is located.",
			inputSchema: withEstate(config, getBucketLocationSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await bucketLocation(params as GetBucketLocationParams)),
	);

	const policyStatus = getBucketPolicyStatus(config);
	server.registerTool(
		"aws_s3_get_bucket_policy_status",
		{
			description: "Get the policy status for an S3 bucket indicating whether the bucket is public.",
			inputSchema: withEstate(config, getBucketPolicyStatusSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await policyStatus(params as GetBucketPolicyStatusParams)),
	);
}
