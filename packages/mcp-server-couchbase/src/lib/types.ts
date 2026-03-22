/* src/lib/types.ts */

import type { Bucket } from "couchbase";

export interface DocumentContent {
	[key: string]: unknown;
}

export interface QueryResult {
	rows: unknown[];
	meta?: Record<string, unknown>;
}

export interface DatabaseOperation {
	scope: string;
	collection: string;
	id: string;
	content?: DocumentContent;
}

export interface QueryParams {
	scope_name: string;
	query: string;
}

export interface BucketInfo {
	name: string;
	scopes: ScopeInfo[];
}

export interface ScopeInfo {
	name: string;
	collections: CollectionInfo[];
}

export interface CollectionInfo {
	name: string;
	type: string;
}

export interface DatabaseContext {
	bucket: Bucket;
}

export interface OperationContext {
	lifespanContext: DatabaseContext;
}

export type OperationResult<T = unknown> = {
	success: boolean;
	data?: T;
	error?: Error;
};
