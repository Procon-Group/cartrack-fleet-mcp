#!/usr/bin/env node
/**
 * Combines template-base.html + existing-fleet-data.json + generated-cartrack-data.json +
 * logo.png into the final, publish-ready dashboard HTML. Run `node dist/scripts/generateDashboard.js`
 * first to produce a fresh generated-cartrack-data.json.
 *
 * Usage: node dashboard/build.mjs [outputPath]  (defaults to dashboard/preview.html)
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const outputPath = process.argv[2] ?? path.join(DIR, "preview.html");

const template = readFileSync(path.join(DIR, "template-base.html"), "utf-8");
const fleetData = readFileSync(path.join(DIR, "existing-fleet-data.json"), "utf-8");
const cartrackData = readFileSync(path.join(DIR, "generated-cartrack-data.json"), "utf-8");
const logoUri = "data:image/png;base64," + readFileSync(path.join(DIR, "logo.png")).toString("base64");

const out = template
  .replace("__FLEET_DATA_JSON__", () => fleetData)
  .replace("__CARTRACK_DATA_JSON__", () => cartrackData)
  .replace("__LOGO_DATA_URI__", () => logoUri);

writeFileSync(outputPath, out);
console.log(`Wrote ${outputPath} (${(out.length / 1024).toFixed(0)} KB)`);
