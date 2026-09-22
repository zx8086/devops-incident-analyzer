// apps/web/src/lib/landing-zone-copy.ts

export interface LandingZoneStarterPrompt {
	readonly id: string;
	readonly label: string;
	readonly prompt: string;
}

export const LANDING_ZONE_BANNER =
	"Learning and review use live PVH evidence. Future changes are proposed through a reviewed GitLab MR; this agent never applies Terraform or mutates AWS.";

export const LANDING_ZONE_EMPTY_STATE =
	"Ask how the PVH Landing Zone works, review current repository patterns, or compare PVH standards with official AWS and Terraform guidance.";

export const LANDING_ZONE_STARTER_PROMPTS: readonly LandingZoneStarterPrompt[] = [
	{
		id: "account-creation",
		label: "Create an account",
		prompt: "Show me the PVH process for creating a new AWS Landing Zone account.",
	},
	{
		id: "repository-explanation",
		label: "Explain a repository",
		prompt: "Explain how aws-lz-account-creator turns account YAML into Terraform.",
	},
	{
		id: "network-map",
		label: "Map an account network",
		prompt: "Map the VPCs, subnets, routes, and central-network attachments for an existing account.",
	},
	{
		id: "dns-path",
		label: "Trace DNS",
		prompt: "Trace the DNS resolution path for a Landing Zone workload account.",
	},
	{
		id: "gitlab-project-runners",
		label: "Explain GitLab and runners",
		prompt: "Explain how a Landing Zone GitLab project and its runners are set up.",
	},
	{
		id: "standards-comparison",
		label: "Compare standards",
		prompt: "Compare the current PVH Terraform pattern with official AWS and Terraform best practices.",
	},
];
