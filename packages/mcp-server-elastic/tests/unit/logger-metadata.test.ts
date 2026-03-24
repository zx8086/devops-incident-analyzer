// tests/unit/logger-metadata.test.ts
import { describe, expect, test } from "bun:test";
import { createMcpLogger } from "@devops-agent/shared";

describe("Logger Integration", () => {
	test("createMcpLogger returns a logger with expected API", () => {
		const logger = createMcpLogger("elastic-mcp-server");

		expect(typeof logger.info).toBe("function");
		expect(typeof logger.error).toBe("function");
		expect(typeof logger.warn).toBe("function");
		expect(typeof logger.debug).toBe("function");
		expect(typeof logger.child).toBe("function");
		expect(typeof logger.flush).toBe("function");
	});

	test("child logger inherits parent API", () => {
		const logger = createMcpLogger("elastic-mcp-server");
		const child = logger.child({ component: "tools", requestId: "req-123" });

		expect(typeof child.info).toBe("function");
		expect(typeof child.error).toBe("function");
		expect(typeof child.child).toBe("function");
	});
});
