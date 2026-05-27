// src/tools/s3/get-bucket-location.ts
import { GetBucketLocationCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getS3Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { wrapBlobTool } from "../wrap.ts";

export const getBucketLocationSchema = z.object({
	Bucket: z.string().describe("S3 bucket name"),
});

export type GetBucketLocationParams = WithEstate<z.infer<typeof getBucketLocationSchema>>;

export function getBucketLocation(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_s3_get_bucket_location",
		fn: async (params: GetBucketLocationParams) => {
			const client = getS3Client(config, params.estate);
			return client.send(
				new GetBucketLocationCommand({
					Bucket: params.Bucket,
				}),
			);
		},
	});
}
