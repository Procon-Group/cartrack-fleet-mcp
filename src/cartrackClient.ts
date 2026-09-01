import { ApiErrorBody, CartrackApiError, PaginationMeta } from "./types.js";

export interface CartrackConfig {
  username: string;
  password: string;
  baseUrl: string; // e.g. https://fleetapi-za.cartrack.com/rest
}

export function loadConfigFromEnv(): CartrackConfig {
  const username = process.env.CARTRACK_USERNAME;
  const password = process.env.CARTRACK_PASSWORD;
  const baseUrl = process.env.CARTRACK_BASE_URL;
  if (!username || !password || !baseUrl) {
    throw new Error(
      "Missing Cartrack credentials. Set CARTRACK_USERNAME, CARTRACK_PASSWORD and CARTRACK_BASE_URL " +
        "(see .env.example). CARTRACK_BASE_URL is the region-specific host from the Cartrack developer " +
        "portal, e.g. https://fleetapi-za.cartrack.com/rest.",
    );
  }
  return { username, password, baseUrl };
}

interface PagedResponse<T> {
  data: T[];
  meta?: PaginationMeta;
}

/** Simple pacer so we never exceed a given endpoint's requests-per-minute limit. */
class RateLimiter {
  private queue: number[] = [];
  constructor(private maxPerMinute: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    this.queue = this.queue.filter((t) => now - t < 60_000);
    if (this.queue.length >= this.maxPerMinute) {
      const oldest = this.queue[0];
      const delay = 60_000 - (now - oldest) + 50;
      await new Promise((r) => setTimeout(r, delay));
      return this.wait();
    }
    this.queue.push(Date.now());
  }
}

export const limiters = {
  vehicles: new RateLimiter(1000),
  vehicleStatus: new RateLimiter(60),
  trips: new RateLimiter(1000),
  fuelBulk: new RateLimiter(10),
  fuelSingle: new RateLimiter(1000),
};

export class CartrackClient {
  constructor(private config: CartrackConfig) {}

  private authHeader(): string {
    const token = Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
    return `Basic ${token}`;
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; limiter?: RateLimiter } = {},
  ): Promise<T> {
    if (opts.limiter) await opts.limiter.wait();

    const url = new URL(this.config.baseUrl.replace(/\/$/, "") + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const doFetch = async (): Promise<Response> =>
      fetch(url.toString(), {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });

    let res = await doFetch();

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("X-RateLimit-Retry-After-Seconds") ?? "5");
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      res = await doFetch();
    }

    if (res.status === 409) {
      const retryAfter = Number(res.headers.get("Retry-After") ?? "30");
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      res = await doFetch();
    }

    if (!res.ok) {
      let body: ApiErrorBody | undefined;
      try {
        body = (await res.json()) as ApiErrorBody;
      } catch {
        // response body wasn't JSON
      }
      throw new CartrackApiError(
        res.status,
        body?.error?.code ?? res.status,
        body?.error?.message ?? `Cartrack API request failed: ${method} ${path} -> ${res.status}`,
        body?.error?.data,
      );
    }

    return (await res.json()) as T;
  }

  /** Fetches every page of a paginated GET endpoint and returns the concatenated data. */
  private async getAllPages<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    limiter: RateLimiter,
    pageSize = 100,
  ): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    for (;;) {
      const resp = await this.request<PagedResponse<T>>("GET", path, {
        query: { ...query, page, limit: pageSize },
        limiter,
      });
      all.push(...(resp.data ?? []));
      if (!resp.meta || resp.meta.current_page >= resp.meta.last_page) break;
      page += 1;
    }
    return all;
  }

  // ---- A. Vehicles ----

  async listVehicles(filter?: {
    registration?: string;
    vehicleId?: number;
    manufacturer?: string;
    modelYear?: string;
    colour?: string;
    chassisNumber?: string;
  }): Promise<import("./types.js").Vehicle[]> {
    return this.getAllPages<import("./types.js").Vehicle>(
      "/vehicles",
      {
        "filter[registration]": filter?.registration,
        "filter[vehicle_id]": filter?.vehicleId,
        "filter[manufacturer]": filter?.manufacturer,
        "filter[model_year]": filter?.modelYear,
        "filter[colour]": filter?.colour,
        "filter[chassis_number]": filter?.chassisNumber,
      },
      limiters.vehicles,
    );
  }

  // ---- B. Vehicle status / last-known location ----

  async getVehicleStatus(filter?: {
    registration?: string;
    vehicleId?: number;
    ignition?: boolean;
    odometerInKm?: boolean;
  }): Promise<import("./types.js").VehicleStatus[]> {
    const resp = await this.request<PagedResponse<import("./types.js").VehicleStatus>>("GET", "/vehicles/status", {
      query: {
        "filter[registration]": filter?.registration,
        "filter[vehicle_id]": filter?.vehicleId,
        "filter[ignition]": filter?.ignition !== undefined ? String(filter.ignition) : undefined,
        odometer_in_km: filter?.odometerInKm !== undefined ? String(filter.odometerInKm) : undefined,
      },
      limiter: limiters.vehicleStatus,
    });
    return resp.data ?? [];
  }

  // ---- C. Trips ----

  /** Cartrack caps trip queries at 31 days per request; this chunks longer ranges automatically. */
  async getTrips(opts: {
    startTimestamp: string; // "YYYY-MM-DD HH:MM:SS"
    endTimestamp: string;
    registration?: string; // if set, uses /trips/{registration}; otherwise fleet-wide /trips (no per-vehicle filter available)
    includePrivate?: boolean;
  }): Promise<import("./types.js").Trip[]> {
    const windows = chunkDateRange(opts.startTimestamp, opts.endTimestamp, 31);
    const results: import("./types.js").Trip[] = [];
    for (const w of windows) {
      const path = opts.registration ? `/trips/${encodeURIComponent(opts.registration)}` : "/trips";
      const page = await this.getAllPages<import("./types.js").Trip>(
        path,
        {
          start_timestamp: w.start,
          end_timestamp: w.end,
          incl_private: opts.includePrivate ?? false,
        },
        limiters.trips,
      );
      results.push(...page);
    }
    return results;
  }

  // ---- D. Fuel ----

  /**
   * Fuel consumed + fuel level for a date range. Uses the bulk POST endpoints when the
   * window is <= 24h and vehicle count <= 100 (the common daily-sync case); falls back to
   * per-vehicle GET endpoints (up to 31 days each) otherwise, paced to the 10 req/min cap.
   */
  async getFuelData(opts: {
    startTimestamp: string;
    endTimestamp: string;
    registrations: string[]; // full fleet list resolved by the caller via listVehicles()
  }): Promise<{ consumed: import("./types.js").FuelConsumed[]; level: import("./types.js").FuelLevel[] }> {
    const hours = (Date.parse(opts.endTimestamp.replace(" ", "T") + "Z") -
      Date.parse(opts.startTimestamp.replace(" ", "T") + "Z")) /
      3_600_000;

    if (hours <= 24 && opts.registrations.length <= 100) {
      const [consumedResp, levelResp] = await Promise.all([
        this.request<PagedResponse<import("./types.js").FuelConsumed>>("POST", "/fuel/consumed", {
          body: { registrations: opts.registrations, start_timestamp: opts.startTimestamp, end_timestamp: opts.endTimestamp, limit: 100 },
          limiter: limiters.fuelBulk,
        }),
        this.request<PagedResponse<import("./types.js").FuelLevel>>("POST", "/fuel/level", {
          body: { registrations: opts.registrations, start_timestamp: opts.startTimestamp, end_timestamp: opts.endTimestamp, limit: 100 },
          limiter: limiters.fuelBulk,
        }),
      ]);
      return { consumed: consumedResp.data ?? [], level: levelResp.data ?? [] };
    }

    // Longer range and/or larger fleet: per-vehicle GETs, chunked to 31-day windows.
    const consumed: import("./types.js").FuelConsumed[] = [];
    const level: import("./types.js").FuelLevel[] = [];
    const windows = chunkDateRange(opts.startTimestamp, opts.endTimestamp, 31);
    for (const registration of opts.registrations) {
      for (const w of windows) {
        const c = await this.request<{ data: import("./types.js").FuelConsumed }>(
          "GET",
          `/fuel/consumed/${encodeURIComponent(registration)}`,
          { query: { start_timestamp: w.start, end_timestamp: w.end }, limiter: limiters.fuelSingle },
        );
        if (c.data) consumed.push(c.data);
        const l = await this.request<{ data: import("./types.js").FuelLevel }>(
          "GET",
          `/fuel/level/${encodeURIComponent(registration)}`,
          { query: { start_timestamp: w.start, end_timestamp: w.end }, limiter: limiters.fuelSingle },
        );
        if (l.data) level.push(l.data);
      }
    }
    return { consumed, level };
  }
}

/** Splits a start/end "YYYY-MM-DD HH:MM:SS" range into <= maxDays chunks, inclusive. */
export function chunkDateRange(start: string, end: string, maxDays: number): { start: string; end: string }[] {
  const startMs = Date.parse(start.replace(" ", "T") + "Z");
  const endMs = Date.parse(end.replace(" ", "T") + "Z");
  const maxMs = maxDays * 24 * 60 * 60 * 1000;
  const windows: { start: string; end: string }[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const chunkEnd = Math.min(cursor + maxMs, endMs);
    windows.push({ start: formatCartrackTs(cursor), end: formatCartrackTs(chunkEnd) });
    cursor = chunkEnd;
  }
  return windows.length > 0 ? windows : [{ start, end }];
}

function formatCartrackTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
