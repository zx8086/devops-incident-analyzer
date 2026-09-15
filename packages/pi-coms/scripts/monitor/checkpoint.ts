// scripts/monitor/checkpoint.ts

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";

// The tables whose loss is unrecoverable (SIO-1745). Counted into the manifest
// so a restore can be checked for plausibility, not just integrity: a checksum
// proves the bytes arrived, these prove the bytes are worth restoring.
export const TRACKED_TABLES = [
	"watermarks",
	"fingerprints",
	"snapshots",
	"costs",
	"journal",
	"unsent",
	"suppressions",
] as const;

export interface CheckpointManifest {
	schema: 1;
	written_at: string;
	account_id: string;
	agent: string;
	sha256: string;
	bytes: number;
	rows: Record<string, number>;
	// The db object this manifest describes. Content-addressed, so a manifest
	// and its db can never disagree: a failed manifest upload leaves the OLD
	// manifest still pointing at its own (untouched) db, instead of at bytes
	// that have since been overwritten.
	db_key: string;
}

export function manifestKey(prefix: string): string {
	return `${prefix}/manifest.json`;
}
// Content-addressed: the sha is in the key, so each checkpoint writes a new
// object rather than overwriting the one the current manifest points at.
//
// Bodies live under a single top-level `checkpoint-db/` prefix rather than
// beside the manifest. S3 lifecycle filters are literal prefixes with no
// wildcards, so they cannot express `state/*/*/db/`; keeping bodies in their
// own top-level prefix lets the expiry rule reach every spoke's superseded
// bodies while never touching a live manifest.json.
export function dbKey(prefix: string, sha256: string): string {
	const { bucket, key } = parseS3Uri(`${prefix}/x`);
	const scope = key.replace(/\/x$/, "");
	return `s3://${bucket}/checkpoint-db/${scope.replace(/^state\//, "")}/${sha256}.db`;
}

// s3://bucket/fleet -> s3://bucket/state/<account>/<agent>. Derived from the
// bundle URI the host already has, so no new variable reaches the userdata --
// which would replace the instance, the very event this guards against.
export function statePrefix(bundleS3Uri: string, accountId: string, agent: string): string {
	const trimmed = bundleS3Uri.replace(/\/+$/, "");
	const bucket = trimmed.replace(/^s3:\/\//, "").split("/")[0];
	if (!bucket) throw new Error(`cannot derive state prefix from bundle uri: ${bundleS3Uri}`);
	return `s3://${bucket}/state/${accountId}/${agent}`;
}

export function sha256File(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function countRows(db: Database, tables: readonly string[] = TRACKED_TABLES): Record<string, number> {
	const rows: Record<string, number> = {};
	for (const t of tables) {
		// Table names are the module constant above, never caller input.
		const r = db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number } | null;
		rows[t] = r ? Number(r.n) : 0;
	}
	return rows;
}

// VACUUM INTO, never a file copy: the db runs in WAL mode, so state.db on disk
// is missing whatever is still in the -wal file. A cp would checkpoint a
// torn, older database and silently lose the most recent findings.
export function snapshotTo(db: Database, dest: string): void {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.rmSync(dest, { force: true });
	db.query("VACUUM INTO ?").run(dest);
}

export function buildManifest(
	dbFile: string,
	rows: Record<string, number>,
	meta: { accountId: string; agent: string; prefix: string; now?: Date },
): CheckpointManifest {
	const sha256 = sha256File(dbFile);
	return {
		schema: 1,
		written_at: (meta.now ?? new Date()).toISOString(),
		account_id: meta.accountId,
		agent: meta.agent,
		sha256,
		bytes: fs.statSync(dbFile).size,
		rows,
		db_key: dbKey(meta.prefix, sha256),
	};
}

export type ManifestCheck = { ok: true; manifest: CheckpointManifest } | { ok: false; reason: string };

// An unreadable manifest blocks the restore rather than falling back to blank:
// starting empty looks identical to a healthy first boot, and that is exactly
// the failure that would go unnoticed for weeks.
export function parseManifest(text: string): ManifestCheck {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, reason: "manifest is not valid JSON" };
	}
	if (typeof raw !== "object" || raw === null) return { ok: false, reason: "manifest is not an object" };
	const m = raw as Partial<CheckpointManifest>;
	if (m.schema !== 1) return { ok: false, reason: `unsupported manifest schema: ${String(m.schema)}` };
	if (typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)) {
		return { ok: false, reason: "manifest sha256 missing or malformed" };
	}
	if (typeof m.bytes !== "number" || m.bytes <= 0) return { ok: false, reason: "manifest bytes missing or zero" };
	if (typeof m.rows !== "object" || m.rows === null) return { ok: false, reason: "manifest rows missing" };
	if (typeof m.db_key !== "string" || !m.db_key) return { ok: false, reason: "manifest db_key missing" };
	return { ok: true, manifest: m as CheckpointManifest };
}

export function verifyDownload(
	dbFile: string,
	manifest: CheckpointManifest,
): { ok: true } | { ok: false; reason: string } {
	const size = fs.statSync(dbFile).size;
	if (size !== manifest.bytes)
		return { ok: false, reason: `size mismatch: got ${size}, manifest says ${manifest.bytes}` };
	const sum = sha256File(dbFile);
	if (sum !== manifest.sha256)
		return { ok: false, reason: `sha256 mismatch: got ${sum}, manifest says ${manifest.sha256}` };
	return { ok: true };
}

export function defaultStageDir(): string {
	return path.join(os.tmpdir(), "pi-monitor-checkpoint");
}

// ── S3 transport ───────────────────────────────────────────────────────────

export interface ObjectStore {
	put(key: string, body: Uint8Array, contentType: string): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
}

export function parseS3Uri(uri: string): { bucket: string; key: string } {
	const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
	if (!m) throw new Error(`not an s3 uri: ${uri}`);
	return { bucket: m[1], key: m[2] };
}

// ── Save / restore ─────────────────────────────────────────────────────────

export type SaveResult = { ok: true; rows: Record<string, number>; bytes: number } | { ok: false; reason: string };

// Best-effort by contract: a failed checkpoint is logged and swallowed by the
// caller. Losing a backup must never take the monitor down with it -- the same
// soft-fail rule the KG writes follow.
export async function saveCheckpoint(
	db: Database,
	store: ObjectStore,
	prefix: string,
	meta: { accountId: string; agent: string; stageDir?: string; now?: Date },
): Promise<SaveResult> {
	// Per-invocation staging file: the scheduled, manual and shutdown triggers
	// are not serialized, and a shared path let one invocation rmSync the file
	// another was still hashing -- worst at shutdown, exactly when the terminal
	// checkpoint matters most.
	const stage = path.join(meta.stageDir ?? defaultStageDir(), `state-${process.pid}-${randomUUID()}.db`);
	try {
		snapshotTo(db, stage);
		const rows = countRows(db);
		const manifest = buildManifest(stage, rows, { ...meta, prefix });
		// db first, manifest second: the manifest is the commit point, so a
		// crash between the two leaves the previous (valid) pair addressable
		// rather than a manifest pointing at a half-written db.
		await store.put(manifest.db_key, fs.readFileSync(stage), "application/x-sqlite3");
		await store.put(manifestKey(prefix), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), "application/json");
		return { ok: true, rows, bytes: manifest.bytes };
	} catch (e) {
		return { ok: false, reason: e instanceof Error ? e.message : String(e) };
	} finally {
		fs.rmSync(stage, { force: true });
	}
}

export type RestoreResult =
	| { restored: true; manifest: CheckpointManifest }
	| { restored: false; reason: string; blocked: boolean };

// `blocked: true` means a checkpoint exists but could not be trusted. That is
// an alarm, not a clean start -- the caller must surface it instead of letting
// the monitor come up blank and look healthy.
export async function restoreCheckpoint(store: ObjectStore, prefix: string, dbPath: string): Promise<RestoreResult> {
	if (fs.existsSync(dbPath)) {
		return { restored: false, reason: "state.db already present; refusing to restore over live data", blocked: false };
	}
	let manifestBytes: Uint8Array | null;
	try {
		manifestBytes = await store.get(manifestKey(prefix));
	} catch (e) {
		return {
			restored: false,
			reason: `manifest fetch failed: ${e instanceof Error ? e.message : String(e)}`,
			blocked: true,
		};
	}
	if (!manifestBytes) return { restored: false, reason: "no checkpoint found", blocked: false };

	const parsed = parseManifest(Buffer.from(manifestBytes).toString("utf8"));
	if (!parsed.ok) return { restored: false, reason: parsed.reason, blocked: true };

	let body: Uint8Array | null;
	try {
		body = await store.get(parsed.manifest.db_key);
	} catch (e) {
		return {
			restored: false,
			reason: `state.db fetch failed: ${e instanceof Error ? e.message : String(e)}`,
			blocked: true,
		};
	}
	if (!body) return { restored: false, reason: "manifest present but state.db missing", blocked: true };

	// Staged then renamed: a verify failure must never leave a partial file at
	// dbPath, which the next boot would treat as live data and refuse to replace.
	const tmp = `${dbPath}.restore`;
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	fs.writeFileSync(tmp, body);
	const verified = verifyDownload(tmp, parsed.manifest);
	if (!verified.ok) {
		fs.rmSync(tmp, { force: true });
		return { restored: false, reason: verified.reason, blocked: true };
	}
	fs.renameSync(tmp, dbPath);
	return { restored: true, manifest: parsed.manifest };
}

// Keys arrive as full s3:// uris from dbKey()/manifestKey(); the bucket is
// re-parsed per call so one store can never be pointed at another spoke's
// prefix by a caller that got the bucket wrong.
export function s3Store(client: S3Client): ObjectStore {
	return {
		async put(key, body, contentType) {
			const { bucket, key: k } = parseS3Uri(key);
			await client.send(new PutObjectCommand({ Bucket: bucket, Key: k, Body: body, ContentType: contentType }));
		},
		async get(key) {
			const { bucket, key: k } = parseS3Uri(key);
			try {
				const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: k }));
				if (!r.Body) return null;
				return await r.Body.transformToByteArray();
			} catch (e) {
				// A missing object is a clean "no checkpoint", not a failure; any
				// other error (denied, throttled, network) must propagate so the
				// restore blocks instead of silently starting blank.
				const name = (e as { name?: string }).name;
				if (name === "NoSuchKey" || name === "NotFound") return null;
				throw e;
			}
		},
	};
}
