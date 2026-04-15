import type { HarvestTimeEntriesPage, HarvestUsersPage } from "./types.js";

const HARVEST_BASE_URL = "https://api.harvestapp.com/v2";

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required env var ${name}`);
	}
	return value;
}

function harvestHeaders(): Record<string, string> {
	return {
		Authorization: `Bearer ${requireEnv("HARVEST_ACCESS_TOKEN")}`,
		"Harvest-Account-Id": requireEnv("HARVEST_ACCOUNT_ID"),
		"User-Agent": "notion-harvest-sync",
		Accept: "application/json",
	};
}

export interface FetchTimeEntriesParams {
	/** ISO 8601 timestamp; only entries updated at or after this time are returned. */
	updatedSince?: string;
	/** 1-indexed page number. */
	page: number;
	/** Page size; Harvest max is 2000, default 2000. Keep batches modest to stay well under the sync timeout. */
	perPage?: number;
}

export async function fetchTimeEntries(
	params: FetchTimeEntriesParams,
): Promise<HarvestTimeEntriesPage> {
	const url = new URL(`${HARVEST_BASE_URL}/time_entries`);
	url.searchParams.set("page", String(params.page));
	url.searchParams.set("per_page", String(params.perPage ?? 100));
	if (params.updatedSince) {
		url.searchParams.set("updated_since", params.updatedSince);
	}

	const response = await fetch(url.toString(), { headers: harvestHeaders() });
	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Harvest ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
		);
	}
	return (await response.json()) as HarvestTimeEntriesPage;
}

// -- Users: id → email map, cached in-process --
//
// Users rarely change; refresh at most every hour to keep syncs cheap.

const USER_CACHE_TTL_MS = 60 * 60 * 1000;
let cachedUserMap: { map: Map<number, string>; fetchedAt: number } | null = null;

async function fetchUsersPage(page: number): Promise<HarvestUsersPage> {
	const url = new URL(`${HARVEST_BASE_URL}/users`);
	url.searchParams.set("page", String(page));
	url.searchParams.set("per_page", "100");
	const response = await fetch(url.toString(), { headers: harvestHeaders() });
	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Harvest ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
		);
	}
	return (await response.json()) as HarvestUsersPage;
}

/**
 * Build (or reuse) a map of Harvest user_id → email address. Pages through
 * all users on first call, then caches for an hour.
 */
export async function getUserEmailMap(): Promise<Map<number, string>> {
	if (cachedUserMap && Date.now() - cachedUserMap.fetchedAt < USER_CACHE_TTL_MS) {
		return cachedUserMap.map;
	}
	const map = new Map<number, string>();
	let page = 1;
	// Paginate the full user list.
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const result = await fetchUsersPage(page);
		for (const user of result.users) {
			if (user.email) map.set(user.id, user.email);
		}
		if (page >= result.total_pages) break;
		page++;
	}
	cachedUserMap = { map, fetchedAt: Date.now() };
	return map;
}
