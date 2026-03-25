/* tests/errorHandling.test.ts */

import { afterAll, beforeAll, describe } from "bun:test";
import { logger } from "../src/lib/logger";
import toolRegistry from "../src/tools";
import { mockConnection, mockServer } from "./test.utils";

describe("Error Handling Tests", () => {
	const TEST_DOC_ID = "error_handling_test_doc";

	beforeAll(async () => {
		Object.values(toolRegistry).forEach((registerTool) => {
			registerTool(mockServer as any, mockConnection.defaultBucket);
		});
	});

	afterAll(async () => {
		if (mockConnection.defaultBucket) {
			const collection = mockConnection.defaultBucket.scope("_default").collection("_default");
			try {
				await collection.remove(TEST_DOC_ID);
			} catch (_error) {
				logger.info(`No test document to clean up: ${TEST_DOC_ID}`);
			}
			if (mockConnection.cluster) {
				await mockConnection.cluster.close();
			}
		}
	});

	// ... rest of the tests ...
});
