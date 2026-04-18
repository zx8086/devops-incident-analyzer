// apps/web/src/lib/components/FollowUpSuggestions.test.ts
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import FollowUpSuggestions from "./FollowUpSuggestions.svelte";

describe("FollowUpSuggestions.svelte", () => {
	test("renders nothing when suggestions array is empty", () => {
		const { body } = render(FollowUpSuggestions, {
			props: { suggestions: [], onSelect: () => {} },
		});
		expect(body).not.toContain("Suggested follow-ups");
	});

	test("renders each suggestion as a button", () => {
		const suggestions = ["Check disk usage", "Restart the kafka broker"];
		const { body } = render(FollowUpSuggestions, {
			props: { suggestions, onSelect: () => {} },
		});
		expect(body).toContain("Suggested follow-ups");
		for (const s of suggestions) {
			expect(body).toContain(s);
		}
		const buttonCount = (body.match(/<button/g) ?? []).length;
		expect(buttonCount).toBe(suggestions.length);
	});
});
