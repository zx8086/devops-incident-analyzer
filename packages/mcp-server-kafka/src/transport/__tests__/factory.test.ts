// src/transport/__tests__/factory.test.ts
import { describe, expect, test } from "bun:test";
import { resolveTransportMode } from "../factory.ts";

describe("resolveTransportMode", () => {
  test("returns stdio for stdio mode", () => {
    expect(resolveTransportMode("stdio")).toEqual({ stdio: true, http: false });
  });

  test("returns http for http mode", () => {
    expect(resolveTransportMode("http")).toEqual({ stdio: false, http: true });
  });

  test("returns both for both mode", () => {
    expect(resolveTransportMode("both")).toEqual({ stdio: true, http: true });
  });
});
