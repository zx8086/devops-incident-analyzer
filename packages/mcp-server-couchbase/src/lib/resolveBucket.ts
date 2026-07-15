// src/lib/resolveBucket.ts

import type { Bucket } from "couchbase";

// SIO-1107: multi-bucket support. Bucket names may contain hyphens, which the
// assertIdentifier whitelist rejects -- so bucket names are NEVER spliced into
// SQL; resolution happens only through the SDK handle. cluster.bucket() returns
// a lazy handle without validating existence, so a bogus name surfaces as a
// normal query/KV error at call time (same error contract as the default bucket).
export function resolveBucket(defaultBucket: Bucket, bucketName?: string): Bucket {
	if (!bucketName || bucketName === defaultBucket.name) return defaultBucket;
	return defaultBucket.cluster.bucket(bucketName);
}
