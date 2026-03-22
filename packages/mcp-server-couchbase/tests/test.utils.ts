/* tests/test.utils.ts */

import type { Bucket, Cluster } from "couchbase";
import { testConfig } from "./test.config";

export class MockBucket implements Partial<Bucket> {
	private documents: Map<string, any> = new Map();

	scope(name: string) {
		return {
			collection: (collectionName: string) => ({
				get: async (id: string) => {
					if (!id) throw new Error("Missing document id");
					const doc = this.documents.get(id);
					if (!doc) throw new Error("Document not found");
					return { content: doc };
				},
				upsert: async (id: string, content: any) => {
					if (!id || !content) throw new Error("Missing parameters for upsert");
					let parsedContent;
					try {
						parsedContent = typeof content === "string" ? JSON.parse(content) : content;
					} catch (e) {
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
			query: async (query: string) => {
				const results = Array.from(this.documents.entries()).map(([id, content]) => ({
					id,
					...content,
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
	bucket(name: string) {
		return new MockBucket() as Bucket;
	}

	async close() {
		return;
	}
}

export const mockConnection = {
	cluster: new MockCluster() as Cluster,
	defaultBucket: new MockBucket() as Bucket,
};

export const mockServer = {
	registeredTools: {} as Record<string, { schema: any; handler: any }>,
	tool: (...args: any[]) => {
		let name, schema, handler;
		if (args.length === 4) {
			[name, , schema, handler] = args;
		} else if (args.length === 3) {
			[name, schema, handler] = args;
		} else {
			throw new Error("Invalid tool registration signature");
		}
		mockServer.registeredTools[name] = {
			schema,
			handler: typeof handler === "function" ? handler : undefined,
		};
		return mockServer;
	},
};
