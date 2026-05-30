// tests/pagination-marker.test.ts
// SIO-839: when Kong caps a list page, the operation emits a shared-shaped
// ListTruncationMarker in metadata.truncation (signalling only -- no data dropped).
import { describe, expect, mock, test } from "bun:test";
import { ListTruncationMarkerSchema } from "@devops-agent/shared";
import type { KongApi } from "../src/api/kong-api.js";
import { listServices } from "../src/tools/configuration/operations.js";
import { listControlPlanes } from "../src/tools/control-planes/operations.js";

const CP = "cp-123";

// A capped page: Kong returns exactly 100 rows when the caller requested more.
const cappedRows = Array.from({ length: 100 }, (_, i) => ({ id: `svc-${i}`, name: `s${i}` }));

describe("Kong truncation marker (SIO-839)", () => {
	test("offset-based listServices emits a marker with the offset as cursor when capped", async () => {
		const api = {
			listServices: mock(() => Promise.resolve({ data: cappedRows, offset: "next-off", total: 250 })),
		} as unknown as KongApi;

		const res = (await listServices(api, CP, 200)) as {
			metadata: { capped: boolean; truncation?: unknown };
		};

		expect(res.metadata.capped).toBe(true);
		const marker = ListTruncationMarkerSchema.parse(res.metadata.truncation);
		expect(marker.shown).toBe(100);
		expect(marker.total).toBe(250);
		expect(marker.cursor).toBe("next-off");
		expect(marker.advice).toContain("Kong");
	});

	test("no marker when the page is not capped", async () => {
		const api = {
			listServices: mock(() => Promise.resolve({ data: cappedRows.slice(0, 10), offset: undefined, total: 10 })),
		} as unknown as KongApi;

		const res = (await listServices(api, CP, 200)) as { metadata: { capped: boolean; truncation?: unknown } };
		expect(res.metadata.capped).toBe(false);
		expect(res.metadata.truncation).toBeUndefined();
	});

	test("page-number listControlPlanes emits a marker with NO cursor (uses pageNumber)", async () => {
		const api = {
			listControlPlanes: mock(() => Promise.resolve({ data: cappedRows, meta: { page_count: 3, total_count: 250 } })),
		} as unknown as KongApi;

		const res = (await listControlPlanes(api, 200)) as {
			metadata: { capped: boolean; truncation?: unknown };
		};

		expect(res.metadata.capped).toBe(true);
		const marker = ListTruncationMarkerSchema.parse(res.metadata.truncation);
		expect(marker.shown).toBe(100);
		expect(marker.total).toBe(250);
		// Page-number pagination has no opaque cursor.
		expect(marker.cursor).toBeUndefined();
		expect(marker.advice).toContain("pageNumber");
	});
});
