// tests/mailstore.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ComsMessage, MailStore } from "../scripts/coms-net-server.ts";

const tmpDirs: string[] = [];
afterAll(() => {
	for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDb(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailstore-"));
	tmpDirs.push(dir);
	return path.join(dir, "messages.db");
}

function msg(over: Partial<ComsMessage> = {}): ComsMessage {
	return {
		msg_id: over.msg_id ?? crypto.randomUUID(),
		project: "default",
		sender_session: "S1",
		sender_name: "monitor",
		sender_cwd: "/tmp",
		target_session: null,
		target_name: "laptop",
		prompt: "hello",
		conversation_id: null,
		response_schema: null,
		hops: 0,
		status: "queued",
		mailbox: true,
		response: null,
		error: null,
		created_at: new Date().toISOString(),
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		...over,
	};
}

describe("MailStore", () => {
	// SIO-1738: the mailbox delete used to require a terminal status a one-way
	// report never reaches, so reports accumulated forever -- 616 unpurgeable
	// rows on the prd hub. Expiry alone is the rule for mailbox mail.
	test("purgeExpired deletes an expired one-way report regardless of status", () => {
		const store = new MailStore(tmpDb());
		const expired = msg({
			status: "stored",
			mailbox: true,
			expires_at: new Date(Date.now() - 60_000).toISOString(),
		});
		const live = msg({ status: "stored", mailbox: true });
		store.upsert(expired);
		store.upsert(live);
		store.purgeExpired();
		const ids = store.inbox("laptop", 50).map((m) => m.msg_id);
		expect(ids).not.toContain(expired.msg_id);
		expect(ids).toContain(live.msg_id);
	});

	// A request-reply message must NOT be swept on expiry alone: it is retained
	// retainMs past completion, and a non-terminal one belongs to the live sweep.
	test("purgeExpired leaves request-reply mail to its own retention rule", () => {
		const store = new MailStore(tmpDb());
		const pending = msg({
			status: "queued",
			mailbox: false,
			expires_at: new Date(Date.now() - 60_000).toISOString(),
		});
		store.upsert(pending);
		store.purgeExpired();
		expect(store.loadNonTerminal().map((m) => m.msg_id)).toContain(pending.msg_id);
	});

	// Rows written before `stored` existed carry queued/delivered; both are
	// non-terminal, so they were never purgeable. Reopening the store migrates.
	test("opening a store migrates legacy one-way rows to stored", () => {
		const dbPath = tmpDb();
		const a = new MailStore(dbPath);
		const legacy = msg({ status: "queued", mailbox: true });
		a.upsert(legacy);
		a.close();
		const b = new MailStore(dbPath);
		const row = b.inbox("laptop", 50).find((m) => m.msg_id === legacy.msg_id);
		expect(row?.status).toBe("stored");
		// Request-reply rows are untouched by the migration.
		expect(b.loadNonTerminal().every((m) => m.mailbox === false || m.status === "stored")).toBe(true);
	});

	test("upsert then loadNonTerminal round-trips queued mail", () => {
		const store = new MailStore(tmpDb());
		const m = msg();
		store.upsert(m);
		const loaded = store.loadNonTerminal();
		expect(loaded).toHaveLength(1);
		expect(loaded[0]).toEqual(m);
		store.close();
	});

	test("terminal statuses are not reloaded", () => {
		const store = new MailStore(tmpDb());
		store.upsert(msg({ msg_id: "A", status: "complete" }));
		store.upsert(msg({ msg_id: "B", status: "error" }));
		store.upsert(msg({ msg_id: "C", status: "timeout" }));
		store.upsert(msg({ msg_id: "D", status: "delivered" }));
		const ids = store.loadNonTerminal().map((m) => m.msg_id);
		expect(ids).toEqual(["D"]);
		store.close();
	});

	test("upsert replaces in place and remove deletes", () => {
		const store = new MailStore(tmpDb());
		const m = msg({ msg_id: "X" });
		store.upsert(m);
		store.upsert({ ...m, status: "delivered", target_session: "S2" });
		const loaded = store.loadNonTerminal();
		expect(loaded[0].status).toBe("delivered");
		expect(loaded[0].target_session).toBe("S2");
		store.remove("X");
		expect(store.loadNonTerminal()).toHaveLength(0);
		store.close();
	});

	test("persists across reopen (same file)", () => {
		const dbPath = tmpDb();
		const a = new MailStore(dbPath);
		// mailbox:false -- a request-reply message is what loadNonTerminal is for.
		// SIO-1738: the default fixture is one-way mail, which reopening migrates
		// to the terminal `stored`, so it is deliberately no longer non-terminal.
		a.upsert(msg({ msg_id: "P", mailbox: false }));
		a.close();
		const b = new MailStore(dbPath);
		expect(b.loadNonTerminal().map((m) => m.msg_id)).toEqual(["P"]);
		b.close();
	});
});
