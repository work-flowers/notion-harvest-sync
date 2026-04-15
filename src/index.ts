import { Worker } from "@notionhq/workers";
import * as Builder from "@notionhq/workers/builder";
import * as Schema from "@notionhq/workers/schema";
import { fetchTimeEntries, getUserEmailMap } from "./harvest.js";
import { backfillRelations } from "./notion-lookup.js";
import type { HarvestTimeEntry } from "./types.js";

const worker = new Worker();
export default worker;

// Harvest rate limit: 100 requests per 15 seconds per account.
// Stay well under it.
const harvestApi = worker.pacer("harvestApi", {
	allowedRequests: 60,
	intervalMs: 15_000,
});

// Single shared database for both the backfill and delta syncs.
const timeEntries = worker.database("timeEntries", {
	type: "managed",
	initialTitle: "Harvest Time Entries",
	primaryKeyProperty: "Harvest Time Entry ID",
	schema: {
		properties: {
			Name: Schema.title(),
			"Harvest Time Entry ID": Schema.richText(),
			Date: Schema.date(),
			Hours: Schema.number(),
			Notes: Schema.richText(),
			User: Schema.richText(),
			Project: Schema.richText(),
			Task: Schema.richText(),
			Client: Schema.richText(),
			Billable: Schema.checkbox(),
			Person: Schema.people(),
			"Harvest Project Code": Schema.richText(),
			"Harvest Client ID": Schema.richText(),
			"Updated At": Schema.date(),
			"Created At": Schema.date(),
			// Deal (relation → Deals) and Company (relation → Companies) are
			// added manually in Notion after the first deploy and populated by
			// backfillRelations() using the Notion API directly. They are not
			// part of the sync schema because Worker relations can only target
			// other Worker-managed databases.
		},
	},
});

function toUpsertChange(
	entry: HarvestTimeEntry,
	userEmails: Map<number, string>,
) {
	const email = userEmails.get(entry.user.id);
	return {
		type: "upsert" as const,
		key: String(entry.id),
		properties: {
			Name: Builder.title(
				`${entry.spent_date} — ${entry.user.name} — ${entry.project.name}`,
			),
			"Harvest Time Entry ID": Builder.richText(String(entry.id)),
			Date: Builder.date(entry.spent_date),
			Hours: Builder.number(entry.hours),
			Notes: Builder.richText(entry.notes ?? ""),
			User: Builder.richText(entry.user.name),
			Project: Builder.richText(entry.project.name),
			Task: Builder.richText(entry.task.name),
			Client: Builder.richText(entry.client.name),
			Billable: Builder.checkbox(entry.billable),
			Person: email ? Builder.people(email) : Builder.people(),
			"Harvest Project Code": Builder.richText(entry.project.code ?? ""),
			"Harvest Client ID": Builder.richText(String(entry.client.id)),
			"Updated At": Builder.dateTime(entry.updated_at),
			"Created At": Builder.dateTime(entry.created_at),
		},
	};
}

// Backfill: replace-mode, manual trigger. Paginates the entire Harvest time
// entries dataset. Run on first deploy and whenever state drifts.
//   ntn workers sync state reset timeEntriesBackfill
//   ntn workers sync trigger timeEntriesBackfill
worker.sync("timeEntriesBackfill", {
	database: timeEntries,
	mode: "replace",
	schedule: "manual",
	execute: async (state: { page?: number } | undefined) => {
		const page = state?.page ?? 1;
		await harvestApi.wait();
		const [result, userEmails] = await Promise.all([
			fetchTimeEntries({ page, perPage: 100 }),
			getUserEmailMap(),
		]);
		const hasMore = page < result.total_pages;

		// Opportunistically patch relations each batch.
		await tryBackfillRelations();

		return {
			changes: result.time_entries.map((e) => toUpsertChange(e, userEmails)),
			hasMore,
			nextState: hasMore ? { page: page + 1 } : undefined,
		};
	},
});

// Delta: incremental mode, hourly. Uses Harvest's `updated_since` filter.
worker.sync("timeEntriesDelta", {
	database: timeEntries,
	mode: "incremental",
	schedule: "1h",
	execute: async (
		state:
			| { cursor?: string; page?: number; cycleStart?: string }
			| undefined,
	) => {
		// 60-second consistency buffer — Harvest is eventually consistent, so
		// never advance the cursor past "now minus 60s" to avoid skipping
		// records that haven't been indexed yet.
		const bufferMs = 60_000;
		const nowMinusBuffer = new Date(Date.now() - bufferMs).toISOString();

		const cursor = state?.cursor ?? new Date(0).toISOString();
		const page = state?.page ?? 1;
		// Freeze the cycle's "end" time on the first call of the cycle so we
		// can advance the cursor to a consistent point after the final page.
		const cycleStart = state?.cycleStart ?? nowMinusBuffer;

		await harvestApi.wait();
		const [result, userEmails] = await Promise.all([
			fetchTimeEntries({ updatedSince: cursor, page, perPage: 100 }),
			getUserEmailMap(),
		]);
		const hasMore = page < result.total_pages;

		// Opportunistic relation backfill — covers entries written by prior
		// cycles whose Deal/Company lookup values now have matches.
		await tryBackfillRelations();

		return {
			changes: result.time_entries.map((e) => toUpsertChange(e, userEmails)),
			hasMore,
			nextState: hasMore
				? { cursor, page: page + 1, cycleStart }
				: { cursor: cycleStart },
		};
	},
});

async function tryBackfillRelations(): Promise<void> {
	if (!process.env.TIME_ENTRIES_DS_ID || !process.env.INTEGRATION_TOKEN) return;
	try {
		const result = await backfillRelations();
		console.log(
			`Relation backfill: scanned=${result.scanned} patched=${result.patched} skipped=${result.skipped} errors=${result.errors}`,
		);
	} catch (err) {
		console.warn(`Relation backfill failed: ${(err as Error).message}`);
	}
}
