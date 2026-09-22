// tests/suppression-manifest.test.ts
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MonitorState } from "../scripts/monitor/state.ts";
import { loadSuppressionManifest, selectForAccount } from "../scripts/monitor/suppression-manifest.ts";

const tmpDirs: string[] = [];
function writeManifest(body: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supp-manifest-"));
	tmpDirs.push(dir);
	const file = path.join(dir, "suppressions.yaml");
	fs.writeFileSync(file, body);
	return file;
}
afterEach(() => {
	while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

describe("loadSuppressionManifest", () => {
	test("parses entries and preserves the reason", () => {
		const file = writeManifest(`
suppressions:
  - pattern: "compliance:rule-x:eni-%"
    reason: "karpenter churn"
    accounts: ["eu-mendix-platform-prd"]
`);
		const res = loadSuppressionManifest(file);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("expected ok");
		expect(res.entries).toHaveLength(1);
		expect(res.entries[0]).toMatchObject({ pattern: "compliance:rule-x:eni-%", reason: "karpenter churn" });
	});

	test("a missing file is reported as missing, not as an empty manifest", () => {
		// The two must stay distinguishable: the caller leaves the ledger alone on
		// a read failure but WOULD remove every file row for a genuinely empty one.
		const res = loadSuppressionManifest(path.join(os.tmpdir(), "definitely-absent-manifest.yaml"));
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("expected failure");
		expect(res.reason).toBe("missing");
	});

	test("an empty file is a valid manifest with no entries", () => {
		const res = loadSuppressionManifest(writeManifest(""));
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error("expected ok");
		expect(res.entries).toEqual([]);
	});

	test("malformed YAML is reported as invalid rather than throwing", () => {
		const res = loadSuppressionManifest(writeManifest("suppressions: [unclosed\n"));
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("expected failure");
		expect(res.reason).toBe("invalid");
	});

	test("an entry without a reason is rejected", () => {
		// A suppression nobody can justify is how a ledger rots; the chat command
		// demands a reason and the file must not be a way around that.
		const res = loadSuppressionManifest(writeManifest(`suppressions:\n  - pattern: "compliance:x:%"\n`));
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("expected failure");
		expect(res.reason).toBe("invalid");
	});

	test("an empty pattern is rejected", () => {
		// "" as a LIKE pattern matches nothing, but a whitespace pattern reaching
		// the ledger would be an invisible no-op entry.
		const res = loadSuppressionManifest(writeManifest(`suppressions:\n  - pattern: "   "\n    reason: "oops"\n`));
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("expected failure");
		expect(res.reason).toBe("invalid");
	});
});

describe("selectForAccount", () => {
	const entries = [
		{ pattern: "everywhere:%", reason: "fleet-wide" },
		{ pattern: "mendix:%", reason: "scoped", accounts: ["eu-mendix-platform-prd"] },
	];

	test("an unscoped entry applies to every account", () => {
		expect(selectForAccount(entries, "eu-oit-dev").map((e) => e.pattern)).toEqual(["everywhere:%"]);
	});

	test("a scoped entry applies only to the named account", () => {
		expect(selectForAccount(entries, "eu-mendix-platform-prd").map((e) => e.pattern)).toEqual([
			"everywhere:%",
			"mendix:%",
		]);
	});

	test("a scoped entry never applies to a host with no account name", () => {
		// Falling through to "applies everywhere" would suppress on every account
		// that has not set PI_MONITOR_ACCOUNT_NAME -- the opposite of scoping.
		expect(selectForAccount(entries, undefined).map((e) => e.pattern)).toEqual(["everywhere:%"]);
	});
});

describe("reconcileFileSuppressions", () => {
	test("adds file entries and makes them match", () => {
		const state = new MonitorState(":memory:");
		const res = state.reconcileFileSuppressions([{ pattern: "compliance:rule-x:eni-%", reason: "churn" }]);
		expect(res.added).toEqual(["compliance:rule-x:eni-%"]);
		expect(state.matchSuppression("compliance:rule-x:eni-0abc")).toMatchObject({ reason: "churn" });
		state.close();
	});

	test("removing an entry from the file removes it from the ledger", () => {
		const state = new MonitorState(":memory:");
		state.reconcileFileSuppressions([{ pattern: "gone:%", reason: "temporary" }]);
		const res = state.reconcileFileSuppressions([]);
		expect(res.removed).toEqual(["gone:%"]);
		expect(state.matchSuppression("gone:anything")).toBeNull();
		state.close();
	});

	test("a chat-added entry survives reconcile", () => {
		// The failure mode that would make an operator stop trusting the ledger:
		// a suppression typed during an incident silently dropped by a restart.
		const state = new MonitorState(":memory:");
		state.addSuppression("alarm:flapping-%", "acked during incident");
		state.reconcileFileSuppressions([{ pattern: "file:%", reason: "from manifest" }]);
		expect(state.matchSuppression("alarm:flapping-cpu")).toMatchObject({ reason: "acked during incident" });
		const sources = Object.fromEntries(state.listSuppressions().map((r) => [r.pattern, r.source]));
		expect(sources).toEqual({ "alarm:flapping-%": "chat", "file:%": "file" });
		state.close();
	});

	test("an empty manifest removes file entries but still spares chat entries", () => {
		const state = new MonitorState(":memory:");
		state.addSuppression("chat:%", "by hand");
		state.reconcileFileSuppressions([{ pattern: "file:%", reason: "from manifest" }]);
		const res = state.reconcileFileSuppressions([]);
		expect(res.removed).toEqual(["file:%"]);
		expect(state.listSuppressions().map((r) => r.pattern)).toEqual(["chat:%"]);
		state.close();
	});

	test("a changed reason updates in place without re-adding", () => {
		const state = new MonitorState(":memory:");
		state.reconcileFileSuppressions([{ pattern: "p:%", reason: "first" }]);
		const res = state.reconcileFileSuppressions([{ pattern: "p:%", reason: "second" }]);
		expect(res.added).toEqual([]);
		expect(res.updated).toEqual(["p:%"]);
		expect(state.matchSuppression("p:x")).toMatchObject({ reason: "second" });
		state.close();
	});

	test("an unchanged manifest is a no-op", () => {
		// Reconcile runs on every monitor start; a restart loop must not churn the
		// ledger or reset created_at on entries the weekly review reports on.
		const state = new MonitorState(":memory:");
		const entries = [{ pattern: "p:%", reason: "stable" }];
		state.reconcileFileSuppressions(entries);
		const before = state.listSuppressions();
		const res = state.reconcileFileSuppressions(entries);
		expect(res).toEqual({ added: [], updated: [], removed: [] });
		expect(state.listSuppressions()).toEqual(before);
		state.close();
	});

	test("the manifest takes over a pattern an operator had added by chat", () => {
		const state = new MonitorState(":memory:");
		state.addSuppression("dup:%", "stop-gap");
		const res = state.reconcileFileSuppressions([{ pattern: "dup:%", reason: "reviewed" }]);
		expect(res.updated).toEqual(["dup:%"]);
		const row = state.listSuppressions().find((r) => r.pattern === "dup:%");
		expect(row).toMatchObject({ reason: "reviewed", source: "file" });
		// And it is now file-owned, so removing it from the manifest removes it.
		expect(state.reconcileFileSuppressions([]).removed).toEqual(["dup:%"]);
		state.close();
	});
});

describe("legacy schema migration", () => {
	// Every deployed spoke already has a suppressions table WITHOUT `source`, and
	// CREATE TABLE IF NOT EXISTS silently leaves it alone -- so the column has to
	// be added in place or the first query after a rollout throws and the monitor
	// dies on startup.
	function legacyDb(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supp-legacy-"));
		tmpDirs.push(dir);
		const file = path.join(dir, "state.db");
		const old = new Database(file, { create: true });
		old.exec("CREATE TABLE suppressions (pattern TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL);");
		old
			.query("INSERT INTO suppressions (pattern, reason, created_at) VALUES (?,?,?)")
			.run("alarm:legacy-%", "acked long ago", "2026-01-01T00:00:00.000Z");
		old.close();
		return file;
	}

	test("adds the column in place and backfills existing rows as chat", () => {
		const state = new MonitorState(legacyDb());
		const rows = state.listSuppressions();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			pattern: "alarm:legacy-%",
			reason: "acked long ago",
			// The operator typed it, so `chat` is not merely a default: it is true.
			source: "chat",
			created_at: "2026-01-01T00:00:00.000Z",
		});
		state.close();
	});

	test("a pre-existing row survives reconcile and still matches", () => {
		const file = legacyDb();
		const state = new MonitorState(file);
		state.reconcileFileSuppressions([{ pattern: "file:%", reason: "from manifest" }]);
		expect(state.matchSuppression("alarm:legacy-cpu")).toMatchObject({ reason: "acked long ago" });
		state.close();
	});

	test("reopening an already-migrated db is a no-op", () => {
		const file = legacyDb();
		new MonitorState(file).close();
		const state = new MonitorState(file);
		expect(state.listSuppressions()).toHaveLength(1);
		state.close();
	});
});

describe("the shipped manifest", () => {
	const shipped = path.resolve(import.meta.dir, "..", "deploy", "suppressions.yaml");

	test("parses and every entry carries a reason", () => {
		const res = loadSuppressionManifest(shipped);
		expect(res.ok).toBe(true);
		if (!res.ok) throw new Error(`shipped manifest does not load: ${res.reason} ${res.detail}`);
		for (const e of res.entries) expect(e.reason.length).toBeGreaterThan(0);
	});

	test("does not blanket-suppress required-tags by resource id", () => {
		// An earlier revision shipped `...:eni-%` and `...:i-%` patterns here. They
		// also hid the stable AWS-managed NAT/TGW/ELB/EKS-control-plane interfaces,
		// because a dedup_key cannot distinguish those from a churned one. Ownership
		// tags do that job now (churn-tags.ts), so re-adding an id-prefix pattern
		// would silently re-break it -- this test is what would notice.
		const res = loadSuppressionManifest(shipped);
		if (!res.ok) throw new Error(`shipped manifest does not load: ${res.reason} ${res.detail}`);
		const state = new MonitorState(":memory:");
		state.reconcileFileSuppressions(selectForAccount(res.entries, "eu-mendix-platform-prd"));
		const R = "OrgConfigRule-required-tags-lf3sbwf9";
		for (const key of [
			// The live EKS control-plane ENI, in the 2026-09-21 digest and still alive.
			`compliance:${R}:eni-03003d12a5aa90195`,
			`compliance:${R}:eni-06b85a5aa15ac783b`,
			`compliance:${R}:batch`,
			`compliance:${R}:vol-008aa8f32001006f5`,
			"compliance:securityhub-ec2-instance-multiple-eni-check-dd68747e:i-017d79a08476a6258",
			"drift:i-041d9a5923d4351a3:new",
		]) {
			expect(state.matchSuppression(key)).toBeNull();
		}
		state.close();
	});
});
