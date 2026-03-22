import { afterEach, describe, expect, test } from "bun:test";
import { getConfig, resetConfigCache } from "../config.ts";

describe("transport config", () => {
  afterEach(() => {
    resetConfigCache();
  });

  test("defaults to stdio transport", () => {
    const config = getConfig();
    expect(config.transport.mode).toBe("stdio");
  });

  test("defaults to port 3000", () => {
    const config = getConfig();
    expect(config.transport.port).toBe(3000);
  });

  test("defaults to localhost binding", () => {
    const config = getConfig();
    expect(config.transport.host).toBe("127.0.0.1");
  });

  test("defaults to /mcp path", () => {
    const config = getConfig();
    expect(config.transport.path).toBe("/mcp");
  });

  test("defaults to stateless session mode", () => {
    const config = getConfig();
    expect(config.transport.sessionMode).toBe("stateless");
  });

  test("defaults to 120s idle timeout", () => {
    const config = getConfig();
    expect(config.transport.idleTimeout).toBe(120);
  });
});
