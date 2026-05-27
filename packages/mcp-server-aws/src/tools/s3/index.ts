// src/tools/s3/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { toMcp } from "../wrap.ts";
import { withEstate } from "../estate-schema.ts";
import { getBucketLocation, type GetBucketLocationParams, getBucketLocationSchema } from "./get-bucket-location.ts";
import { getBucketPolicyStatus, type GetBucketPolicyStatusParams, getBucketPolicyStatusSchema } from "./get-bucket-policy-status.ts";
import { listBuckets, type ListBucketsParams, listBucketsSchema } from "./list-buckets.ts";

export function registerS3Tools(server: McpServer, config: AwsConfig): void {
	const buckets = listBuckets(config);
	server.tool(
		"aws_s3_list_buckets",
		"List all S3 buckets in the account with name and creation date.",
		withEstate(config, listBucketsSchema.shape),
		async (params) => toMcp(await buckets(params as ListBucketsParams)),
	);

	const bucketLocation = getBucketLocation(config);
	server.tool(
		"aws_s3_get_bucket_location",
		"Get the AWS region where an S3 bucket is located.",
		withEstate(config, getBucketLocationSchema.shape),
		async (params) => toMcp(await bucketLocation(params as GetBucketLocationParams)),
	);

	const policyStatus = getBucketPolicyStatus(config);
	server.tool(
		"aws_s3_get_bucket_policy_status",
		"Get the policy status for an S3 bucket indicating whether the bucket is public.",
		withEstate(config, getBucketPolicyStatusSchema.shape),
		async (params) => toMcp(await policyStatus(params as GetBucketPolicyStatusParams)),
	);
}
