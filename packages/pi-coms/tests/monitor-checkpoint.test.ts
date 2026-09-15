// tests/monitor-checkpoint.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildManifest,
	countRows,
	dbKey,
	manifestKey,
	type ObjectStore,
	parseManifest,
	parseS3Uri,
	restoreCheckpoint,
	saveCheckpoint,
	snapshotTo,
	statePrefix,
} from "../scripts/monitor/checkpoint.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

class FakeStore implements ObjectStore {
	objects = new Map<string, Uint8Array>();
	putCalls: string[] = [];
	failOn: string | null = null;
	async put(key: string, body: Uint8Array): Promise<void> {
		if (this.failOn === key) throw new Error(`denied: ${key}`);
		this.putCalls.push(key);
		this.objects.set(key, body);
	}
	async get(key: string): Promise<Uint8Array | null> {
		return this.objects.get(key) ?? null;
	}
}

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const META = { accountId: "111122223333", agent: "eu-oit-dev" };

function seeded(dbPath: string): MonitorState {
	const s = new MonitorState(dbPath);
	s.addSuppression("alarm:%-Utilization-Low-20%", "accepted dev rightsizing noise");
	s.journal("finding", { dedup_key: "alarm:db-cpu", diagnosis: { cause: "batch job" } });
	s.recordCost("2026-09-01", 42.5);
	s.setSnapshot("controls", { investigate: "off" });
	return s;
}

describe("statePrefix", () => {
	test("derives a per-account, per-agent prefix from the bundle uri", () => {
		expect(statePrefix("s3://pi-coms-dist-9999/fleet", "1234", "eu-oit-prd")).toBe(
			"s3://pi-coms-dist-9999/state/1234/eu-oit-prd",
		);
	});
	test("tolerates a trailing slash", () => {
		expect(statePrefix("s3://b/fleet/", "1", "a")).toBe("s3://b/state/1/a");
	});
	test("one spoke cannot address another's prefix", () => {
		expect(statePrefix("s3://b/fleet", "acctA", "a")).not.toBe(statePrefix("s3://b/fleet", "acctB", "a"));
	});
});

test("parseS3Uri splits bucket and key", () => {
	expect(parseS3Uri("s3://buck/state/1/a/state.db")).toEqual({ bucket: "buck", key: "state/1/a/state.db" });
	expect(() => parseS3Uri("https://buck/x")).toThrow();
});

describe("snapshotTo", () => {
	// The WAL guard: the reason this is VACUUM INTO and not a file copy.
	test("captures rows still sitting in the -wal file", () => {
		const live = path.join(dir, "live.db");
		const s = seeded(live);
		const snap = path.join(dir, "snap.db");
		s.withDb((db) => snapshotTo(db, snap));
		s.close();

		const restored = new MonitorState(snap);
		expect(restored.listSuppressions()).toHaveLength(1);
		expect(restored.costBaseline("2026-09-02", 14)).toBe(42.5);
		restored.close();
	});
});

describe("saveCheckpoint", () => {
	test("writes db then manifest, and the manifest carries row counts", async () => {
		const s = seeded(path.join(dir, "live.db"));
		const store = new FakeStore();
		const res = await s.withDb((db) =>
			saveCheckpoint(db, store, "s3://b/state/1/a", {
				...META,
				stageDir: dir,
			}),
		);
		s.close();

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.rows.suppressions).toBe(1);
		expect(res.rows.journal).toBe(1);
		// db before manifest: the manifest is the commit point.
		expect(store.putCalls).toEqual([dbKey("s3://b/state/1/a"), manifestKey("s3://b/state/1/a")]);
	});

	test("a put failure is reported, never thrown", async () => {
		const s = seeded(path.join(dir, "live.db"));
		const store = new FakeStore();
		store.failOn = dbKey("s3://b/p");
		const res = await s.withDb((db) => saveCheckpoint(db, store, "s3://b/p", { ...META, stageDir: dir }));
		s.close();
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.reason).toContain("denied");
	});

	test("leaves no staged file behind", async () => {
		const s = seeded(path.join(dir, "live.db"));
		const store = new FakeStore();
		await s.withDb((db) => saveCheckpoint(db, store, "s3://b/p", { ...META, stageDir: dir }));
		s.close();
		expect(fs.existsSync(path.join(dir, "state.db"))).toBe(false);
	});
});

describe("restoreCheckpoint", () => {
	const PREFIX = "s3://b/state/1/a";

	async function storeWithCheckpoint(): Promise<FakeStore> {
		const s = seeded(path.join(dir, "source.db"));
		const store = new FakeStore();
		await s.withDb((db) => saveCheckpoint(db, store, PREFIX, { ...META, stageDir: dir }));
		s.close();
		return store;
	}

	test("round-trips the unrecoverable tables", async () => {
		const store = await storeWithCheckpoint();
		const target = path.join(dir, "fresh", "state.db");

		const res = await restoreCheckpoint(store, PREFIX, target);
		expect(res.restored).toBe(true);

		const s = new MonitorState(target);
		expect(s.listSuppressions()[0].reason).toBe("accepted dev rightsizing noise");
		expect(s.priorDiagnosis("alarm:db-cpu", 86_400_000)).not.toBeNull();
		expect(s.getSnapshot("controls")).toEqual({ investigate: "off" });
		s.close();
	});

	test("refuses to restore over an existing db, and does not block", async () => {
		const store = await storeWithCheckpoint();
		const target = path.join(dir, "live.db");
		const s = new MonitorState(target);
		s.close();

		const res = await restoreCheckpoint(store, PREFIX, target);
		expect(res.restored).toBe(false);
		if (res.restored) return;
		expect(res.blocked).toBe(false);
		expect(res.reason).toContain("refusing to restore over live data");
	});

	test("no checkpoint is a clean start, not a block", async () => {
		const res = await restoreCheckpoint(new FakeStore(), PREFIX, path.join(dir, "x.db"));
		expect(res.restored).toBe(false);
		if (res.restored) return;
		expect(res.blocked).toBe(false);
	});

	test("a corrupt manifest BLOCKS rather than starting blank", async () => {
		const store = await storeWithCheckpoint();
		store.objects.set(manifestKey(PREFIX), Buffer.from("{not json"));
		const target = path.join(dir, "fresh.db");

		const res = await restoreCheckpoint(store, PREFIX, target);
		expect(res.restored).toBe(false);
		if (res.restored) return;
		expect(res.blocked).toBe(true);
		expect(fs.existsSync(target)).toBe(false);
	});

	test("a checksum mismatch blocks and leaves no partial file", async () => {
		const store = await storeWithCheckpoint();
		store.objects.set(dbKey(PREFIX), Buffer.from("corrupted bytes"));
		const target = path.join(dir, "fresh.db");

		const res = await restoreCheckpoint(store, PREFIX, target);
		expect(res.restored).toBe(false);
		if (res.restored) return;
		expect(res.blocked).toBe(true);
		expect(fs.existsSync(target)).toBe(false);
		expect(fs.existsSync(`${target}.restore`)).toBe(false);
	});

	test("a manifest with no db blocks", async () => {
		const store = await storeWithCheckpoint();
		store.objects.delete(dbKey(PREFIX));
		const res = await restoreCheckpoint(store, PREFIX, path.join(dir, "fresh.db"));
		expect(res.restored).toBe(false);
		if (res.restored) return;
		expect(res.blocked).toBe(true);
	});
});

describe("parseManifest", () => {
	test("rejects a future schema", () => {
		const r = parseManifest(JSON.stringify({ schema: 2, sha256: "a".repeat(64), bytes: 1, rows: {} }));
		expect(r.ok).toBe(false);
	});
	test("rejects a malformed sha", () => {
		const r = parseManifest(JSON.stringify({ schema: 1, sha256: "nope", bytes: 1, rows: {} }));
		expect(r.ok).toBe(false);
	});
	test("rejects zero bytes", () => {
		const r = parseManifest(JSON.stringify({ schema: 1, sha256: "a".repeat(64), bytes: 0, rows: {} }));
		expect(r.ok).toBe(false);
	});
});

test("countRows and buildManifest agree on the tracked tables", () => {
	const s = seeded(path.join(dir, "m.db"));
	const snap = path.join(dir, "m-snap.db");
	s.withDb((db) => snapshotTo(db, snap));
	const rows = s.withDb((db) => countRows(db));
	const m = buildManifest(snap, rows, META);
	s.close();

	expect(Object.keys(m.rows).sort()).toEqual(
		["costs", "fingerprints", "journal", "snapshots", "suppressions", "unsent", "watermarks"].sort(),
	);
	expect(m.schema).toBe(1);
	expect(m.bytes).toBeGreaterThan(0);
	expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
});
