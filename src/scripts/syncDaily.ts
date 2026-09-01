#!/usr/bin/env node
/**
 * Daily sync: pulls the full Procon fleet's status, trips, and fuel data for the previous
 * 24 hours from Cartrack and appends it to the "Procon Fleet — Live Dashboard" Google Sheet.
 * Run by the daily cloud Routine (~6am Namibia time). History is appended, never overwritten;
 * the Flags tab is the exception — it's a snapshot of today's issues, so it's replaced each run.
 */
import { CartrackClient, loadConfigFromEnv } from "../cartrackClient.js";
import { SheetsWriter, loadSheetsConfigFromEnv } from "../googleSheets.js";
import { previous24HourWindow } from "../dateWindow.js";
import type { Trip, VehicleStatus, FuelConsumed, FuelLevel } from "../types.js";

const TABS = {
  "Vehicle Status": ["Date", "Registration", "Vehicle ID", "Ignition", "Idling", "Speed (km/h)", "Odometer (km)", "Fuel %", "Fuel (L)", "Latitude", "Longitude", "Position", "Event Time"],
  Trips: ["Date", "Registration", "Trip ID", "Start", "End", "Start Location", "End Location", "Distance (km)", "Duration (min)", "Idle (min)", "Harsh Braking", "Harsh Cornering", "Harsh Accel", "Speeding Events", "Start Geofence", "End Geofence", "Driver"],
  Fuel: ["Date", "Registration", "Vehicle ID", "Fuel Consumed (L)", "Level Start (L)", "Level End (L)", "Estimated Used (L)", "Calibrated"],
  Flags: ["Type", "Registration", "Detail"],
};

const WORK_HOURS_START = 7; // local hour, 07:00
const WORK_HOURS_END = 17; // local hour, 17:00
const FUEL_ANOMALY_DEVIATION = 0.5; // flag if today's litres deviate >50% from the vehicle's trailing average
// Off by default: confirmed live against Procon's account that no geofences are set up in
// Fleetweb yet, so this flags literally every trip (239/245 flags on the first real run) —
// pure noise that drowns out the flags that are actually useful. Set to "true" once job-site
// geofences exist in Fleetweb.
const ENABLE_GEOFENCE_FLAG = process.env.ENABLE_GEOFENCE_FLAG === "true";

async function main() {
  const cartrack = new CartrackClient(loadConfigFromEnv());
  const sheet = new SheetsWriter(loadSheetsConfigFromEnv());
  await sheet.ensureTabs(TABS);

  const { start, end } = previous24HourWindow();
  const today = end.slice(0, 10);
  console.log(`Syncing Cartrack data for ${start} -> ${end}`);

  const vehicles = await cartrack.listVehicles();
  const registrations = vehicles.map((v) => v.registration);
  console.log(`Fleet size: ${vehicles.length} vehicles`);

  const [statuses, trips, fuel] = await Promise.all([
    cartrack.getVehicleStatus({ odometerInKm: true }),
    cartrack.getTrips({ startTimestamp: start, endTimestamp: end }),
    cartrack.getFuelData({ startTimestamp: start, endTimestamp: end, registrations }),
  ]);

  await writeVehicleStatus(sheet, today, statuses);
  await writeTrips(sheet, today, trips);
  await writeFuel(sheet, today, fuel.consumed, fuel.level);

  const flags = await computeFlags(sheet, today, vehicles.map((v) => v.registration), statuses, trips, fuel.consumed);
  await sheet.clearBelowHeader("Flags");
  await sheet.appendRows("Flags", flags.map((f) => [f.type, f.registration, f.detail]));

  console.log(
    `Done. Vehicle Status: ${statuses.length} rows. Trips: ${trips.length} rows. Fuel: ${fuel.consumed.length} rows. Flags: ${flags.length}.`,
  );
}

async function writeVehicleStatus(sheet: SheetsWriter, date: string, statuses: VehicleStatus[]) {
  const rows = statuses.map((s) => [
    date,
    s.registration,
    s.vehicle_id,
    s.ignition ?? "",
    s.idling ?? "",
    s.speed ?? "",
    s.odometer ?? "",
    s.fuel?.precentage_left ?? s.fuel?.percentage_left ?? "",
    s.fuel?.level ?? "",
    s.location?.latitude ?? "",
    s.location?.longitude ?? "",
    s.location?.position_description ?? "",
    s.event_ts ?? "",
  ]);
  await sheet.appendRows("Vehicle Status", rows);
}

async function writeTrips(sheet: SheetsWriter, date: string, trips: Trip[]) {
  const rows = trips.map((t) => [
    date,
    t.registration,
    t.trip_id,
    t.start_timestamp,
    t.end_timestamp,
    t.start_location ?? "",
    t.end_location ?? "",
    t.trip_distance ? (t.trip_distance / 1000).toFixed(2) : "",
    t.trip_duration_seconds ? (t.trip_duration_seconds / 60).toFixed(1) : "",
    t.idle_time_seconds ? (t.idle_time_seconds / 60).toFixed(1) : "",
    t.harsh_braking_events ?? 0,
    t.harsh_cornering_events ?? 0,
    t.harsh_acceleration_events ?? 0,
    (t.thresholds_speeding_events ?? 0) + (t.road_speeding_events ?? 0),
    t.start_geofence_name ?? "",
    t.end_geofence_name ?? "",
    [t.driver_name, t.driver_surname].filter(Boolean).join(" "),
  ]);
  await sheet.appendRows("Trips", rows);
}

async function writeFuel(sheet: SheetsWriter, date: string, consumed: FuelConsumed[], level: FuelLevel[]) {
  const levelByReg = new Map(level.map((l) => [l.registration, l]));
  const rows = consumed.map((c) => {
    const l = levelByReg.get(c.registration);
    return [
      date,
      c.registration,
      c.vehicle_id,
      c.fuel_consumed ?? "",
      l?.start_period?.liters ?? "",
      l?.end_period?.liters ?? "",
      l?.estimated_fuel_used ?? "",
      l?.calibrated ?? "",
    ];
  });
  await sheet.appendRows("Fuel", rows);
}

interface Flag {
  type: string;
  registration: string;
  detail: string;
}

async function computeFlags(
  sheet: SheetsWriter,
  date: string,
  allRegistrations: string[],
  statuses: VehicleStatus[],
  trips: Trip[],
  consumed: FuelConsumed[],
): Promise<Flag[]> {
  const flags: Flag[] = [];

  // 1. Idle all day during work hours: no trips today, and currently not moving.
  const registrationsWithTrips = new Set(trips.map((t) => t.registration));
  const statusByReg = new Map(statuses.map((s) => [s.registration, s]));
  const nowHourLocal = new Date(Date.now() + 120 * 60_000).getUTCHours();
  if (nowHourLocal >= WORK_HOURS_START && nowHourLocal <= WORK_HOURS_END) {
    for (const reg of allRegistrations) {
      const s = statusByReg.get(reg);
      if (!registrationsWithTrips.has(reg) && s && s.ignition === false) {
        flags.push({ type: "Idle all day", registration: reg, detail: "No trips in the last 24h and ignition currently off during work hours." });
      }
    }
  }

  // 2. Trips with no obvious job-site match (no geofence matched at either end).
  //    Requires geofences to actually exist in Fleetweb — see ENABLE_GEOFENCE_FLAG above.
  if (ENABLE_GEOFENCE_FLAG) {
    for (const t of trips) {
      const startGeo = t.start_geofence_name;
      const endGeo = t.end_geofence_name;
      if (!startGeo && !endGeo) {
        flags.push({ type: "No job-site match", registration: t.registration, detail: `Trip ${t.trip_id} (${t.start_timestamp} -> ${t.end_timestamp}) matched no geofence at either end.` });
      }
    }
  }

  // 3. Fuel readings that look off vs that vehicle's own recent average (trailing 30 days from the Sheet).
  const history = await sheet.readRange("Fuel!A2:D100000");
  const historyByReg = new Map<string, number[]>();
  for (const row of history) {
    const [rowDate, reg, , litresStr] = row;
    if (!reg || !litresStr || rowDate === date) continue;
    const litres = Number(litresStr);
    if (!Number.isFinite(litres)) continue;
    if (!historyByReg.has(reg)) historyByReg.set(reg, []);
    historyByReg.get(reg)!.push(litres);
  }
  for (const c of consumed) {
    const past = (historyByReg.get(c.registration) ?? []).slice(-30);
    if (past.length < 5) continue; // not enough history to judge yet
    const avg = past.reduce((a, b) => a + b, 0) / past.length;
    if (avg <= 0) continue;
    const deviation = Math.abs(c.fuel_consumed - avg) / avg;
    if (deviation > FUEL_ANOMALY_DEVIATION) {
      flags.push({
        type: "Fuel anomaly",
        registration: c.registration,
        detail: `Today: ${c.fuel_consumed.toFixed(1)}L vs ${past.length}-day average ${avg.toFixed(1)}L (${(deviation * 100).toFixed(0)}% deviation).`,
      });
    }
  }

  return flags;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
