# Cartrack Fleet MCP Server — Procon Fleet

Wraps Cartrack's Fleet API (`developer.cartrack.com`) as an MCP server for interactive use in
Claude Code, plus two standalone CLI scripts that a cloud Routine runs on a schedule:

- `sync:daily` — pulls the previous 24h of vehicle status, trips, and fuel data for the whole
  fleet and appends it to the **Procon Fleet — Live Dashboard** Google Sheet.
- `sync:monthly` — compares that month's Cartrack-metered fuel per vehicle against the fleet
  card's litres/Rand already merged into the master workbook, and flags mismatches.

Endpoints, parameters, pagination, and rate limits below were confirmed against the live
OpenAPI spec (`https://developer.cartrack.com/openapi/openapi.yaml`, v1.26.0824.1) — not
guessed. See "Things to double-check with real data" at the bottom before trusting output.

## 1. Setup

```bash
npm install
cp .env.example .env   # then fill in the values below
npm run build
```

### Cartrack credentials

1. Log into Fleetweb -> Settings -> API Settings -> Generate User Credentials.
2. Set `CARTRACK_USERNAME` / `CARTRACK_PASSWORD` in `.env`.
3. `CARTRACK_BASE_URL` — confirmed from Cartrack's own docs (base-url page): Namibia has
   its own country code (`na`), so this is `https://fleetapi-na.cartrack.com/rest`
   (already set as the default in `.env.example`). Cartrack has ~26 per-country hosts total,
   all shaped `https://fleetapi-<cc>.cartrack.com/rest`.

### Google Sheets/Drive (service account — no OAuth, works unattended)

1. In Google Cloud Console: create a project (or reuse one), enable the **Google Sheets API**
   and **Google Drive API**.
2. Create a service account, generate a JSON key, save it as
   `google-service-account.json` in this folder (already gitignored).

**Important**: service accounts have **zero personal Drive storage quota** under Google's
current policy — they cannot create new files (a new Sheet, a new dated monthly `.xlsx`
export) at all unless the file lives inside a Google Workspace **Shared Drive**, where
storage is billed to the Drive rather than the account. This shows up as a
`403 "The caller does not have permission"` error that has nothing to do with API enablement
or auth being wrong — confirmed the hard way against a real project. Two paths from here,
depending on whether you have a Shared Drive available:

**Path A — you have a Shared Drive** (or can create one):

3. Google Drive -> New -> Shared Drive, e.g. "Procon Fleet Dashboard", then add the service
   account's `client_email` as a member with **Content Manager** access.
4. Grab the Shared Drive's ID from its URL when you open it
   (`drive.google.com/drive/folders/<id>`).
5. Run the setup script — creates the dashboard Sheet inside that Shared Drive, shares it
   with your own account, and pre-creates every tab:
   ```bash
   npm run setup:sheet -- <sharedDriveId> you@procongroup.co
   ```
   It prints the new Sheet's ID — set that as `GOOGLE_SHEET_ID` in `.env`.
6. For the monthly `.xlsx` export as a new dated file each month, create a folder inside the
   same Shared Drive and set `GOOGLE_EXPORT_FOLDER_ID` to its ID.

**Path B — no Shared Drive available** (e.g. Workspace access issues, or plain personal
Gmail): a human-owned file has normal storage quota, so writing rows into a Sheet *you*
already created and shared isn't "creating a file" in the quota sense — only the service
account creating a brand-new file hits the wall.

3. Create the "Procon Fleet — Live Dashboard" Sheet yourself (sheets.new), share it with the
   service account's `client_email` as **Editor**.
4. Set `GOOGLE_SHEET_ID` to that Sheet's ID (the long string in its URL).
5. Run `npm run setup:tabs` to pre-create every tab with headers.
6. For the monthly `.xlsx` export, create one placeholder `.xlsx` file yourself (any content),
   share it with the service account as Editor, and set `GOOGLE_EXPORT_FILE_ID` to its ID.
   Its content gets overwritten with the latest month's numbers each run — one recurring file
   with the latest snapshot, not a dated file per month (that trade-off is the price of not
   having a Shared Drive; switch to Path A later if that changes).

Tabs (`Vehicle Status`, `Trips`, `Fuel`, `Flags`, `Monthly Reconciliation`) are created by
either setup script; `ensureTabs()` also creates any that are still missing on every sync
run, so it's safe if you add a tab by hand later.

### Registering the MCP server with Claude Code (local/interactive use)

```bash
claude mcp add cartrack-fleet -- node "<absolute-path>/dist/server.js"
```

Claude Code will pick up `.env` if you run it from this directory, or set the four
`CARTRACK_*`/`GOOGLE_*` variables in your shell profile / MCP server config instead.

## 2. The four tools

| Tool | Cartrack endpoint(s) | Notes |
|---|---|---|
| `list_vehicles` | `GET /vehicles` | Auto-paginated. No filters by default — whole fleet. |
| `get_vehicle_status` | `GET /vehicles/status` | Live snapshot only, no date range. Rate-limited by Cartrack to 60 req/min. |
| `get_trips` | `GET /trips` (fleet) or `GET /trips/{registration}` (one vehicle) | Defaults to previous 24h. Cartrack caps each request at 31 days — longer ranges are chunked automatically. The fleet-wide endpoint has no vehicle filter at the API level; pass `registration` to query one vehicle. |
| `get_fuel_data` | `POST /fuel/consumed` + `POST /fuel/level` (bulk, ≤24h, ≤100 vehicles) or the per-vehicle `GET` equivalents (≤31 days) | Defaults to previous 24h fleet-wide, which fits the bulk endpoints in one call each. Wider ranges/single vehicle fall back to per-vehicle calls, paced to Cartrack's 10 req/min cap on the bulk endpoints. |

## 3. Test before scheduling anything

Run each tool manually first, against the real account:

```bash
npm run dev   # starts the MCP server over stdio — drive it from Claude Code, or:
```

Or call the underlying script paths directly for a quick sanity check without an MCP client —
e.g. add a throwaway `node -e` snippet importing `CartrackClient`.

Specifically confirm, before scheduling the daily Routine:

1. **Vehicle count matches Procon's actual fleet** (~41 vehicles, Electrical + Steel). If
   `list_vehicles` returns a different count, check for vehicles marked
   `is_under_maintenance` or decommissioned units still in Cartrack's system.
2. **Timestamps line up with Namibia local time (UTC+2)**. The OpenAPI spec's `date` schema
   (`"2023-01-01 12:00:00"`) carries no timezone marker — it's genuinely ambiguous from the
   spec alone whether Cartrack expects/returns UTC or each terminal's local time. Call
   `get_vehicle_status` for a vehicle you can see in person right now and compare
   `location.updated` / `event_ts` against the actual wall-clock time. If it's off by 2
   hours (or by the vehicle's DST-naive local offset), adjust `dateWindow.ts` and the
   request-building code in `cartrackClient.ts` accordingly — right now both assume the API
   wants/returns values already in local time in that plain format.
3. **A vehicle's registration format matches the Fleet Register** in the fuel tracking
   workbook exactly (Cartrack vs. the workbook sometimes differ in spacing/hyphenation) —
   this matters for `syncMonthly.ts`'s vehicle matching.

## 4. Daily Routine (cloud, ~6am Namibia time)

Namibia is UTC+2 year-round (no DST), so 6am local = **04:00 UTC**. Cron for the Routine:

```
0 4 * * *
```

The Routine's prompt should be effectively: *"Run `npm run sync:daily` in this repo and
report the console output."* Since the whole sync — Cartrack calls, flag computation, and
Sheet writes — happens inside the script (not via separate MCP tool calls from the cloud
agent), the Routine just needs `Bash` access and the environment variables below.

**Open question you'll need to resolve in the Routine's Environment settings at
claude.ai/code/routines**: this session's tools don't expose how CCR environments store
secrets (they're clearly not read from a local `.env` — cloud Routines can't see your local
filesystem or shell environment at all). Set these as environment variables on whichever
Environment the Routine uses:

```
CARTRACK_USERNAME, CARTRACK_PASSWORD, CARTRACK_BASE_URL,
GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON (or the key contents, if the environment
  only supports variables — you may need to adapt googleSheets.ts to read the key from an
  env var instead of a file path, e.g. GOOGLE_SERVICE_ACCOUNT_JSON_CONTENTS)
```

If the Environment has no secrets mechanism at all, the fallback is to commit an
*encrypted* key and decrypt it in the script with a passphrase env var — worse, and only
do it if there's truly no other option. Check the claude.ai UI first.

### What it writes

- `Vehicle Status`, `Trips`, `Fuel` — **appended**, one row per vehicle per sync, so history
  accumulates day over day.
- `Flags` — **replaced** each run (it's a snapshot of today's issues, not a log):
  - *Idle all day*: no trips in the last 24h and ignition currently off, checked only during
    work hours (07:00–17:00 local — adjust `WORK_HOURS_START`/`END` in `syncDaily.ts` if
    Procon's hours differ).
  - *No job-site match*: a trip where Cartrack matched no geofence at either end
    (`start_geofence_name`/`end_geofence_name` both empty). This only works if geofences are
    set up in Fleetweb for Procon's job sites — if none exist yet, every trip will flag, which
    isn't useful. Set up geofences first, or treat this flag as informational until then.
  - *Fuel anomaly*: today's fuel consumed deviates >50% from that vehicle's trailing 30-day
    average (needs ≥5 days of history before it starts flagging). This 50% threshold is a
    day-to-day noise filter, unrelated to the monthly 5% fleet-card tolerance below — tune
    `FUEL_ANOMALY_DEVIATION` in `syncDaily.ts` if it's too noisy or too quiet.

## 5. Monthly reconciliation

**Design choice, read before changing anything**: `syncMonthly.ts` only *reads* the master
"Procon Electrical & Steel Fleet Fuel Tracking System" workbook — it never writes to it. That
workbook's formulas, charts, and recalculation order are fragile (see the
`fleet-cost-workbook` skill's warnings about `openpyxl` and `recalc.py`), and this runs
unattended in the cloud with nobody watching a broken chart happen. So instead:

- The comparison (Cartrack litres vs. fleet-card litres/Rand per vehicle, this month) is
  written to a new **`Monthly Reconciliation`** tab in the live Google Sheet — additive,
  reversible, safe to overwrite. Re-running for the same month replaces just that month's
  rows (idempotent).
- Vehicles beyond `CARTRACK_VARIANCE_TOLERANCE` (default 5%, per your instruction) get
  `Flagged = YES`.
- If you want the numbers folded into the master workbook's actual Dashboard, that's still a
  manual step — same fleet-cost-workbook merge process as today, just with the Cartrack side
  of the comparison already computed and sitting in the Sheet ready to copy across.

**Requires the master workbook to be in Google Drive** (not just local disk) — set
`MASTER_WORKBOOK_DRIVE_FILE_ID` to its Drive file ID. A cloud Routine can't reach a file
that only exists on your machine.

**Column matching is a best-effort guess** (`readWorkbookFuelTotals` in `syncMonthly.ts`
looks for columns containing "date", "registration", "litre", and "amount"/"rand" in the
`Fuel Log` tab's header row). Check `references/workbook-structure.md` (in the fleet-cost-
workbook skill) against the actual header row before trusting this, and adjust the column-
matching if it's wrong — a silent mismatch here produces confidently wrong numbers.

Suggested schedule: monthly, a few days after the statement typically lands (adjust to
Procon's actual billing cycle) — e.g. the 5th at 6am Namibia time:

```
0 4 5 * *
```

### Monthly .xlsx export

If `GOOGLE_EXPORT_FOLDER_ID` is set, `syncMonthly.ts` exports the whole live Sheet to `.xlsx`
and uploads it to that Drive folder as `Procon Fleet — Live Dashboard - YYYY-MM.xlsx` — the
literal Excel snapshot you asked for, alongside the Sheet itself. Leave it unset to skip.

## 6. Things to double-check with real data

- **`max_speed` units** — the `/trips` schema example suggests meters/second, while the
  vehicle-level `max_speed` in `/vehicles` looks like km/h. Not used in any flag logic yet;
  verify before displaying it anywhere user-facing.
- **Trip-window overlap** — Cartrack's docs note a trip active at any point in a requested
  window is returned in full even if its own timestamps fall outside it. Don't sum
  `trip_distance` across days expecting an exact daily total; if that's ever needed, use the
  dedicated odometer endpoint instead.
- **`get_vehicle_status` has no pagination** — for a ~41-vehicle fleet this is fine, but if
  the fleet grows a lot, revisit.
