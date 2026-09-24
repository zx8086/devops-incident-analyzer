// apps/web/src/lib/server/landing-zone-account-catalog.test.ts

import { describe, expect, mock, test } from "bun:test";
import type { ScanCommand, ScanCommandOutput } from "@aws-sdk/client-dynamodb";
import { createLandingZoneAccountAuthorizer } from "./landing-zone-config.ts";

function catalogClient(...outputs: ScanCommandOutput[]) {
	const send = mock(async (_command: ScanCommand) => {
		const output = outputs.shift();
		if (!output) throw new Error("unexpected catalog scan");
		return output;
	});
	return { client: { send }, send };
}

describe("createLandingZoneAccountAuthorizer", () => {
	test("authorizes only exact account IDs returned by the Landing Zone catalog", async () => {
		const { client, send } = catalogClient({
			Items: [{ account_id: { S: "860977521447" } }, { account_id: { S: "307424506679" } }],
			$metadata: {},
		});
		const authorize = createLandingZoneAccountAuthorizer({ client });

		expect(await authorize(["860977521447", "609775214470", "307424506679"])).toEqual(["307424506679", "860977521447"]);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test("reads every catalog page before authorizing and reuses the result", async () => {
		const { client, send } = catalogClient(
			{
				Items: [{ account_id: { S: "860977521447" } }],
				LastEvaluatedKey: { PK: { S: "ACCOUNT#citrix-prd" }, SK: { S: "METADATA" } },
				$metadata: {},
			},
			{ Items: [{ account_id: { S: "307424506679" } }], $metadata: {} },
		);
		const authorize = createLandingZoneAccountAuthorizer({ client });

		expect(await authorize(["860977521447", "307424506679"])).toEqual(["307424506679", "860977521447"]);
		expect(await authorize(["860977521447"])).toEqual(["860977521447"]);
		expect(send).toHaveBeenCalledTimes(2);
	});

	test("fails closed when the catalog response is malformed", async () => {
		const { client } = catalogClient({ Items: [{ account_id: { S: "not-an-account" } }], $metadata: {} });
		const authorize = createLandingZoneAccountAuthorizer({ client });

		await expect(authorize(["860977521447"])).rejects.toThrow("invalid Landing Zone account catalog response");
	});

	test("does not cache an unavailable catalog response", async () => {
		let attempts = 0;
		const send = mock(async (_command: ScanCommand): Promise<ScanCommandOutput> => {
			attempts += 1;
			if (attempts === 1) throw new Error("catalog unavailable");
			return { Items: [{ account_id: { S: "860977521447" } }], $metadata: {} };
		});
		const authorize = createLandingZoneAccountAuthorizer({
			client: { send },
		});

		await expect(authorize(["860977521447"])).rejects.toThrow("catalog unavailable");
		expect(await authorize(["860977521447"])).toEqual(["860977521447"]);
		expect(attempts).toBe(2);
	});
});
