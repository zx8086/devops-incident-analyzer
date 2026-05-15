// src/tools/s3/get-bucket-policy-status.ts
import { GetBucketPolicyStatusCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getS3Client } from "../../services/client-factory.ts";
import { wrapBlobTool } from "../wrap.ts";

export const getBucketPolicyStatusSchema = z.object({
	Bucket: z.string().describe("S3 bucket name"),
});

export type GetBucketPolicyStatusParams = z.infer<typeof getBucketPolicyStatusSchema>;

export function getBucketPolicyStatus(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_s3_get_bucket_policy_status",
		fn: async (params: GetBucketPolicyStatusParams) => {
			const client = getS3Client(config);
			return client.send(
				new GetBucketPolicyStatusCommand({
					Bucket: params.Bucket,
				}),
			);
		},
	});
}
