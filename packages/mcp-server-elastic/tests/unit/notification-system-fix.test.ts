/* tests/unit/notification-system-fix.test.ts */

import { describe, expect, it } from "bun:test";
import { NotificationManager, notificationManager } from "../../src/utils/notifications.js";

// SIO-1953: the manager is a process-global singleton, so it must hold no per-request state.
// The old setRequestContext/clearRequestContext pair let concurrent tool calls overwrite and
// clear each other's context; every notification path is now local logging only.
describe("Notification System Fix", () => {
	it("exposes no per-request context on the global manager", () => {
		const surface = notificationManager as unknown as Record<string, unknown>;
		expect(surface.setRequestContext).toBeUndefined();
		expect(surface.clearRequestContext).toBeUndefined();
		expect(surface.requestContext).toBeUndefined();
	});

	it("resolves progress, info, warning and error without any request context", async () => {
		const manager = new NotificationManager();
		await expect(manager.sendProgress({ progressToken: "t", progress: 50, total: 100 })).resolves.toBeUndefined();
		await expect(manager.sendInfo("info", { extra: "data" })).resolves.toBeUndefined();
		await expect(manager.sendWarning("warning", { severity: "medium" })).resolves.toBeUndefined();
		await expect(manager.sendError("failed", new Error("boom"), { operation: "test" })).resolves.toBeUndefined();
	});
});
