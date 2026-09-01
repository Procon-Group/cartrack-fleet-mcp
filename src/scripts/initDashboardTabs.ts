#!/usr/bin/env node
/**
 * For when there's no Shared Drive available: you create the "Procon Fleet — Live Dashboard"
 * Sheet yourself (sheets.new), share it with the service account's client_email as Editor,
 * set GOOGLE_SHEET_ID in .env to its ID, then run this to pre-create every tab with headers.
 * (syncDaily/syncMonthly also call ensureTabs() themselves, so this is a convenience, not a
 * strict prerequisite — but it's a good first connectivity check before scheduling anything.)
 */
import { SheetsWriter, loadSheetsConfigFromEnv } from "../googleSheets.js";

const TABS = {
  "Vehicle Status": ["Date", "Registration", "Vehicle ID", "Ignition", "Idling", "Speed (km/h)", "Odometer (km)", "Fuel %", "Fuel (L)", "Latitude", "Longitude", "Position", "Event Time"],
  Trips: ["Date", "Registration", "Trip ID", "Start", "End", "Start Location", "End Location", "Distance (km)", "Duration (min)", "Idle (min)", "Harsh Braking", "Harsh Cornering", "Harsh Accel", "Speeding Events", "Start Geofence", "End Geofence", "Driver"],
  Fuel: ["Date", "Registration", "Vehicle ID", "Fuel Consumed (L)", "Level Start (L)", "Level End (L)", "Estimated Used (L)", "Calibrated"],
  Flags: ["Type", "Registration", "Detail"],
  "Monthly Reconciliation": ["Month", "Registration", "Cartrack Litres", "Fleet Card Litres", "Fleet Card Rand", "Litres Variance %", "Flagged"],
};

async function main() {
  const config = loadSheetsConfigFromEnv();
  const writer = new SheetsWriter(config);
  console.log(`Ensuring tabs on spreadsheet ${config.spreadsheetId}...`);
  await writer.ensureTabs(TABS);
  console.log("Done.");
  console.log(`Open: https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/edit`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
