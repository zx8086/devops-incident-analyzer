// agent/src/ticket-providers/registry.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import {
	__resetTicketProvidersForTest,
	__setTicketProviderForTest,
	getTicketProvider,
	listAvailableTicketProviders,
} from "./index.ts";
import type { TicketProvider } from "./types.ts";

afterEach(() => {
	__resetTicketProvidersForTest();
});

function stubProvider(available: boolean): TicketProvider {
	return {
		id: "jira",
		label: "Jira",
		isAvailable: () => available,
		listProjects: () => Promise.resolve([]),
		searchAssignees: () => Promise.resolve([]),
		listIssueTypes: () => Promise.resolve([]),
		listEpics: () => Promise.resolve([]),
		createTicket: () => Promise.resolve({ key: "X-1" }),
	};
}

describe("getTicketProvider", () => {
	test("returns undefined for unknown provider ids", () => {
		expect(getTicketProvider("linear")).toBeUndefined();
		expect(getTicketProvider("")).toBeUndefined();
	});

	test("memoizes the instance per provider id", () => {
		expect(getTicketProvider("jira")).toBe(getTicketProvider("jira") as TicketProvider);
	});
});

describe("listAvailableTicketProviders", () => {
	// The unavailable case is asserted via an injected stub (not the ambient
	// bridge) because sibling test files mock.module the mcp-bridge namespace
	// and packages/agent runs unisolated (SIO-1045).
	test("lists providers whose isAvailable() is true", () => {
		__setTicketProviderForTest("jira", stubProvider(true));
		expect(listAvailableTicketProviders()).toEqual([{ id: "jira", label: "Jira" }]);
	});

	test("filters providers whose isAvailable() is false", () => {
		__setTicketProviderForTest("jira", stubProvider(false));
		expect(listAvailableTicketProviders()).toEqual([]);
	});
});
