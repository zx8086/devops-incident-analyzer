// apps/web/src/lib/server/landing-zone-config.test.ts

import { describe, expect, mock, test } from "bun:test";
import type { ScanCommand, ScanCommandOutput } from "@aws-sdk/client-dynamodb";
import { createLandingZoneAccountAuthorizer, LANDING_ZONE_ACCOUNT_CATALOG } from "./landing-zone-config.ts";

describe("Landing Zone account catalog configuration", () => {
	test("scans the fixed Landing Zone account table without request-derived values", async () => {
		const send = mock(async (_command: ScanCommand): Promise<ScanCommandOutput> => ({ Items: [], $metadata: {} }));
		const authorize = createLandingZoneAccountAuthorizer({ client: { send } });

		await authorize(["111122223333"]);

		expect(LANDING_ZONE_ACCOUNT_CATALOG).toEqual({
			region: "eu-central-1",
			roleArn: "arn:aws:iam::307424506679:role/lz-kb-dynamodb-readonly",
			tableName: "flow-prd-ae1-ddb-accounts",
		});
		expect(send).toHaveBeenCalledTimes(1);
		const command = send.mock.calls[0]?.[0];
		expect(command?.input).toMatchObject({
			TableName: "flow-prd-ae1-ddb-accounts",
			FilterExpression: "begins_with(PK, :accountPrefix) AND SK = :metadata",
			ProjectionExpression: "account_id",
		});
		expect(JSON.stringify(command?.input)).not.toContain("111122223333");
	});
});
