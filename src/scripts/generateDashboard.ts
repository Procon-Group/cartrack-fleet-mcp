#!/usr/bin/env node
/**
 * Builds the data for the redesigned "Procon Fleet Fuel Dashboard" artifact's new tabs
 * (Live Status, Trip History, Cartrack Overview, Cost/KM Reconciliation) and injects it,
 * alongside the existing fleet-card financial data (passed through unchanged), into the
 * HTML template — producing the final page ready to publish as an Artifact.
 *
 * Deliberately pulls fresh from the Cartrack API for each tab's actual window (30-day trips,
 * live status, target month) rather than depending on the daily Sheet's accumulated history —
 * Cartrack itself retains ~5 years of history, so this gives complete data immediately instead
 * of waiting weeks for the Sheet to accumulate a full 30-day window.
 *
 * Usage: node dist/scripts/generateDashboard.js [outputPath]
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CartrackClient, loadConfigFromEnv } from "../cartrackClient.js";
import { findByPlate, normalizePlate } from "../plateMatch.js";
import type { Vehicle, VehicleStatus, Trip } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.resolve(__dirname, "../../dashboard");

const OVERVIEW_WINDOW_DAYS = 30;
const COST_PER_KM_TOLERANCE = 0.15; // 15% deviation flags a vehicle (distinct from the 5% litres tolerance)

interface FleetCardVehicle {
  id: string;
  division: string;
  vehicle: string;
  reg: string;
  driver: string;
  type: string;
  tracked: string;
  limit: number;
  notes: string | null;
  allTimeLitres: number;
  allTimeFuelCost: number;
  allTimeOtherCost: number;
  km: number;
  costPerKm: number;
}

interface FuelTxn {
  d: string; // date
  r: string; // registration
  dr: string; // driver
  l: number; // litres
  c: number; // cost/Rand
  o: number | null; // odometer
  v: string; // vehicle model
  dv: string; // division
  p: number | null; // price/litre
  m: string; // month "YYYY-MM"
  s: string; // source
  n: string; // note
}

interface ExistingFleetData {
  vehicles: Record<string, FleetCardVehicle>;
  order: string[];
  months: string[];
  fuel: FuelTxn[];
  [key: string]: unknown;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toCartrackTs(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function monthWindow(label: string): { start: string; end: string } {
  const [y, m] = label.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${label}-01 00:00:00`, end: `${label}-${pad(days)} 23:59:59` };
}

function prevMonthLabel(label: string, back: number): string {
  const [y, m] = label.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

async function main() {
  const outputPath = process.argv[2] ?? path.join(DASHBOARD_DIR, "generated-cartrack-data.json");

  const existing: ExistingFleetData = JSON.parse(readFileSync(path.join(DASHBOARD_DIR, "existing-fleet-data.json"), "utf-8"));
  const cartrack = new CartrackClient(loadConfigFromEnv());

  console.log("Fetching Cartrack vehicles + live status...");
  const vehicles = await cartrack.listVehicles();
  const statuses = await cartrack.getVehicleStatus({ odometerInKm: true });
  const statusByReg = new Map(statuses.map((s) => [s.registration, s]));

  console.log(`Fetching last ${OVERVIEW_WINDOW_DAYS} days of trips for ${vehicles.length} vehicles...`);
  const now = new Date();
  const windowStart = new Date(now.getTime() - OVERVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const allTrips: Trip[] = [];
  for (const v of vehicles) {
    const trips = await cartrack.getTrips({
      startTimestamp: toCartrackTs(windowStart),
      endTimestamp: toCartrackTs(now),
      registration: v.registration,
    });
    allTrips.push(...trips);
  }
  console.log(`  -> ${allTrips.length} trips in the window.`);

  // ---- Coverage: which of the existing fleet-card vehicles has a Cartrack match ----
  const cartrackByPlate = new Map(vehicles.map((v) => [v.registration, v]));
  const coverage: Record<string, { covered: boolean; cartrackReg?: string }> = {};
  for (const reg of existing.order) {
    const match = vehicles.find((v) => normalizePlate(v.registration).endsWith(normalizePlate(reg)) || normalizePlate(v.registration) === normalizePlate(reg));
    coverage[reg] = match ? { covered: true, cartrackReg: match.registration } : { covered: false };
  }

  // ---- Live Status ----
  const liveStatus = vehicles.map((v) => {
    const s = statusByReg.get(v.registration);
    const fuelPct = (s?.fuel as any)?.precentage_left ?? (s?.fuel as any)?.percentage_left ?? null;
    const hasRecentTrip = allTrips.some((t) => t.registration === v.registration && new Date(t.start_timestamp.replace(" ", "T") + "Z").getTime() > now.getTime() - 24 * 60 * 60 * 1000);
    return {
      reg: v.registration,
      manufacturer: v.manufacturer ?? "",
      model: v.model ?? "",
      ignition: s?.ignition ?? null,
      idling: s?.idling ?? null,
      speedKph: s?.speed ?? null,
      odometerKm: s?.odometer ?? null,
      fuelPct,
      lat: s?.location?.latitude ?? null,
      lng: s?.location?.longitude ?? null,
      position: s?.location?.position_description ?? null,
      updated: s?.event_ts ?? null,
      idleAllDay: !hasRecentTrip && s?.ignition === false,
    };
  });

  // ---- Trip History (most recent first, capped for page size) ----
  const tripHistory = [...allTrips]
    .sort((a, b) => (a.start_timestamp < b.start_timestamp ? 1 : -1))
    .slice(0, 500)
    .map((t) => ({
      reg: t.registration,
      tripId: t.trip_id,
      start: t.start_timestamp,
      end: t.end_timestamp,
      startLocation: t.start_location ?? "",
      endLocation: t.end_location ?? "",
      distanceKm: t.trip_distance ? Number((t.trip_distance / 1000).toFixed(1)) : 0,
      durationMin: t.trip_duration_seconds ? Number((t.trip_duration_seconds / 60).toFixed(1)) : 0,
      idleMin: t.idle_time_seconds ? Number((t.idle_time_seconds / 60).toFixed(1)) : 0,
      harshBraking: t.harsh_braking_events ?? 0,
      harshCornering: t.harsh_cornering_events ?? 0,
      harshAccel: t.harsh_acceleration_events ?? 0,
      roadSpeedingEvents: t.road_speeding_events ?? 0,
      roadSpeedingDurationMin: t.road_speeding_duration_seconds ? Number((t.road_speeding_duration_seconds / 60).toFixed(1)) : 0,
      thresholdSpeedingEvents: t.thresholds_speeding_events ?? 0,
      thresholdSpeedingDurationMin: t.thresholds_speeding_duration_seconds ? Number((t.thresholds_speeding_duration_seconds / 60).toFixed(1)) : 0,
      maxSpeed: t.max_speed ?? null,
      driver: [t.driver_name, t.driver_surname].filter(Boolean).join(" "),
    }));

  // ---- Cartrack Overview widgets ----
  const harshByDriver = new Map<string, { accel: number; braking: number; cornering: number }>();
  const idleVsDriving = new Map<string, { idleSec: number; drivingSec: number; tripCount: number }>();
  const dailyActivity = new Map<string, Set<string>>(); // reg -> set of "YYYY-MM-DD" with a trip
  const speedingByVehicle = new Map<string, { roadEvents: number; roadSec: number; thresholdEvents: number; thresholdSec: number; maxSpeed: number; tripsOverLimit: number }>();
  const speedingByDriver = new Map<string, { roadEvents: number; thresholdEvents: number; tripsOverLimit: number }>();

  for (const t of allTrips) {
    const driver = [t.driver_name, t.driver_surname].filter(Boolean).join(" ");
    if (driver) {
      const h = harshByDriver.get(driver) ?? { accel: 0, braking: 0, cornering: 0 };
      h.accel += t.harsh_acceleration_events ?? 0;
      h.braking += t.harsh_braking_events ?? 0;
      h.cornering += t.harsh_cornering_events ?? 0;
      harshByDriver.set(driver, h);
    }
    const iv = idleVsDriving.get(t.registration) ?? { idleSec: 0, drivingSec: 0, tripCount: 0 };
    iv.idleSec += t.idle_time_seconds ?? 0;
    iv.drivingSec += (t.trip_duration_seconds ?? 0) - (t.idle_time_seconds ?? 0);
    iv.tripCount += 1;
    idleVsDriving.set(t.registration, iv);

    const day = t.start_timestamp.slice(0, 10);
    if (!dailyActivity.has(t.registration)) dailyActivity.set(t.registration, new Set());
    dailyActivity.get(t.registration)!.add(day);

    const roadEvents = t.road_speeding_events ?? 0;
    const thresholdEvents = t.thresholds_speeding_events ?? 0;
    const sv = speedingByVehicle.get(t.registration) ?? { roadEvents: 0, roadSec: 0, thresholdEvents: 0, thresholdSec: 0, maxSpeed: 0, tripsOverLimit: 0 };
    sv.roadEvents += roadEvents;
    sv.roadSec += t.road_speeding_duration_seconds ?? 0;
    sv.thresholdEvents += thresholdEvents;
    sv.thresholdSec += t.thresholds_speeding_duration_seconds ?? 0;
    sv.maxSpeed = Math.max(sv.maxSpeed, t.max_speed ?? 0);
    if (roadEvents > 0 || thresholdEvents > 0) sv.tripsOverLimit += 1;
    speedingByVehicle.set(t.registration, sv);

    if (driver) {
      const sd = speedingByDriver.get(driver) ?? { roadEvents: 0, thresholdEvents: 0, tripsOverLimit: 0 };
      sd.roadEvents += roadEvents;
      sd.thresholdEvents += thresholdEvents;
      if (roadEvents > 0 || thresholdEvents > 0) sd.tripsOverLimit += 1;
      speedingByDriver.set(driver, sd);
    }
  }

  const topDriversByHarshEvents = [...harshByDriver.entries()]
    .map(([driver, h]) => ({ driver, ...h, total: h.accel + h.braking + h.cornering }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const idleVsDrivingList = [...idleVsDriving.entries()]
    .map(([reg, v]) => ({ reg, idleMin: Math.round(v.idleSec / 60), drivingMin: Math.round(v.drivingSec / 60), idlePerTripMin: v.tripCount > 0 ? Math.round(v.idleSec / 60 / v.tripCount) : 0 }))
    .sort((a, b) => b.idleMin - a.idleMin);

  const dailyActivityGrid = [...dailyActivity.entries()].map(([reg, days]) => {
    const cells: { date: string; active: boolean }[] = [];
    for (let i = OVERVIEW_WINDOW_DAYS - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      cells.push({ date: dateStr, active: days.has(dateStr) });
    }
    return { reg, cells };
  });

  const speedingByVehicleList = [...speedingByVehicle.entries()]
    .map(([reg, v]) => ({
      reg,
      roadEvents: v.roadEvents,
      roadMin: Number((v.roadSec / 60).toFixed(1)),
      thresholdEvents: v.thresholdEvents,
      thresholdMin: Number((v.thresholdSec / 60).toFixed(1)),
      maxSpeed: Number(v.maxSpeed.toFixed(0)),
      tripsOverLimit: v.tripsOverLimit,
    }))
    .filter((v) => v.roadEvents > 0 || v.thresholdEvents > 0)
    .sort((a, b) => b.roadEvents - a.roadEvents);

  const speedingByDriverList = [...speedingByDriver.entries()]
    .map(([driver, v]) => ({ driver, ...v }))
    .filter((v) => v.roadEvents > 0 || v.thresholdEvents > 0)
    .sort((a, b) => b.roadEvents - a.roadEvents);

  // ---- Cost/KM Reconciliation ----
  // Target month = most recent month with any real fleet-card fuel cost in existing-fleet-data.json.
  const monthTotals = new Map<string, number>();
  for (const f of existing.fuel) monthTotals.set(f.m, (monthTotals.get(f.m) ?? 0) + f.c);
  const targetMonth = [...monthTotals.entries()].filter(([, cost]) => cost > 0).sort((a, b) => (a[0] < b[0] ? 1 : -1))[0]?.[0];

  const costPerKm: any[] = [];
  if (targetMonth) {
    console.log(`Cost/km target month: ${targetMonth}. Fetching Cartrack trip-distance km for target + 2 prior months...`);
    const monthsToFetch = [targetMonth, prevMonthLabel(targetMonth, 1), prevMonthLabel(targetMonth, 2)];

    // registration (workbook) -> month -> { rand, litres }
    const cardByRegMonth = new Map<string, Map<string, { rand: number; litres: number }>>();
    for (const f of existing.fuel) {
      if (!cardByRegMonth.has(f.r)) cardByRegMonth.set(f.r, new Map());
      const byMonth = cardByRegMonth.get(f.r)!;
      const cur = byMonth.get(f.m) ?? { rand: 0, litres: 0 };
      cur.rand += f.c;
      cur.litres += f.l;
      byMonth.set(f.m, cur);
    }

    // cartrack registration -> month -> km (from trip distances)
    const cartrackKmByRegMonth = new Map<string, Map<string, number>>();
    for (const reg in coverage) {
      if (!coverage[reg].covered) continue;
      const cartrackReg = coverage[reg].cartrackReg!;
      const byMonth = new Map<string, number>();
      for (const month of monthsToFetch) {
        const { start, end } = monthWindow(month);
        const trips = await cartrack.getTrips({ startTimestamp: start, endTimestamp: end, registration: cartrackReg });
        const km = trips.reduce((sum, t) => sum + (t.trip_distance ?? 0), 0) / 1000;
        byMonth.set(month, Number(km.toFixed(1)));
      }
      cartrackKmByRegMonth.set(reg, byMonth);
    }

    const divisionOf = (reg: string) => existing.vehicles[reg]?.division ?? "Unassigned";

    // Compute Rand/km for target month per vehicle, then peer (division) average, then self trailing average.
    const targetEntries: { reg: string; division: string; rand: number; km: number; randPerKm: number | null }[] = [];
    for (const reg in coverage) {
      if (!coverage[reg].covered) continue;
      const rand = cardByRegMonth.get(reg)?.get(targetMonth)?.rand ?? 0;
      const km = cartrackKmByRegMonth.get(reg)?.get(targetMonth) ?? 0;
      targetEntries.push({ reg, division: divisionOf(reg), rand, km, randPerKm: km > 0 ? rand / km : null });
    }

    const byDivision = new Map<string, number[]>();
    for (const e of targetEntries) {
      if (e.randPerKm === null) continue;
      if (!byDivision.has(e.division)) byDivision.set(e.division, []);
      byDivision.get(e.division)!.push(e.randPerKm);
    }
    const peerAvgByDivision = new Map<string, number>();
    for (const [div, values] of byDivision) peerAvgByDivision.set(div, values.reduce((a, b) => a + b, 0) / values.length);

    for (const e of targetEntries) {
      const priorMonths = [prevMonthLabel(targetMonth, 1), prevMonthLabel(targetMonth, 2)];
      const priorRandPerKm: number[] = [];
      for (const pm of priorMonths) {
        const rand = cardByRegMonth.get(e.reg)?.get(pm)?.rand ?? 0;
        const km = cartrackKmByRegMonth.get(e.reg)?.get(pm) ?? 0;
        if (rand > 0 && km > 0) priorRandPerKm.push(rand / km);
      }
      const selfBaseline = priorRandPerKm.length > 0 ? priorRandPerKm.reduce((a, b) => a + b, 0) / priorRandPerKm.length : null;
      const peerAvg = peerAvgByDivision.get(e.division) ?? null;

      const vsSelfPct = e.randPerKm !== null && selfBaseline !== null ? (e.randPerKm - selfBaseline) / selfBaseline : null;
      const vsPeerPct = e.randPerKm !== null && peerAvg !== null ? (e.randPerKm - peerAvg) / peerAvg : null;

      costPerKm.push({
        reg: e.reg,
        division: e.division,
        month: targetMonth,
        rand: Number(e.rand.toFixed(2)),
        km: e.km,
        randPerKm: e.randPerKm !== null ? Number(e.randPerKm.toFixed(2)) : null,
        selfBaselineRandPerKm: selfBaseline !== null ? Number(selfBaseline.toFixed(2)) : null,
        peerAvgRandPerKm: peerAvg !== null ? Number(peerAvg.toFixed(2)) : null,
        vsSelfPct: vsSelfPct !== null ? Number((vsSelfPct * 100).toFixed(1)) : null,
        vsPeerPct: vsPeerPct !== null ? Number((vsPeerPct * 100).toFixed(1)) : null,
        flaggedVsSelf: vsSelfPct !== null && Math.abs(vsSelfPct) > COST_PER_KM_TOLERANCE,
        flaggedVsPeer: vsPeerPct !== null && Math.abs(vsPeerPct) > COST_PER_KM_TOLERANCE,
      });
    }
  } else {
    console.log("No target month with real fleet-card fuel cost found — Cost/km will show an empty state.");
  }

  const cartrackData = {
    generatedAt: new Date().toISOString(),
    overviewWindowDays: OVERVIEW_WINDOW_DAYS,
    vehicleCount: vehicles.length,
    coverage,
    liveStatus,
    tripHistory,
    overview: {
      topDriversByHarshEvents,
      idleVsDriving: idleVsDrivingList,
      dailyActivity: dailyActivityGrid,
    },
    speeding: {
      byVehicle: speedingByVehicleList,
      byDriver: speedingByDriverList,
    },
    costPerKm: {
      targetMonth: targetMonth ?? null,
      tolerancePct: COST_PER_KM_TOLERANCE * 100,
      rows: costPerKm,
    },
  };

  writeFileSync(outputPath, JSON.stringify(cartrackData));
  console.log(`\nWrote ${outputPath} (${(JSON.stringify(cartrackData).length / 1024).toFixed(0)} KB)`);
  console.log(`Live status: ${liveStatus.length}, trips: ${tripHistory.length}, drivers: ${topDriversByHarshEvents.length}, cost/km rows: ${costPerKm.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
