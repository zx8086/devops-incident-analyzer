// packages/agent/src/eval/example-ticket-filter.test.ts
import { describe, expect, test } from "bun:test";
import { filterExamplesByTicket } from "./example-ticket-filter.ts";

const examples = [
	{ metadata: { ticketKey: "DEVOPS-1386", era: "2026-07" } },
	{ metadata: { ticketKey: "DEVOPS-1354" } },
	{ metadata: { ticketKey: "DEVOPS-1386" } },
	{ metadata: {} },
	{},
	{ metadata: { ticketKey: 42 } },
];

describe("SIO-1454: filterExamplesByTicket", () => {
	test("matches every example carrying the requested ticketKey", () => {
		const { matched } = filterExamplesByTicket(examples, "DEVOPS-1386");
		expect(matched).toHaveLength(2);
		expect(matched.every((e) => e.metadata?.ticketKey === "DEVOPS-1386")).toBe(true);
	});

	test("no match returns empty matched plus the sorted unique known keys for the error message", () => {
		const { matched, availableTicketKeys } = filterExamplesByTicket(examples, "DEVOPS-9999");
		expect(matched).toHaveLength(0);
		expect(availableTicketKeys).toEqual(["DEVOPS-1354", "DEVOPS-1386"]);
	});

	test("absent or non-string ticketKey metadata never matches and never pollutes the known keys", () => {
		// strict equality: the numeric 42 must not match the string "42"
		const { matched, availableTicketKeys } = filterExamplesByTicket(examples, "42");
		expect(matched).toHaveLength(0);
		expect(availableTicketKeys).toEqual(["DEVOPS-1354", "DEVOPS-1386"]);
	});
});
