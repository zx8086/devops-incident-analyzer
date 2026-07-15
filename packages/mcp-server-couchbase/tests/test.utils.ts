/* tests/test.utils.ts */

import type { Bucket, Cluster } from "couchbase";

type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

export interface RecordedQuery {
	statement: string;
	options?: { parameters?: Record<string, unknown> };
	scope?: string;
}

// SIO-1107: per-statement stub for scope-context queries (INFER/EXPLAIN/ADVISOR
// tests). First pattern matching the statement wins; no match falls through to
// the legacy all-documents behavior so pre-existing tests are unaffected.
export interface ScopeQueryStub {
	pattern: RegExp;
	rows?: unknown[];
	error?: Error;
}

export class MockBucket implements Partial<Bucket> {
	private documents: Map<string, unknown> = new Map();
	name: string;
	clusterRef: MockCluster;
	scopeQueryCalls: RecordedQuery[] = [];
	scopeQueryStubs: ScopeQueryStub[] = [];

	constructor(clusterRef?: MockCluster, name: string = "default") {
		this.name = name;
		// Every MockBucket is reachable from a cluster so tools using
		// bucket.cluster (queryAnalysis, getBuckets) work out of the box.
		this.clusterRef = clusterRef ?? new MockCluster();
		if (!clusterRef) this.clusterRef.attachDefaultBucket(this);
	}

	get cluster(): Cluster {
		return this.clusterRef as Cluster;
	}

	async ping() {
		return { id: "mock-bucket-ping", services: { kv: [{ state: "ok", latency_us: 120, remote: "mock:11210" }] } };
	}

	scope(name: string) {
		return {
			collection: (_collectionName: string) => ({
				get: async (id: string) => {
					if (!id) throw new Error("Missing document id");
					const doc = this.documents.get(id);
					if (!doc) throw new Error("Document not found");
					return { content: doc };
				},
				upsert: async (id: string, content: unknown) => {
					if (!id || !content) throw new Error("Missing parameters for upsert");
					let parsedContent: unknown;
					try {
						parsedContent = typeof content === "string" ? JSON.parse(content) : content;
					} catch (_e) {
						throw new Error("Invalid JSON content");
					}
					this.documents.set(id, parsedContent);
					return { content: parsedContent };
				},
				remove: async (id: string) => {
					if (!id) throw new Error("Missing document id for remove");
					const doc = this.documents.get(id);
					if (!doc) throw new Error("Document not found");
					this.documents.delete(id);
					return { content: { id } };
				},
			}),
			query: async (query: string, options?: { parameters?: Record<string, unknown> }) => {
				this.scopeQueryCalls.push({ statement: query, options, scope: name });
				for (const stub of this.scopeQueryStubs) {
					if (stub.pattern.test(query)) {
						if (stub.error) throw stub.error;
						return { rows: stub.rows ?? [], meta: { mock: true } };
					}
				}
				const results = Array.from(this.documents.entries()).map(([id, content]) => ({
					id,
					...(content as Record<string, unknown>),
				}));
				return {
					rows: results,
					meta: { mock: true },
				};
			},
		};
	}

	collections() {
		return {
			getAllScopes: async () => [
				{
					name: "_default",
					collections: [{ name: "_default" }],
				},
			],
		};
	}
}

export class MockCluster implements Partial<Cluster> {
	bucketCalls: string[] = [];
	queryCalls: RecordedQuery[] = [];
	queryRows: unknown[] = [];
	allBuckets: Array<{ name: string; bucketType: string; ramQuotaMB: number; numReplicas: number }> = [
		{ name: "default", bucketType: "membase", ramQuotaMB: 100, numReplicas: 1 },
		{ name: "second-bucket", bucketType: "membase", ramQuotaMB: 100, numReplicas: 1 },
	];
	private bucketsByName: Map<string, MockBucket> = new Map();

	attachDefaultBucket(bucket: MockBucket): void {
		this.bucketsByName.set(bucket.name, bucket);
	}

	bucket(name: string) {
		this.bucketCalls.push(name);
		let existing = this.bucketsByName.get(name);
		if (!existing) {
			existing = new MockBucket(this, name);
			this.bucketsByName.set(name, existing);
		}
		return existing as unknown as Bucket;
	}

	buckets() {
		return {
			getAllBuckets: async () => this.allBuckets,
		};
	}

	async query(statement: string, options?: { parameters?: Record<string, unknown> }) {
		this.queryCalls.push({ statement, options });
		return { rows: this.queryRows, meta: { mock: true } };
	}

	async ping() {
		return { id: "mock-cluster-ping", services: { query: [{ state: "ok", latency_us: 250, remote: "mock:8093" }] } };
	}

	async close() {
		return;
	}
}

const sharedCluster = new MockCluster();

export const mockConnection = {
	cluster: sharedCluster as unknown as Cluster,
	defaultBucket: sharedCluster.bucket("default") as Bucket,
};

export const mockServer = {
	registeredTools: {} as Record<string, { schema: unknown; handler: ToolHandler }>,
	tool: (...args: unknown[]) => {
		let name: string;
		let schema: unknown;
		let handler: unknown;
		if (args.length === 4) {
			[name, , schema, handler] = args as [string, unknown, unknown, unknown];
		} else if (args.length === 3) {
			[name, schema, handler] = args as [string, unknown, unknown];
		} else {
			throw new Error("Invalid tool registration signature");
		}
		mockServer.registeredTools[name] = {
			schema,
			handler: typeof handler === "function" ? (handler as ToolHandler) : async () => undefined,
		};
		return mockServer;
	},
};
