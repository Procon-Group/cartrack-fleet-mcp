#!/usr/bin/env node
/**
 * Monthly reconciliation: compares Cartrack-metered fuel litres per vehicle against the
 * litres/Rand already recorded in the master fleet-card workbook for the same month, and
 * flags vehicles where they disagree beyond CARTRACK_VARIANCE_TOLERANCE (default 5%).
 *
 * Deliberate design choice — read the full explanation in README.md "Monthly reconciliation":
 * this script only READS the master "Procon Electrical & Steel Fleet Fuel Tracking System"
 * workbook. It never writes to it. The workbook's formulas, chart XML, and recalculation
 * order are fragile (see fleet-cost-workbook skill) and this runs unattended in the cloud
 * with nobody watching — an in-place edit that silently corrupts a chart or formula could go
 * unnoticed for months. Instead, the reconciliation result is written to a new
 * "Monthly Reconciliation" tab in the live Google Sheet (safe, additive, fully reversible),
 * and folded into the monthly .xlsx export. Moving the numbers into the master workbook's own
 * Dashboard stays a manual step, same as the rest of the monthly merge process.
 *
 * Requires the master workbook to be readable from Google Drive (MASTER_WORKBOOK_DRIVE_FILE_ID) —
 * a cloud Routine cannot read a file that only exists on a local disk.
 */
import ExcelJS from "exceljs";
import { CartrackClient, loadConfigFromEnv } from "../cartrackClient.js";
import {
  SheetsWriter,
  loadSheetsConfigFromEnv,
  downloadDriveFile,
  exportSpreadsheetToXlsxBuffer,
  uploadFileToDriveFolder,
  overwriteDriveFileContent,
} from "../googleSheets.js";

const TOLERANCE = Number(process.env.CARTRACK_VARIANCE_TOLERANCE ?? "0.05");
const RECON_TAB = "Monthly Reconciliation";
const RECON_HEADER = ["Month", "Registration", "Cartrack Litres", "Fleet Card Litres", "Fleet Card Rand", "Litres Variance %", "Flagged"];

function targetMonth(): { year: number; month: number; label: string; start: string; end: string } {
  const arg = process.argv[2]; // optional "YYYY-MM" override
  const now = new Date();
  let year: number, month: number; // month is 1-12
  if (arg && /^\d{4}-\d{2}$/.test(arg)) {
    [year, month] = arg.split("-").map(Number);
  } else {
    // Default: the previous calendar month (statement for month M typically lands in M+1).
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    year = prev.getUTCFullYear();
    month = prev.getUTCMonth() + 1;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    year,
    month,
    label: `${year}-${pad(month)}`,
    start: `${year}-${pad(month)}-01 00:00:00`,
    end: `${year}-${pad(month)}-${pad(daysInMonth)} 23:59:59`,
  };
}

async function readWorkbookFuelTotals(fileId: string, sheets: SheetsWriter, monthLabel: string): Promise<Map<string, { litres: number; rand: number }>> {
  const config = loadSheetsConfigFromEnv();
  const buffer = await downloadDriveFile(config, fileId);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const fuelLog = workbook.getWorksheet("Fuel Log");
  if (!fuelLog) throw new Error('Master workbook has no "Fuel Log" tab — check MASTER_WORKBOOK_DRIVE_FILE_ID and the tab name.');

  const headerRow = fuelLog.getRow(1).values as unknown[];
  const colIndex = (name: string) => headerRow.findIndex((h) => typeof h === "string" && h.toLowerCase().includes(name.toLowerCase()));
  const dateCol = colIndex("date");
  const regCol = colIndex("registration");
  const litresCol = colIndex("litre");
  const randCol = colIndex("amount") >= 0 ? colIndex("amount") : colIndex("rand");

  if (dateCol < 0 || regCol < 0 || litresCol < 0 || randCol < 0) {
    throw new Error(
      `Could not find expected columns in Fuel Log (found date=${dateCol}, registration=${regCol}, litres=${litresCol}, rand=${randCol}). ` +
        "Check references/workbook-structure.md for the current column layout and adjust readWorkbookFuelTotals().",
    );
  }

  const totals = new Map<string, { litres: number; rand: number }>();
  fuelLog.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const rawDate = row.getCell(dateCol).value;
    const rowMonth = toMonthLabel(rawDate);
    if (rowMonth !== monthLabel) return;
    const registration = String(row.getCell(regCol).value ?? "").trim();
    if (!registration) return;
    const litres = Number(row.getCell(litresCol).value ?? 0);
    const rand = Number(row.getCell(randCol).value ?? 0);
    const existing = totals.get(registration) ?? { litres: 0, rand: 0 };
    existing.litres += Number.isFinite(litres) ? litres : 0;
    existing.rand += Number.isFinite(rand) ? rand : 0;
    totals.set(registration, existing);
  });
  return totals;
}

function toMonthLabel(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function main() {
  const masterFileId = process.env.MASTER_WORKBOOK_DRIVE_FILE_ID;
  if (!masterFileId) {
    throw new Error(
      "Set MASTER_WORKBOOK_DRIVE_FILE_ID to the Google Drive file ID of the master fleet workbook " +
        "(upload/sync it to Drive first — a cloud Routine can't read a purely local file).",
    );
  }

  const { label, start, end } = targetMonth();
  console.log(`Reconciling ${label} (Cartrack window ${start} -> ${end})`);

  const cartrack = new CartrackClient(loadConfigFromEnv());
  const sheetsConfig = loadSheetsConfigFromEnv();
  const sheet = new SheetsWriter(sheetsConfig);
  await sheet.ensureTabs({ [RECON_TAB]: RECON_HEADER });

  const vehicles = await cartrack.listVehicles();
  const cardTotals = await readWorkbookFuelTotals(masterFileId, sheet, label);

  const rows: (string | number)[][] = [];
  let flaggedCount = 0;

  for (const vehicle of vehicles) {
    const card = cardTotals.get(vehicle.registration);
    if (!card) continue; // vehicle not in this month's fleet-card statement — nothing to reconcile

    const fuel = await cartrack.getFuelData({ startTimestamp: start, endTimestamp: end, registrations: [vehicle.registration] });
    const cartrackLitres = fuel.consumed.reduce((sum, c) => sum + (c.fuel_consumed ?? 0), 0);

    const variance = cartrackLitres > 0 ? Math.abs(card.litres - cartrackLitres) / cartrackLitres : card.litres > 0 ? 1 : 0;
    const flagged = variance > TOLERANCE;
    if (flagged) flaggedCount += 1;

    rows.push([label, vehicle.registration, Number(cartrackLitres.toFixed(1)), Number(card.litres.toFixed(1)), Number(card.rand.toFixed(2)), Number((variance * 100).toFixed(1)), flagged ? "YES" : ""]);
  }

  // Replace this month's rows if the script has already run for this label (idempotent re-runs).
  const existing = await sheet.readRange(`${RECON_TAB}!A2:G100000`);
  const keep = existing.filter((r) => r[0] !== label);
  await sheet.overwriteRange(`${RECON_TAB}!A2`, [...keep, ...rows]);

  console.log(`Reconciled ${rows.length} vehicles for ${label}. Flagged (>${(TOLERANCE * 100).toFixed(0)}% variance): ${flaggedCount}.`);

  const exportFolderId = process.env.GOOGLE_EXPORT_FOLDER_ID; // Shared Drive folder — a new dated file per month
  const exportFileId = process.env.GOOGLE_EXPORT_FILE_ID; // fallback: one recurring file, content overwritten each month
  if (exportFolderId) {
    const buffer = await exportSpreadsheetToXlsxBuffer(sheetsConfig);
    const fileName = `Procon Fleet — Live Dashboard - ${label}.xlsx`;
    const link = await uploadFileToDriveFolder(
      sheetsConfig,
      exportFolderId,
      fileName,
      buffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    console.log(`Monthly .xlsx export uploaded: ${fileName} -> ${link}`);
  } else if (exportFileId) {
    const buffer = await exportSpreadsheetToXlsxBuffer(sheetsConfig);
    const link = await overwriteDriveFileContent(
      sheetsConfig,
      exportFileId,
      buffer,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    console.log(`Monthly .xlsx export overwritten (${label} snapshot) -> ${link}`);
  } else {
    console.log("Neither GOOGLE_EXPORT_FOLDER_ID nor GOOGLE_EXPORT_FILE_ID set — skipping monthly .xlsx export.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
