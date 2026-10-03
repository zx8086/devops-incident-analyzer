// tests/unit/notification-fixes.test.ts

import { describe, expect, test } from "bun:test";
import { NotificationManager } from "../../src/utils/notifications.js";

describe("NotificationManager fixes", () => {
	test("progress and message notifications resolve without a client to send to", async () => {
		const manager = new NotificationManager();

		await expect(manager.sendProgress({ progressToken: "test", progress: 10, total: 100 })).resolves.toBeUndefined();
		await expect(manager.sendMessage({ level: "info", data: { message: "test" } })).resolves.toBeUndefined();
	});

	test("should create operation trackers correctly", async () => {
		const manager = new NotificationManager();
		const operationId = NotificationManager.generateOperationId("test");
		const progressToken = NotificationManager.generateProgressToken(operationId);

		expect(operationId).toMatch(/^test-\d+-[a-z0-9]+$/);
		expect(progressToken).toBe(`progress-${operationId}`);

		await manager.startOperation(operationId, progressToken, 100, "Test operation");

		expect(manager.getActiveOperationsCount()).toBe(1);
		expect(manager.getActiveOperationIds()).toContain(operationId);
	});
});
