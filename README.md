# notion-harvest-sync

A Notion Worker that syncs Harvest time tracking into a Notion database on an
hourly schedule, and post-hoc links each entry to rows in pre-existing Deals
and Companies data sources.

## Capabilities

| Key | Mode | Schedule | Purpose |
|---|---|---|---|
| `timeEntriesBackfill` | replace | manual | Full re-pull of all Harvest time entries. Run once on first deploy and whenever state drifts. |
| `timeEntriesDelta` | incremental | 1h | Hourly fetch of entries changed since the last cursor. |

Both syncs write to the same managed Notion database (`Harvest Time Entries`)
and share a pacer (`harvestApi`, 60 req / 15 s — Harvest's limit is 100 / 15 s).

### Person mapping

Each entry's Harvest user is mapped to a Notion `Person` property by matching
the Harvest user's email address to a workspace member. Users without a
matching workspace member are left unset. The Harvest user list is cached
in-process for an hour to keep syncs cheap.

### Relation linking (hybrid approach)

Worker relations can only target other Worker-managed databases, so the link
from time entries to existing **Deals** and **Companies** data sources is done
by directly calling the Notion API within each run, *after* the basic sync has
written the row. The `Deal` and `Company` relation properties must be added to
the Time Entries database manually after first deploy (see setup below).

- `Deal` ← match by Harvest `project.code` ↔ Deals property `Deal ID`.
- `Company` ← match by Harvest `client.id` ↔ Companies property `Harvest Client ID`.

A newly-synced entry may appear without relations for up to one cycle (≤ 1 h);
the next run will fill them in. The relation-backfill pass uses a dedicated
Notion integration (`INTEGRATION_TOKEN`) — the Worker's own auth can only reach
Worker-managed databases.

The redundant `Client` and `Project` rich_text properties are kept as a
Harvest-native label, useful when a time entry has no matching Deal/Company row.

## Setup

### 1. Secrets

```shell
ntn workers env set HARVEST_ACCESS_TOKEN=<personal-access-token>
ntn workers env set HARVEST_ACCOUNT_ID=<numeric-account-id>
ntn workers env set INTEGRATION_TOKEN=<notion-internal-integration-token>
ntn workers env set DEALS_DS_ID=<your-deals-data-source-id>
ntn workers env set COMPANIES_DS_ID=<your-companies-data-source-id>
# TIME_ENTRIES_DS_ID — set after first deploy (see step 4)
```

`INTEGRATION_TOKEN` is a dedicated Notion internal integration used only for
the relation backfill step. Create one at
<https://www.notion.so/profile/integrations> and share the **Deals**,
**Companies**, and (after first deploy) **Harvest Time Entries** data sources
with it.

Grab Harvest credentials from
<https://id.getharvest.com/developers>.

### 2. First deploy and backfill

```shell
ntn workers deploy
ntn workers sync trigger timeEntriesBackfill
```

This creates the `Harvest Time Entries` database in Notion and populates it.

### 3. Add the relation properties in Notion

1. Share the existing **Deals** and **Companies** data sources with the
   integration backing the Worker.
2. Open the newly-created **Harvest Time Entries** database.
3. Add two properties:
   - `Deal` — Relation → **Deals**.
   - `Company` — Relation → **Companies**.
4. Share the Harvest Time Entries database with the same integration.

### 4. Wire up the Notion data source ID

Copy the Time Entries data source ID (from its URL or Notion settings) and set
it so the relation-backfill step can find rows to patch:

```shell
ntn workers env set TIME_ENTRIES_DS_ID=<id>
ntn workers deploy
```

On the next `timeEntriesDelta` run, or after a manual
`ntn workers sync trigger timeEntriesDelta`, existing rows will be patched with
their `Deal` and `Company` relations.

## Development

```shell
npm install
npm run check   # type-check
npm run build   # emit dist/
```

Preview a sync without writing to Notion:

```shell
ntn workers sync trigger timeEntriesDelta --preview
```

Inspect run health and logs:

```shell
ntn workers sync status
ntn workers runs list
```

## File map

- `src/index.ts` — worker entrypoint; defines the database, pacer, and two syncs.
- `src/harvest.ts` — Harvest API client (`GET /v2/time_entries`).
- `src/notion-lookup.ts` — builds Deals/Companies lookup maps via the Notion
  API and patches empty `Deal` / `Company` relation properties on Time Entries
  rows.
- `src/types.ts` — Harvest response types.
