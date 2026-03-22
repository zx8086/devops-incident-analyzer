/* tests/docsWrite.test.ts */

import * as fs from "fs/promises";
import { config } from "../src/config";

describe("Docs Directory Write Test", () => {
	const baseDirectory = config.documentation.baseDirectory || "./docs";
	const testFile = `${baseDirectory}/test-write.txt`;

	it("should be able to write and delete a file in the docs directory", async () => {
		// Ensure the directory exists
		await fs.mkdir(baseDirectory, { recursive: true });
		// Try to write a file
		await fs.writeFile(testFile, "MCP documentation write test");
		// Check that the file exists
		const content = await fs.readFile(testFile, "utf-8");
		expect(content).toBe("MCP documentation write test");
		// Clean up
		await fs.unlink(testFile);
	});
});
