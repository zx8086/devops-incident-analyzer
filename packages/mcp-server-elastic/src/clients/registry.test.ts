// src/clients/registry.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import type { Client } from "@elastic/elasticsearch";
import { runWithDeployment } from "./context.js";
import {
	configuredDefaultDeploymentId,
	createClientProxy,
	DeploymentUnavailableError,
	isDefaultReassigned,
	registerClients,
	shouldRejectImplicitOperation,
} from "./registry.js";

// A tagged fake; the registry never inspects the client's shape, only its identity.
const fakeClient = (id: string) => ({ __id: id }) as unknown as Client;

function proxyId(): string {
	// createClientProxy returns a Proxy<Client>; reading a property resolves the underlying client.
	return (createClientProxy() as unknown as { __id: string }).__id;
}

describe("registry fail-closed routing", () => {
	afterEach(() => {
		// Reset module state between tests by re-registering a trivial healthy registry.
		registerClients(new Map([["reset", fakeClient("reset")]]), "reset");
	});

	test("explicit available deployment resolves to that client", () => {
		const clients = new Map([
			["eu-cld", fakeClient("eu-cld")],
			["us-cld", fakeClient("us-cld")],
		]);
		registerClients(clients, "eu-cld");
		expect(runWithDeployment("us-cld", proxyId)).toBe("us-cld");
	});

	test("no deployment selected + healthy default -> default (unchanged single-cluster path)", () => {
		registerClients(new Map([["eu-cld", fakeClient("eu-cld")]]), "eu-cld");
		expect(proxyId()).toBe("eu-cld");
	});

	// Issue 2: explicit unavailable/unknown id must fail closed, not silently hit the default.
	test("explicit UNAVAILABLE deployment id throws (never falls through to default)", () => {
		const clients = new Map([
			["us-cld", fakeClient("us-cld")], // eu-cld failed at startup, absent from the map
		]);
		registerClients(clients, "us-cld", "eu-cld"); // configured default eu-cld is gone
		expect(() => runWithDeployment("eu-cld", proxyId)).toThrow(DeploymentUnavailableError);
		expect(() => runWithDeployment("eu-cld", proxyId)).toThrow(/not available/);
	});

	// Issue 1 is enforced at the tool layer (assertion via isDefaultReassigned), NOT in
	// resolveClient -- boot-time infrastructure reads the proxy with no request context and must
	// not be rejected. Here we assert the registry EXPOSES the reassignment rather than throwing on
	// implicit reads, so a re-pointed default still lets boot proceed.
	test("no deployment selected + configured default re-pointed -> resolves to survivor (no throw)", () => {
		const clients = new Map([["us-cld", fakeClient("us-cld")]]);
		registerClients(clients, "us-cld", "eu-cld"); // default re-pointed eu-cld -> us-cld
		expect(proxyId()).toBe("us-cld"); // implicit read still works (boot safety)
		expect(isDefaultReassigned()).toBe(true); // but the reassignment is observable for the tool gate
		expect(configuredDefaultDeploymentId()).toBe("eu-cld");
	});

	test("default NOT re-pointed -> isDefaultReassigned() is false", () => {
		const clients = new Map([
			["eu-cld", fakeClient("eu-cld")],
			["us-cld", fakeClient("us-cld")],
		]);
		registerClients(clients, "eu-cld");
		expect(isDefaultReassigned()).toBe(false);
	});

	test("no deployment selected + default NOT re-pointed -> resolves normally", () => {
		const clients = new Map([
			["eu-cld", fakeClient("eu-cld")],
			["us-cld", fakeClient("us-cld")],
		]);
		// configuredDefaultId omitted -> equals defaultId -> healthy, no throw
		registerClients(clients, "eu-cld");
		expect(proxyId()).toBe("eu-cld");
	});

	// Greptile follow-up on 12e53295: the tool-layer implicit-op gate must honor an
	// x-elastic-deployment header that selects a CONNECTED deployment, even after a re-point.
	describe("shouldRejectImplicitOperation", () => {
		test("default healthy -> never rejects (regardless of header)", () => {
			registerClients(new Map([["eu-cld", fakeClient("eu-cld")]]), "eu-cld");
			expect(shouldRejectImplicitOperation(undefined)).toBe(false);
			expect(shouldRejectImplicitOperation("eu-cld")).toBe(false);
		});

		test("default re-pointed + no header -> rejects (truly implicit)", () => {
			registerClients(new Map([["us-cld", fakeClient("us-cld")]]), "us-cld", "eu-cld");
			expect(shouldRejectImplicitOperation(undefined)).toBe(true);
		});

		test("default re-pointed + header selects a CONNECTED deployment -> does NOT reject", () => {
			registerClients(
				new Map([
					["us-cld", fakeClient("us-cld")],
					["eu-b2b", fakeClient("eu-b2b")],
				]),
				"us-cld",
				"eu-cld",
			);
			expect(shouldRejectImplicitOperation("us-cld")).toBe(false);
			expect(shouldRejectImplicitOperation("eu-b2b")).toBe(false);
		});

		test("default re-pointed + header names an UNAVAILABLE deployment -> rejects", () => {
			registerClients(new Map([["us-cld", fakeClient("us-cld")]]), "us-cld", "eu-cld");
			expect(shouldRejectImplicitOperation("eu-cld")).toBe(true); // eu-cld is the dead default
		});
	});
});
