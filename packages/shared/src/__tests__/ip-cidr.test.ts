// shared/src/__tests__/ip-cidr.test.ts
import { describe, expect, test } from "bun:test";
import { ipInCidr, parseIpv4 } from "../ip-cidr.ts";

describe("parseIpv4", () => {
	test("parses a plain address", () => {
		expect(parseIpv4("10.0.0.1")).toBe(10 * 256 ** 3 + 1);
	});

	test("parses the extremes", () => {
		expect(parseIpv4("0.0.0.0")).toBe(0);
		expect(parseIpv4("255.255.255.255")).toBe(0xffffffff);
	});

	test("rejects malformed input", () => {
		expect(parseIpv4("")).toBeNull();
		expect(parseIpv4("10.0.0")).toBeNull();
		expect(parseIpv4("10.0.0.0.1")).toBeNull();
		expect(parseIpv4("10.0.0.256")).toBeNull();
		expect(parseIpv4("10.0.0.-1")).toBeNull();
		expect(parseIpv4("10.0.0.+1")).toBeNull();
		expect(parseIpv4("10.0.0.1e1")).toBeNull();
		expect(parseIpv4("10.0.0. 1")).toBeNull();
		expect(parseIpv4("10.0.0.1000")).toBeNull();
		expect(parseIpv4("a.b.c.d")).toBeNull();
	});

	test("rejects IPv6", () => {
		expect(parseIpv4("::1")).toBeNull();
		expect(parseIpv4("2001:db8::1")).toBeNull();
	});
});

describe("ipInCidr", () => {
	test("membership inside a /16", () => {
		expect(ipInCidr("10.34.50.147", "10.34.0.0/16")).toBe(true);
		expect(ipInCidr("10.35.0.1", "10.34.0.0/16")).toBe(false);
	});

	test("/24 boundary addresses (network and broadcast are contained)", () => {
		expect(ipInCidr("10.1.1.0", "10.1.1.0/24")).toBe(true);
		expect(ipInCidr("10.1.1.255", "10.1.1.0/24")).toBe(true);
		expect(ipInCidr("10.1.2.0", "10.1.1.0/24")).toBe(false);
	});

	test("/32 matches only the exact address", () => {
		expect(ipInCidr("192.168.10.5", "192.168.10.5/32")).toBe(true);
		expect(ipInCidr("192.168.10.6", "192.168.10.5/32")).toBe(false);
	});

	test("/0 matches everything", () => {
		expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
		expect(ipInCidr("255.255.255.255", "0.0.0.0/0")).toBe(true);
	});

	test("high-bit networks stay unsigned (no sign-bit wraparound)", () => {
		expect(ipInCidr("192.168.10.14", "192.168.10.0/28")).toBe(true);
		expect(ipInCidr("192.168.10.16", "192.168.10.0/28")).toBe(false);
		expect(ipInCidr("240.0.0.1", "240.0.0.0/4")).toBe(true);
	});

	test("malformed inputs return false, never throw", () => {
		expect(ipInCidr("", "10.0.0.0/8")).toBe(false);
		expect(ipInCidr("10.0.0.1", "")).toBe(false);
		expect(ipInCidr("10.0.0.1", "10.0.0.0")).toBe(false);
		expect(ipInCidr("10.0.0.1", "10.0.0.0/33")).toBe(false);
		expect(ipInCidr("10.0.0.1", "10.0.0.0/-1")).toBe(false);
		expect(ipInCidr("10.0.0.1", "10.0.0.0/ 8")).toBe(false);
		expect(ipInCidr("10.0.0.1", "/8")).toBe(false);
		expect(ipInCidr("10.0.0.256", "10.0.0.0/8")).toBe(false);
		expect(ipInCidr("2001:db8::1", "10.0.0.0/8")).toBe(false);
		expect(ipInCidr("10.0.0.1", "2001:db8::/32")).toBe(false);
	});
});
