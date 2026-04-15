// Relation property names on the Time Entries database — set manually in Notion
// after first deploy. See README / plan.
const DEAL_RELATION_PROPERTY = "Deal";
const COMPANY_RELATION_PROPERTY = "Company";

// Lookup property names on the related data sources.
const DEAL_ID_PROPERTY_ON_DEALS = "Deal ID";
const HARVEST_CLIENT_ID_PROPERTY_ON_COMPANIES = "Harvest Client ID";

// Text-property names on Time Entries rows that carry the lookup keys.
const HARVEST_PROJECT_CODE_PROPERTY = "Harvest Project Code";
const HARVEST_CLIENT_ID_PROPERTY = "Harvest Client ID";

// How many pages.update calls to issue per sync run (guardrail against timeouts).
const MAX_PATCHES_PER_RUN = 100;

// Upper bound on rows scanned per run (safety net for very large DBs).
const MAX_SCAN_PER_RUN = 2000;

// Cache lookup maps across runs in the same process.
const LOOKUP_TTL_MS = 10 * 60 * 1000;

// Notion API version that exposes /v1/data_sources/{id}/query.
const NOTION_VERSION = "2025-09-03";
const NOTION_API_BASE = "https://api.notion.com/v1";

interface LookupCacheEntry {
	map: Map<string, string>;
	fetchedAt: number;
}

const lookupCache = new Map<string, LookupCacheEntry>();

interface NotionPage {
	id: string;
	properties: Record<string, unknown>;
}

interface NotionQueryResponse {
	results: NotionPage[];
	next_cursor: string | null;
	has_more: boolean;
}

async function notionFetch(
	token: string,
	path: string,
	method: "GET" | "POST" | "PATCH",
	body?: Record<string, unknown>,
): Promise<unknown> {
	const response = await fetch(`${NOTION_API_BASE}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			"Notion-Version": NOTION_VERSION,
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Notion ${response.status} ${response.statusText} on ${method} ${path}: ${text.slice(0, 500)}`,
		);
	}
	return text ? JSON.parse(text) : null;
}

async function queryDataSource(
	token: string,
	dataSourceId: string,
	body: Record<string, unknown>,
): Promise<NotionQueryResponse> {
	return (await notionFetch(
		token,
		`/data_sources/${dataSourceId}/query`,
		"POST",
		body,
	)) as NotionQueryResponse;
}

async function updatePage(
	token: string,
	pageId: string,
	properties: Record<string, unknown>,
): Promise<void> {
	await notionFetch(token, `/pages/${pageId}`, "PATCH", { properties });
}

/** Extract a plain string value from a Notion property, across common types. */
function propertyToString(prop: unknown): string | null {
	if (!prop || typeof prop !== "object") return null;
	const p = prop as { type?: string; [k: string]: unknown };
	switch (p.type) {
		case "title":
		case "rich_text": {
			const arr = p[p.type] as Array<{ plain_text?: string }> | undefined;
			if (!arr?.length) return null;
			const text = arr.map((r) => r.plain_text ?? "").join("").trim();
			return text || null;
		}
		case "number": {
			const n = p.number as number | null | undefined;
			return n == null ? null : String(n);
		}
		case "formula": {
			const f = p.formula as
				| { type: string; string?: string | null; number?: number | null }
				| undefined;
			if (!f) return null;
			if (f.type === "string") return f.string ?? null;
			if (f.type === "number") return f.number == null ? null : String(f.number);
			return null;
		}
		case "unique_id": {
			const u = p.unique_id as { prefix?: string | null; number?: number | null } | undefined;
			if (!u?.number) return null;
			return u.prefix ? `${u.prefix}-${u.number}` : String(u.number);
		}
		default:
			return null;
	}
}

/** Build a lookup map (key-string → page_id) by scanning a data source. */
async function buildLookupMap(
	token: string,
	dataSourceId: string,
	keyProperty: string,
	filter?: Record<string, unknown>,
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	let startCursor: string | undefined = undefined;
	do {
		const body: Record<string, unknown> = { page_size: 100 };
		if (startCursor) body.start_cursor = startCursor;
		if (filter) body.filter = filter;
		const response = await queryDataSource(token, dataSourceId, body);
		for (const page of response.results) {
			const key = propertyToString(page.properties?.[keyProperty]);
			if (key) map.set(key, page.id);
		}
		startCursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
	} while (startCursor);
	return map;
}

async function getLookupMap(
	token: string,
	dataSourceId: string,
	keyProperty: string,
): Promise<Map<string, string>> {
	const cached = lookupCache.get(dataSourceId);
	if (cached && Date.now() - cached.fetchedAt < LOOKUP_TTL_MS) {
		return cached.map;
	}
	let map: Map<string, string>;
	try {
		map = await buildLookupMap(token, dataSourceId, keyProperty, {
			property: keyProperty,
			rich_text: { is_not_empty: true },
		});
	} catch {
		// Property might not be rich_text — fall back to unfiltered scan.
		map = await buildLookupMap(token, dataSourceId, keyProperty);
	}
	lookupCache.set(dataSourceId, { map, fetchedAt: Date.now() });
	return map;
}

interface TimeEntryRow {
	pageId: string;
	projectCode: string | null;
	clientId: string | null;
	dealEmpty: boolean;
	companyEmpty: boolean;
}

async function findTimeEntriesNeedingRelations(
	token: string,
	timeEntriesDs: string,
): Promise<TimeEntryRow[]> {
	const rows: TimeEntryRow[] = [];
	let startCursor: string | undefined = undefined;
	do {
		const body: Record<string, unknown> = {
			page_size: 100,
			filter: {
				or: [
					{ property: DEAL_RELATION_PROPERTY, relation: { is_empty: true } },
					{ property: COMPANY_RELATION_PROPERTY, relation: { is_empty: true } },
				],
			},
		};
		if (startCursor) body.start_cursor = startCursor;
		const response = await queryDataSource(token, timeEntriesDs, body);

		for (const page of response.results) {
			const props = page.properties ?? {};
			const dealProp = props[DEAL_RELATION_PROPERTY] as
				| { relation?: unknown[] }
				| undefined;
			const companyProp = props[COMPANY_RELATION_PROPERTY] as
				| { relation?: unknown[] }
				| undefined;
			rows.push({
				pageId: page.id,
				projectCode: propertyToString(props[HARVEST_PROJECT_CODE_PROPERTY]),
				clientId: propertyToString(props[HARVEST_CLIENT_ID_PROPERTY]),
				dealEmpty: !dealProp?.relation?.length,
				companyEmpty: !companyProp?.relation?.length,
			});
			if (rows.length >= MAX_SCAN_PER_RUN) return rows;
		}
		startCursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
	} while (startCursor);
	return rows;
}

export interface BackfillResult {
	scanned: number;
	patched: number;
	skipped: number;
	errors: number;
}

/**
 * Best-effort: for any Time Entries rows with an empty Deal or Company relation,
 * look up matching pages in the Deals / Companies data sources and set the
 * relation. Skips rows where no match is found.
 *
 * Uses a dedicated Notion integration (INTEGRATION_TOKEN) rather than the
 * Worker's internal auth, because Worker-managed auth doesn't have access to
 * pre-existing Notion data sources.
 */
export async function backfillRelations(): Promise<BackfillResult> {
	const timeEntriesDs = process.env.TIME_ENTRIES_DS_ID;
	const dealsDs = process.env.DEALS_DS_ID;
	const companiesDs = process.env.COMPANIES_DS_ID;
	const token = process.env.INTEGRATION_TOKEN;

	if (!timeEntriesDs || !dealsDs || !companiesDs || !token) {
		return { scanned: 0, patched: 0, skipped: 0, errors: 0 };
	}

	const [dealMap, companyMap] = await Promise.all([
		getLookupMap(token, dealsDs, DEAL_ID_PROPERTY_ON_DEALS),
		getLookupMap(token, companiesDs, HARVEST_CLIENT_ID_PROPERTY_ON_COMPANIES),
	]);

	const rows = await findTimeEntriesNeedingRelations(token, timeEntriesDs);

	let patched = 0;
	let skipped = 0;
	let errors = 0;

	for (const row of rows) {
		const update: Record<string, unknown> = {};
		if (row.dealEmpty && row.projectCode) {
			const dealPageId = dealMap.get(row.projectCode);
			if (dealPageId) {
				update[DEAL_RELATION_PROPERTY] = { relation: [{ id: dealPageId }] };
			}
		}
		if (row.companyEmpty && row.clientId) {
			const companyPageId = companyMap.get(row.clientId);
			if (companyPageId) {
				update[COMPANY_RELATION_PROPERTY] = { relation: [{ id: companyPageId }] };
			}
		}
		if (Object.keys(update).length === 0) {
			skipped++;
			continue;
		}
		try {
			await updatePage(token, row.pageId, update);
			patched++;
		} catch (err) {
			errors++;
			console.warn(
				`Failed to patch relations for page ${row.pageId}: ${(err as Error).message}`,
			);
		}
		if (patched >= MAX_PATCHES_PER_RUN) break;
	}

	return { scanned: rows.length, patched, skipped, errors };
}
