#!/usr/bin/env node
/**
 * One-time setup: creates the "Procon Fleet — Live Dashboard" Google Sheet inside a Shared
 * Drive, shares it with a real Google account too (nice-to-have — Shared Drive membership
 * already covers access, but an explicit share also surfaces it in "Shared with me"), and
 * pre-creates all the tabs syncDaily/syncMonthly expect.
 *
 * Must target a Shared Drive: service accounts have zero personal Drive storage quota
 * (Google's current policy), so `sheets.spreadsheets.create` — which creates the file under
 * the service account's own Drive — fails with a 403 "caller does not have permission" that
 * has nothing to do with API enablement or auth. Creating inside a Shared Drive works because
 * storage there is billed to the Drive, not the creating account.
 *
 * Before running: create a Shared Drive in Google Drive (New -> Shared Drive), add the
 * service account's client_email as a member with "Content Manager" access, and grab the
 * Drive's ID from its URL (drive.google.com/drive/folders/<id> when you open it).
 *
 * Usage: node dist/scripts/setupDashboardSheet.js <sharedDriveId> <your-email@procongroup.co>
 */
import { readFileSync } from "node:fs";
import { google } from "googleapis";
import { SheetsWriter } from "../googleSheets.js";

const TABS = {
  "Vehicle Status": ["Date", "Registration", "Vehicle ID", "Ignition", "Idling", "Speed (km/h)", "Odometer (km)", "Fuel %", "Fuel (L)", "Latitude", "Longitude", "Position", "Event Time"],
  Trips: ["Date", "Registration", "Trip ID", "Start", "End", "Start Location", "End Location", "Distance (km)", "Duration (min)", "Idle (min)", "Harsh Braking", "Harsh Cornering", "Harsh Accel", "Speeding Events", "Start Geofence", "End Geofence", "Driver"],
  Fuel: ["Date", "Registration", "Vehicle ID", "Fuel Consumed (L)", "Level Start (L)", "Level End (L)", "Estimated Used (L)", "Calibrated"],
  Flags: ["Type", "Registration", "Detail"],
  "Monthly Reconciliation": ["Month", "Registration", "Cartrack Litres", "Fleet Card Litres", "Fleet Card Rand", "Litres Variance %", "Flagged"],
};

async function main() {
  const sharedDriveId = process.argv[2];
  const shareWithEmail = process.argv[3];
  if (!sharedDriveId || !shareWithEmail) {
    throw new Error("Usage: node dist/scripts/setupDashboardSheet.js <sharedDriveId> <your-email@procongroup.co>");
  }

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "./google-service-account.json";
  const key = JSON.parse(readFileSync(keyPath, "utf-8"));
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const drive = google.drive({ version: "v3", auth });

  console.log(`Creating spreadsheet inside Shared Drive ${sharedDriveId}...`);
  const created = await drive.files.create({
    requestBody: {
      name: "Procon Fleet — Live Dashboard",
      mimeType: "application/vnd.google-apps.spreadsheet",
      parents: [sharedDriveId],
    },
    supportsAllDrives: true,
    fields: "id",
  });
  const spreadsheetId = created.data.id!;
  console.log(`Created: ${spreadsheetId}`);

  console.log(`Sharing with ${shareWithEmail} as writer...`);
  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: { type: "user", role: "writer", emailAddress: shareWithEmail },
    sendNotificationEmail: true,
    supportsAllDrives: true,
  });

  console.log("Creating tabs...");
  const writer = new SheetsWriter({ spreadsheetId, serviceAccountKeyPath: keyPath });
  await writer.ensureTabs(TABS);

  // The default "Sheet1" tab is left over from creation — remove it now that real tabs exist.
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const defaultSheet = (meta.data.sheets ?? []).find((s) => s.properties?.title === "Sheet1");
  if (defaultSheet?.properties?.sheetId !== undefined) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ deleteSheet: { sheetId: defaultSheet.properties.sheetId } }] },
    });
  }

  console.log(`\nDone. GOOGLE_SHEET_ID=${spreadsheetId}`);
  console.log(`Open: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
