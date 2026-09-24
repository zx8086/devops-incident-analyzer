// packages/agent/src/landing-zone/request-resolution.test.ts

import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { resolveLandingZoneRequest } from "./request-resolution.ts";

describe("resolveLandingZoneRequest", () => {
	test.each([
		[
			"Show me the PVH process for creating a new AWS Landing Zone account.",
			["aws-lz-account-creator"],
			"account-vending",
			"deterministic",
		],
		[
			"Explain how aws-lz-account-creator turns account YAML into Terraform.",
			["aws-lz-account-creator"],
			"repository-explanation",
			"explicit",
		],
		[
			"Map the VPCs, subnets, routes, and central-network attachments for an existing account.",
			["aws-lz-network-core", "aws-lz-network-workloads"],
			"topology",
			"deterministic",
		],
		[
			"Trace the DNS resolution path for a Landing Zone workload account.",
			["aws-lz-network-workloads", "aws-lz-post-vending"],
			"topology",
			"deterministic",
		],
		[
			"Explain how a Landing Zone GitLab project and its runners are set up.",
			["dhco-gitlab-terraform", "gitlab-k8s-runners-lzv2"],
			"repository-explanation",
			"deterministic",
		],
		[
			"Compare the current PVH Terraform pattern with official AWS and Terraform best practices.",
			["aws-lz-account-creator", "aws-lz-network-core", "aws-lz-network-workloads"],
			"standards-comparison",
			"deterministic",
		],
	] as const)("routes shipped and typed prompt: %s", async (prompt, repositories, subject, resolutionSource) => {
		const result = await resolveLandingZoneRequest({
			messages: [new HumanMessage(prompt)],
			intent: "learn",
			repositoryScope: [],
			accountScope: [],
			authorizedAccountScope: [],
		});

		expect(result.repositories).toEqual([...repositories]);
		expect(result.subject).toBe(subject);
		expect(result.repositoryResolution).toBe(resolutionSource);
	});

	test("matches plural and hyphenated network wording without inheriting a foreign account selection", async () => {
		const result = await resolveLandingZoneRequest({
			messages: [new HumanMessage("How are central-network links, VPCs, routes, and subnets connected?")],
			intent: "understand",
			repositoryScope: [],
			accountScope: [],
			authorizedAccountScope: ["111122223333"],
		});

		expect(result.repositories).toEqual(["aws-lz-network-core", "aws-lz-network-workloads"]);
		expect(result.accountIds).toEqual([]);
		expect(result.accountResolution).toBe("unresolved");
		expect(result.clarification).toBe("Which Landing Zone account should I map? Provide the 12-digit account ID.");
	});

	test("inherits established repository and account scope for a terse follow-up", async () => {
		const result = await resolveLandingZoneRequest({
			messages: [
				new HumanMessage("Explain aws-lz-account-creator for account 111122223333"),
				new AIMessage("The account request is YAML-first."),
				new HumanMessage("Show the YAML."),
			],
			intent: "understand",
			repositoryScope: ["aws-lz-account-creator"],
			accountScope: ["111122223333"],
			authorizedAccountScope: ["111122223333"],
		});

		expect(result.repositories).toEqual(["aws-lz-account-creator"]);
		expect(result.accountIds).toEqual(["111122223333"]);
		expect(result.repositoryResolution).toBe("session");
		expect(result.accountResolution).toBe("session");
	});

	test("intersects model-selected repositories with the fixed allowlist", async () => {
		const result = await resolveLandingZoneRequest(
			{
				messages: [new HumanMessage("Explain the component that handles this platform concern")],
				intent: "understand",
				repositoryScope: [],
				accountScope: [],
				authorizedAccountScope: [],
			},
			{
				resolveAmbiguity: async () => ({
					repositories: ["aws-lz-storage", "attacker-controlled-repository"],
					subject: "repository-explanation",
					application: null,
					environment: null,
					topologyView: null,
					clarification: null,
				}),
			},
		);

		expect(result.repositories).toEqual(["aws-lz-storage"]);
		expect(result.repositoryResolution).toBe("model");
	});

	test("asks for an account before an account network map when scope is ambiguous", async () => {
		const result = await resolveLandingZoneRequest({
			messages: [new HumanMessage("Map the VPCs, subnets, and routes for an existing account")],
			intent: "understand",
			repositoryScope: [],
			accountScope: [],
			authorizedAccountScope: ["111122223333", "444455556666"],
		});

		expect(result.clarification).toBe("Which Landing Zone account should I map? Provide the 12-digit account ID.");
	});

	test("asks for a hostname and account instead of inheriting a foreign account selection", async () => {
		const result = await resolveLandingZoneRequest({
			messages: [new HumanMessage("Trace the DNS resolution path for a Landing Zone workload account.")],
			intent: "understand",
			repositoryScope: [],
			accountScope: [],
			authorizedAccountScope: ["111122223333"],
		});

		expect(result.clarification).toBe(
			"Which hostname and Landing Zone account should I trace? Provide the hostname and 12-digit account ID.",
		);
	});

	test("asks whether to retain or replace established scope on a topic shift", async () => {
		const result = await resolveLandingZoneRequest({
			messages: [
				new HumanMessage("Explain account vending"),
				new AIMessage("Account vending is YAML-first."),
				new HumanMessage("Now explain the central network and workload VPCs."),
			],
			intent: "understand",
			repositoryScope: ["aws-lz-account-creator"],
			accountScope: [],
			authorizedAccountScope: [],
		});

		expect(result.clarification).toContain("Should I retain the previous scope or replace it?");
		expect(result.repositories).toEqual(["aws-lz-network-core", "aws-lz-network-workloads"]);
	});
});
