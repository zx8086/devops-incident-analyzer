// shared/src/__tests__/tool-annotations.test.ts
import { describe, expect, test } from "bun:test";
import { deriveToolAnnotations, looksReadOnlyByName } from "../tool-annotations.ts";

describe("deriveToolAnnotations", () => {
	test("returns undefined when no dimension is provided", () => {
		expect(deriveToolAnnotations("kafka_list_topics", {})).toBeUndefined();
	});

	test("a provided set is a complete classification: membership true, absence false", () => {
		const readOnly = new Set(["kafka_list_topics"]);
		expect(deriveToolAnnotations("kafka_list_topics", { readOnly })).toEqual({ readOnlyHint: true });
		expect(deriveToolAnnotations("kafka_delete_topic", { readOnly })).toEqual({ readOnlyHint: false });
	});

	test("omitted dimensions produce no hint key at all", () => {
		const annotations = deriveToolAnnotations("kafka_delete_topic", {
			destructive: new Set(["kafka_delete_topic"]),
		});
		expect(annotations).toEqual({ destructiveHint: true });
		expect(annotations).not.toHaveProperty("readOnlyHint");
		expect(annotations).not.toHaveProperty("idempotentHint");
	});

	test("dimensions compose", () => {
		const sets = {
			readOnly: new Set(["kafka_list_topics"]),
			destructive: new Set(["kafka_delete_topic"]),
			idempotent: new Set(["kafka_alter_topic_config"]),
		};
		expect(deriveToolAnnotations("kafka_delete_topic", sets)).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
		});
	});
});

describe("looksReadOnlyByName", () => {
	test("flags suffix-anchored read verbs", () => {
		expect(looksReadOnlyByName("kafka_list_topics")).toBe(true);
		expect(looksReadOnlyByName("capella_get_cluster_health")).toBe(true);
		expect(looksReadOnlyByName("konnect_describe_thing")).toBe(true);
	});

	test("conservative: no trailing segment, write verbs, and mid-word verbs do not match", () => {
		// no "_" after the verb -- deliberately unflagged
		expect(looksReadOnlyByName("capella_ping")).toBe(false);
		expect(looksReadOnlyByName("kafka_delete_topic")).toBe(false);
		expect(looksReadOnlyByName("kafka_create_topic")).toBe(false);
		// "budget" contains "get" mid-word; suffix anchoring must not match it
		expect(looksReadOnlyByName("acme_budget_report")).toBe(false);
	});
});
