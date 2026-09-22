// tests/fleet-config-drift.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	bootstrapPath,
	bootstrapWrittenKeys,
	classify,
	formatVerdict,
	loadBootstrapKeys,
	parseEnvKeys,
	parseRemoteRead,
	READ_LOCAL_ENV_COMMAND,
} from "../scripts/fleet/config-drift.ts";

// The keys the real bootstrap writes, read from the real file: the whole point
// is that this list is never a hard-coded copy (SIO-1747).
const REAL_KEYS = loadBootstrapKeys();

describe("bootstrapWrittenKeys (SIO-1747)", () => {
	test("derives the keys from the bootstrap source, not a duplicate list", () => {
		// These are the ones that actually drifted on prd.
		expect(REAL_KEYS).toContain("PI_MONITOR_TZ");
		expect(REAL_KEYS).toContain("PI_MONITOR_DAILY_CRON");
		// ...and a representative sample of the rest of the block.
		expect(REAL_KEYS).toContain("PI_COMS_NET_SERVER_URL");
		expect(REAL_KEYS).toContain("PI_MONITOR_NAME");
		expect(REAL_KEYS).toContain("BUNDLE_S3_URI");
	});

	test("does NOT claim the per-host override keys", () => {
		// The bootstrap never writes these; they are the legitimate reason
		// .coms-env.local exists, and flagging them would invite deleting a
		// load-bearing file.
		expect(REAL_KEYS).not.toContain("CTX_MODE_ENABLED");
		expect(REAL_KEYS).not.toContain("PI_COMS_NET_MUTE_SENDERS");
		expect(REAL_KEYS).not.toContain("PI_COMS_NET_REFUSE_ABOVE_PCT");
	});

	// Greptile P2 on PR #780: an unanchored search also matched commented-out
	// and unrelated echoes, so a `# echo "export CTX_MODE_ENABLED=..."` would
	// make that key authoritative and report every host legitimately using it
	// as DRIFT -- inviting deletion of a load-bearing override file.
	test("ignores commented-out and out-of-block echoes", () => {
		const src = [
			'  echo "export DECOY_BEFORE=1"',
			"{",
			"  echo \"export PI_MONITOR_TZ='$MONITOR_TZ'\"",
			'  # echo "export CTX_MODE_ENABLED=false"',
			'} > "$ENV_FILE"',
			'  echo "export DECOY_AFTER=1"',
		].join("\n");
		expect(bootstrapWrittenKeys(src)).toEqual(["PI_MONITOR_TZ"]);
	});

	test("throws rather than guessing when the writer block is missing", () => {
		expect(() => bootstrapWrittenKeys('echo "export PI_MONITOR_TZ=x"')).toThrow(/ENV_FILE/);
	});

	test("reads only the env-file writer shape", () => {
		const src = [
			"{",
			"  echo \"export PI_MONITOR_TZ='$MONITOR_TZ'\"",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-1865 - shell parameter expansion in a bash fixture, not a JS template
			'  if [ -n "${X:-}" ]; then echo "export BUNDLE_S3_URI=\'$X\'"; fi',
			"  export NOT_THIS=1", // a plain shell export, not a written key
			"  # echo comment",
			'} > "$ENV_FILE"',
		].join("\n");
		expect(bootstrapWrittenKeys(src)).toEqual(["BUNDLE_S3_URI", "PI_MONITOR_TZ"]);
	});

	test("the real bootstrap file is where the ticket says it is", () => {
		expect(readFileSync(bootstrapPath(), "utf-8")).toContain("agent-bootstrap.sh");
	});
});

describe("parseEnvKeys", () => {
	test("handles export, bare assignment, comments and blanks", () => {
		const keys = parseEnvKeys(
			["# a comment", "", "export PI_MONITOR_TZ=Europe/Amsterdam", 'CTX_MODE_ENABLED="false"', "  "].join("\n"),
		);
		expect(keys).toEqual(["PI_MONITOR_TZ", "CTX_MODE_ENABLED"]);
	});

	test("never returns values, only names", () => {
		const keys = parseEnvKeys("export PI_COMS_NET_AUTH_TOKEN=super-secret-value");
		expect(keys).toEqual(["PI_COMS_NET_AUTH_TOKEN"]);
		expect(keys.join()).not.toContain("secret");
	});
});

describe("classify", () => {
	// Acceptance criterion: a host with PI_MONITOR_TZ in .coms-env.local is flagged.
	test("flags a bootstrap-written key", () => {
		const v = classify('export PI_MONITOR_TZ=Europe/Amsterdam\nexport PI_MONITOR_DAILY_CRON="15 8 * * *"', REAL_KEYS);
		expect(v.state).toBe("shadowed");
		if (v.state !== "shadowed") return;
		expect(v.shadowed).toEqual(["PI_MONITOR_TZ", "PI_MONITOR_DAILY_CRON"]);
	});

	// Acceptance criterion: a host with only CTX_MODE_ENABLED is NOT flagged.
	test("does not flag a legitimate per-host override", () => {
		const v = classify("export CTX_MODE_ENABLED=false", REAL_KEYS);
		expect(v.state).toBe("clean");
		if (v.state !== "clean") return;
		expect(v.reason).toBe("only per-host keys");
		expect(v.localKeys).toEqual(["CTX_MODE_ENABLED"]);
	});

	// Acceptance criterion: a host with no .coms-env.local is NOT flagged.
	test("no override file is clean", () => {
		const v = classify(null, REAL_KEYS);
		expect(v.state).toBe("clean");
		if (v.state !== "clean") return;
		expect(v.reason).toBe("no override file");
	});

	test("an empty file is clean but distinct from an absent one", () => {
		const empty = classify("", REAL_KEYS);
		expect(empty.state).toBe("clean");
		if (empty.state !== "clean") return;
		expect(empty.reason).toBe("only per-host keys");
	});

	test("a mixed file flags only the shadowing key", () => {
		const v = classify("export CTX_MODE_ENABLED=false\nexport PI_MONITOR_TZ=UTC", REAL_KEYS);
		expect(v.state).toBe("shadowed");
		if (v.state !== "shadowed") return;
		expect(v.shadowed).toEqual(["PI_MONITOR_TZ"]);
		expect(v.localKeys).toContain("CTX_MODE_ENABLED");
	});
});

describe("formatVerdict", () => {
	// Acceptance criterion: output names the keys, not just a count -- the
	// operator has to know whether the file is safe to delete.
	test("names the shadowed keys", () => {
		const line = formatVerdict("eu-oit-prd", classify("export PI_MONITOR_TZ=UTC", REAL_KEYS));
		expect(line).toContain("DRIFT");
		expect(line).toContain("PI_MONITOR_TZ");
		expect(line).toContain("eu-oit-prd");
	});

	test("a clean host reports ok and lists any per-host keys", () => {
		expect(formatVerdict("eu-oit-dev", classify(null, REAL_KEYS))).toContain("ok");
		expect(formatVerdict("eu-oit-dev", classify("export CTX_MODE_ENABLED=false", REAL_KEYS))).toContain(
			"per-host: CTX_MODE_ENABLED",
		);
	});
});

describe("parseRemoteRead", () => {
	test("the sentinel means absent, not empty", () => {
		expect(parseRemoteRead("__NO_LOCAL_ENV__\n")).toBeNull();
		expect(parseRemoteRead("")).toBe("");
		expect(parseRemoteRead("export CTX_MODE_ENABLED=false\n")).toBe("export CTX_MODE_ENABLED=false\n");
	});
});

// The live fleet as of 2026-09-15: every spoke takes its tz from .coms-env and
// no host carries an override at all. This is the regression that would have
// caught the SIO-1746 drift a week earlier.
test("end to end: the shape SIO-1746 found on five prd spokes is flagged", () => {
	const asFoundOnProd = 'export PI_MONITOR_TZ=Europe/Amsterdam\nexport PI_MONITOR_DAILY_CRON="15 8 * * *"\n';
	const line = formatVerdict("eu-shared-services-prd", classify(asFoundOnProd, REAL_KEYS));
	expect(line).toMatch(/DRIFT 2 key\(s\) shadowed/);
	expect(line).toContain("PI_MONITOR_TZ, PI_MONITOR_DAILY_CRON");
});

// Greptile P1 on PR #780: `cat`-ing the 0600 override file put its VALUES into
// SSM's StandardOutputContent, which anyone with ssm:GetCommandInvocation can
// read back later -- proven against a live host with a canary value. The host
// now emits key names only.
describe("READ_LOCAL_ENV_COMMAND (SIO-1747 P1)", () => {
	test("never cats the file; emits KEY= names only", () => {
		const script = READ_LOCAL_ENV_COMMAND.join(" ; ");
		expect(script).not.toMatch(/\bcat\b/);
		expect(script).toContain("sed");
		// The sed replacement keeps `\2=` -- the key with an empty value.
		expect(script).toContain("\\2=");
	});

	test("still distinguishes an absent file", () => {
		expect(READ_LOCAL_ENV_COMMAND.join(" ; ")).toContain("__NO_LOCAL_ENV__");
	});

	test("parseEnvKeys reads the value-stripped shape the host emits", () => {
		// What the sed produces for `export PI_MONITOR_TZ=Europe/Amsterdam`.
		expect(parseEnvKeys("PI_MONITOR_TZ=\nCTX_MODE_ENABLED=\n")).toEqual(["PI_MONITOR_TZ", "CTX_MODE_ENABLED"]);
	});
});
