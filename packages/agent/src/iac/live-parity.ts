// agent/src/iac/live-parity.ts
// SIO-983: live-parity validation for the GitOps maker lane. The proposer drafts a repo JSON file
// (flat custom DSL) but never checks it against the LIVE cluster, so a stale repo source (e.g. an
// ILM policy that has drifted from live) is copied forward and the reviewer cannot see it. These
// pure helpers normalise the live ES ILM API shape into the repo flat DSL and diff the draft against
// it, producing a non-blocking advisory surfaced on the plan-review card. Shape verified live
// against the elastic MCP (2026-06-20): the elastic-iac MCP's elastic_ilm_get_lifecycle returns
// "[<status>] <raw ES JSON>" where the raw ES _ilm/policy API nests every setting under
// policy.phases.<phase>.actions.<action>.<field>.

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export interface EsIlmPolicy {
	phases: Record<string, { min_age?: string; actions?: Json } | undefined>;
}

// Parse the elastic-iac MCP's "[<status>] <body>" ILM response. Returns the inner ES policy object
// ({ phases }) on a 2xx with a single-policy envelope, or null for any non-2xx / placeholder / 404 /
// unparseable body (the caller then simply skips the parity advisory -- never throws).
export function parseEsIlmPolicyResponse(raw: string): EsIlmPolicy | null {
	const m = raw.match(/^\[(\d{3})\]\s*([\s\S]*)$/);
	if (!m) return null; // "[cluster not configured]" / "[404 ...]" placeholders, or empty
	const status = Number(m[1]);
	if (status < 200 || status >= 300) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(m[2] ?? "");
	} catch {
		return null;
	}
	if (!isObj(parsed)) return null;
	// ES returns { "<policy-name>": { version, modified_date, policy: { phases } } }.
	const entries = Object.values(parsed);
	const entry = entries.length === 1 ? entries[0] : undefined;
	const policy = isObj(entry) && isObj(entry.policy) ? entry.policy : undefined;
	if (!policy || !isObj(policy.phases)) return null;
	return { phases: policy.phases as EsIlmPolicy["phases"] };
}

// Map the raw ES ILM phases/actions shape into the repo flat DSL (mirrors what the Terraform
// lifecycle module encodes). Drops hot.min_age "0ms" (the ES default, not a meaningful repo field).
// (Pure; unit-tested against a live-verified fixture.)
export function esIlmPolicyToFlatDsl(policy: EsIlmPolicy): Json {
	const out: Json = {};
	for (const [phaseName, phase] of Object.entries(policy.phases)) {
		if (!isObj(phase)) continue;
		const p: Json = {};
		const minAge = typeof phase.min_age === "string" ? phase.min_age : undefined;
		// hot.min_age is always "0ms" (implicit); keep min_age on every other phase.
		if (minAge !== undefined && !(phaseName === "hot" && minAge === "0ms")) p.min_age = minAge;
		const actions = isObj(phase.actions) ? phase.actions : {};
		for (const [action, body] of Object.entries(actions)) {
			switch (action) {
				case "rollover": {
					// Flatten rollover.* onto the phase and mark rollover presence as a boolean.
					if (isObj(body)) for (const [k, v] of Object.entries(body)) p[k] = v;
					p.rollover = true;
					break;
				}
				case "set_priority": {
					if (isObj(body) && "priority" in body) p.priority = body.priority;
					break;
				}
				case "readonly": {
					p.readonly = true;
					break;
				}
				case "allocate":
				case "forcemerge":
				case "shrink":
				case "searchable_snapshot":
				case "wait_for_snapshot": {
					if (isObj(body)) p[action] = { ...body };
					break;
				}
				case "delete": {
					// delete.actions.delete.{delete_searchable_snapshot} flattens onto the delete phase.
					if (isObj(body)) for (const [k, v] of Object.entries(body)) p[k] = v;
					break;
				}
				default: {
					// Unknown action: carry it through so an unexpected live setting still surfaces.
					p[action] = isObj(body) ? { ...body } : body;
				}
			}
		}
		out[phaseName] = p;
	}
	return out;
}

export interface ParityLeaf {
	path: string;
	live?: unknown;
	draft?: unknown;
}

export interface LiveParity {
	inDraftNotLive: ParityLeaf[]; // a leaf the draft sets that live does not have (e.g. a stale extra phase/action)
	inLiveNotDraft: ParityLeaf[]; // a leaf live has that the draft drops
	valueDiffers: ParityLeaf[]; // a leaf both set, with different values
	hasDrift: boolean;
}

// Deep leaf-walk of two flat-DSL policy objects, classifying every differing leaf. `name` is ignored
// (a rename is the whole point of the copy). (Pure; unit-tested.)
export function computeIlmLiveParity(live: Json, draft: Json): LiveParity {
	const inDraftNotLive: ParityLeaf[] = [];
	const inLiveNotDraft: ParityLeaf[] = [];
	const valueDiffers: ParityLeaf[] = [];

	const walk = (l: unknown, d: unknown, prefix: string): void => {
		const keys = new Set<string>([...(isObj(l) ? Object.keys(l) : []), ...(isObj(d) ? Object.keys(d) : [])]);
		for (const key of keys) {
			if (prefix === "" && key === "name") continue; // rename is expected
			const path = prefix ? `${prefix}.${key}` : key;
			const lv = isObj(l) ? l[key] : undefined;
			const dv = isObj(d) ? d[key] : undefined;
			const lHas = isObj(l) && key in l;
			const dHas = isObj(d) && key in d;
			if (isObj(lv) || isObj(dv)) {
				walk(lv, dv, path);
				continue;
			}
			if (dHas && !lHas) inDraftNotLive.push({ path, draft: dv });
			else if (lHas && !dHas) inLiveNotDraft.push({ path, live: lv });
			else if (JSON.stringify(lv) !== JSON.stringify(dv)) valueDiffers.push({ path, live: lv, draft: dv });
		}
	};
	walk(live, draft, "");

	return {
		inDraftNotLive,
		inLiveNotDraft,
		valueDiffers,
		hasDrift: inDraftNotLive.length > 0 || inLiveNotDraft.length > 0 || valueDiffers.length > 0,
	};
}

// Render the parity result as a concise markdown block for the plan-review card. Empty string when
// there is no drift (the caller omits the section). (Pure; unit-tested.)
export function renderLiveParity(parity: LiveParity): string {
	if (!parity.hasDrift) return "";
	const lines: string[] = ["**Differs from live cluster** (the live policy was read for comparison):", ""];
	for (const l of parity.inDraftNotLive) {
		lines.push(
			`- \`${l.path}\`: \`${JSON.stringify(l.draft)}\` is in the draft but **not in live** (likely copied from a stale repo source).`,
		);
	}
	for (const l of parity.valueDiffers) {
		lines.push(
			`- \`${l.path}\`: live \`${JSON.stringify(l.live)}\` -> draft \`${JSON.stringify(l.draft)}\` (value changed).`,
		);
	}
	for (const l of parity.inLiveNotDraft) {
		lines.push(`- \`${l.path}\`: live has \`${JSON.stringify(l.live)}\` but the draft **drops it**.`);
	}
	return lines.join("\n");
}
