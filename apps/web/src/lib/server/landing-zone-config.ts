// apps/web/src/lib/server/landing-zone-config.ts

import { DynamoDBClient, ScanCommand, type ScanCommandOutput } from "@aws-sdk/client-dynamodb";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { z } from "zod";

export const LANDING_ZONE_ACCOUNT_CATALOG = {
	region: "eu-central-1",
	roleArn: "arn:aws:iam::307424506679:role/lz-kb-dynamodb-readonly",
	tableName: "flow-prd-ae1-ddb-accounts",
} as const;

const CATALOG_PAGE_SIZE = 500;
const MAX_CATALOG_PAGES = 100;
const accountIdSchema = z.string().regex(/^\d{12}$/, "must be a 12-digit AWS account ID");
const requestedAccountsSchema = z.array(accountIdSchema).max(100);
const catalogItemsSchema = z.array(
	z.object({
		account_id: z.object({ S: accountIdSchema }),
	}),
);

interface LandingZoneCatalogClient {
	send(command: ScanCommand): Promise<Pick<ScanCommandOutput, "Items" | "LastEvaluatedKey">>;
}

export interface LandingZoneAccountAuthorizerOptions {
	client?: LandingZoneCatalogClient;
}

function createCatalogClient(): LandingZoneCatalogClient {
	return new DynamoDBClient({
		region: LANDING_ZONE_ACCOUNT_CATALOG.region,
		credentials: fromTemporaryCredentials({
			clientConfig: { region: LANDING_ZONE_ACCOUNT_CATALOG.region },
			params: {
				RoleArn: LANDING_ZONE_ACCOUNT_CATALOG.roleArn,
				RoleSessionName: "landing-zone-account-catalog",
			},
		}),
		maxAttempts: 3,
	});
}

export function createLandingZoneAccountAuthorizer(
	options: LandingZoneAccountAuthorizerOptions = {},
): (requestedAccountIds: string[]) => Promise<string[]> {
	const client = options.client ?? createCatalogClient();
	let catalogPromise: Promise<ReadonlySet<string>> | undefined;

	const loadCatalog = async (): Promise<ReadonlySet<string>> => {
		const accountIds = new Set<string>();
		let exclusiveStartKey: ScanCommandOutput["LastEvaluatedKey"];
		for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
			const response = await client.send(
				new ScanCommand({
					TableName: LANDING_ZONE_ACCOUNT_CATALOG.tableName,
					FilterExpression: "begins_with(PK, :accountPrefix) AND SK = :metadata",
					ExpressionAttributeValues: {
						":accountPrefix": { S: "ACCOUNT#" },
						":metadata": { S: "METADATA" },
					},
					ProjectionExpression: "account_id",
					ExclusiveStartKey: exclusiveStartKey,
					Limit: CATALOG_PAGE_SIZE,
				}),
			);
			const parsed = catalogItemsSchema.safeParse(response.Items ?? []);
			if (!parsed.success) throw new Error("invalid Landing Zone account catalog response");
			for (const item of parsed.data) accountIds.add(item.account_id.S);
			exclusiveStartKey = response.LastEvaluatedKey;
			if (!exclusiveStartKey) return accountIds;
		}
		throw new Error(`Landing Zone account catalog exceeded ${MAX_CATALOG_PAGES} pages`);
	};

	const catalog = async (): Promise<ReadonlySet<string>> => {
		if (catalogPromise) return catalogPromise;
		const pending = loadCatalog();
		catalogPromise = pending;
		try {
			return await pending;
		} catch (error) {
			if (catalogPromise === pending) catalogPromise = undefined;
			throw error;
		}
	};

	return async (requestedAccountIds) => {
		const requested = [...new Set(requestedAccountsSchema.parse(requestedAccountIds))].sort();
		if (requested.length === 0) return [];
		const knownAccounts = await catalog();
		return requested.filter((accountId) => knownAccounts.has(accountId));
	};
}

export const authorizeLandingZoneTopologyAccounts = createLandingZoneAccountAuthorizer();
