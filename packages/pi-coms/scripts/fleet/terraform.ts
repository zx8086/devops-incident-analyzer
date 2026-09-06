// scripts/fleet/terraform.ts
// SIO-1653: terraform per account root, with the S3 backend config passed at
// init (bucket, region, profile live in the gitignored backend.hcl) and the
// legacy local state migrated on first init.
import { existsSync } from "node:fs";
import * as path from "node:path";

export type Runner = (argv: string[], cwd: string) => Promise<number>;

export const spawnRunner: Runner = async (argv, cwd) => {
	const proc = Bun.spawn(argv, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	return await proc.exited;
};

export async function terraformInit(root: string, run: Runner = spawnRunner): Promise<void> {
	const args = ["terraform", "init", "-input=false", "-backend-config=backend.hcl"];
	// A local terraform.tfstate next to the root is the pre-S3 state of that
	// account: move it into the bucket once, then it is gone from the laptop.
	if (existsSync(path.join(root, "terraform.tfstate"))) args.push("-migrate-state", "-force-copy");
	const code = await run(args, root);
	if (code !== 0) throw new Error(`terraform init failed in ${root} (exit ${code})`);
}

export async function terraformPlan(root: string, run: Runner = spawnRunner): Promise<void> {
	const code = await run(["terraform", "plan", "-input=false"], root);
	if (code !== 0) throw new Error(`terraform plan failed in ${root} (exit ${code})`);
}

export async function terraformApply(
	root: string,
	opts: { production: boolean; yes: boolean },
	run: Runner = spawnRunner,
): Promise<void> {
	if (opts.production && !opts.yes) {
		throw new Error(
			`${path.basename(root)} is a production account; re-run with --yes to apply (plan only by default)`,
		);
	}
	const code = await run(["terraform", "apply", "-input=false", "-auto-approve"], root);
	if (code !== 0) throw new Error(`terraform apply failed in ${root} (exit ${code})`);
}
