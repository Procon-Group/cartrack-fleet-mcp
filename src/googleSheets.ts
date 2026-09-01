import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { google, sheets_v4 } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive.file"];

export interface SheetsConfig {
  spreadsheetId: string;
  serviceAccountKeyPath: string;
}

export function loadSheetsConfigFromEnv(): SheetsConfig {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const serviceAccountKeyPath = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!spreadsheetId || !serviceAccountKeyPath) {
    throw new Error(
      "Missing Google Sheets config. Set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON (see .env.example). " +
        "The target Sheet must be shared with the service account's client_email as Editor.",
    );
  }
  return { spreadsheetId, serviceAccountKeyPath };
}

export class SheetsWriter {
  private sheets: sheets_v4.Sheets;
  private tabIdCache = new Map<string, number>();

  constructor(private config: SheetsConfig) {
    const key = JSON.parse(readFileSync(config.serviceAccountKeyPath, "utf-8"));
    const auth = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: SCOPES,
    });
    this.sheets = google.sheets({ version: "v4", auth });
  }

  /** Creates any missing tabs (with a header row) and returns sheetId per tab name. */
  async ensureTabs(tabs: Record<string, string[]>): Promise<void> {
    const meta = await this.sheets.spreadsheets.get({ spreadsheetId: this.config.spreadsheetId });
    const existing = new Map((meta.data.sheets ?? []).map((s) => [s.properties?.title ?? "", s.properties?.sheetId ?? 0]));
    for (const [title, id] of existing) this.tabIdCache.set(title, id);

    const toCreate = Object.keys(tabs).filter((t) => !existing.has(t));
    if (toCreate.length > 0) {
      const resp = await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.config.spreadsheetId,
        requestBody: { requests: toCreate.map((title) => ({ addSheet: { properties: { title } } })) },
      });
      for (const reply of resp.data.replies ?? []) {
        const props = reply.addSheet?.properties;
        if (props?.title) this.tabIdCache.set(props.title, props.sheetId ?? 0);
      }
      for (const title of toCreate) {
        await this.overwriteRange(`${title}!A1`, [tabs[title]]);
      }
    }
  }

  async appendRows(tabName: string, rows: (string | number | boolean | null)[][]): Promise<void> {
    if (rows.length === 0) return;
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.config.spreadsheetId,
      range: `${tabName}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
  }

  async overwriteRange(range: string, rows: (string | number | boolean | null)[][]): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.config.spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });
  }

  async readRange(range: string): Promise<string[][]> {
    const resp = await this.sheets.spreadsheets.values.get({ spreadsheetId: this.config.spreadsheetId, range });
    return (resp.data.values as string[][] | undefined) ?? [];
  }

  /** Clears a tab's contents below the header row (row 1), keeping the header. */
  async clearBelowHeader(tabName: string): Promise<void> {
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.config.spreadsheetId,
      range: `${tabName}!A2:ZZ`,
    });
  }
}

function driveAuth(config: SheetsConfig, scopes: string[]) {
  const key = JSON.parse(readFileSync(config.serviceAccountKeyPath, "utf-8"));
  return new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes });
}

/**
 * Exports the whole spreadsheet to .xlsx bytes via the Drive export endpoint.
 * `supportsAllDrives` is required on every Drive v3 call below that touches a Shared Drive
 * item — service accounts have zero personal Drive storage quota (Google's current policy),
 * so anything they read/write/create has to live in a Shared Drive, and Drive v3 silently
 * excludes Shared Drive items from calls missing this flag rather than erroring clearly.
 */
export async function exportSpreadsheetToXlsxBuffer(config: SheetsConfig): Promise<Buffer> {
  const drive = google.drive({ version: "v3", auth: driveAuth(config, ["https://www.googleapis.com/auth/drive.readonly"]) });
  const res = await drive.files.export(
    { fileId: config.spreadsheetId, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

/**
 * Uploads a buffer as a new file in a Drive folder — used for the monthly .xlsx export
 * (a cloud Routine's local filesystem isn't visible to the user afterward, so the export
 * has to land in Drive, not disk). The folder MUST be inside a Shared Drive — creating a new
 * file as a service account fails outside one (zero storage quota), even in a folder a human
 * owns and has shared with it.
 */
export async function uploadFileToDriveFolder(
  config: SheetsConfig,
  folderId: string,
  fileName: string,
  content: Buffer,
  mimeType: string,
): Promise<string> {
  const drive = google.drive({ version: "v3", auth: driveAuth(config, ["https://www.googleapis.com/auth/drive.file"]) });
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: bufferToStream(content) },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });
  return res.data.webViewLink ?? res.data.id ?? "";
}

/** Downloads a Drive file's raw bytes (used to read the master fleet workbook, read-only). */
export async function downloadDriveFile(config: SheetsConfig, fileId: string): Promise<Buffer> {
  const drive = google.drive({ version: "v3", auth: driveAuth(config, ["https://www.googleapis.com/auth/drive.readonly"]) });
  const res = await drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
  return Buffer.from(res.data as ArrayBuffer);
}

function bufferToStream(buffer: Buffer) {
  return Readable.from(buffer);
}
