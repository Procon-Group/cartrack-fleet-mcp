#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CartrackClient, loadConfigFromEnv } from "./cartrackClient.js";
import { CartrackApiError } from "./types.js";
import { previous24HourWindow } from "./dateWindow.js";

const config = loadConfigFromEnv();
const client = new CartrackClient(config);

const server = new McpServer({
  name: "cartrack-fleet-mcp",
  version: "0.1.0",
});

function toolError(err: unknown) {
  if (err instanceof CartrackApiError) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Cartrack API error (HTTP ${err.status}, code ${err.code}): ${err.message}${
            err.fieldErrors ? `\nField errors: ${JSON.stringify(err.fieldErrors)}` : ""
          }`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

const dateRangeShape = {
  start_timestamp: z
    .string()
    .optional()
    .describe('Range start, "YYYY-MM-DD HH:MM:SS". Defaults to 24 hours before now (Namibia local time).'),
  end_timestamp: z
    .string()
    .optional()
    .describe('Range end, "YYYY-MM-DD HH:MM:SS". Defaults to now (Namibia local time).'),
};

server.registerTool(
  "list_vehicles",
  {
    title: "List vehicles",
    description:
      "Full Procon fleet vehicle list from Cartrack: registration numbers, vehicle IDs, make/model, and maintenance status. " +
      "No filtering by default — returns the whole fleet (auto-paginated). Use this to match against the Fleet Register.",
    inputSchema: {
      registration: z.string().optional().describe("Partial/case-insensitive registration match, to filter to one vehicle."),
      vehicle_id: z.number().int().optional().describe("Exact Cartrack vehicle ID, to filter to one vehicle."),
      manufacturer: z.string().optional(),
      model_year: z.string().optional(),
      colour: z.string().optional(),
      chassis_number: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const vehicles = await client.listVehicles({
        registration: args.registration,
        vehicleId: args.vehicle_id,
        manufacturer: args.manufacturer,
        modelYear: args.model_year,
        colour: args.colour,
        chassisNumber: args.chassis_number,
      });
      return { content: [{ type: "text", text: JSON.stringify({ count: vehicles.length, vehicles }, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "get_vehicle_status",
  {
    title: "Get vehicle status",
    description:
      "Current status and last-known location for the fleet (or one vehicle): ignition, speed, idling, odometer, fuel level, " +
      "and GPS position. This is a live snapshot, not history — there is no date range. Rate-limited to 60 requests/minute by Cartrack.",
    inputSchema: {
      registration: z.string().optional().describe("Filter to one vehicle by registration (partial match)."),
      vehicle_id: z.number().int().optional().describe("Filter to one vehicle by exact Cartrack vehicle ID."),
      ignition: z.boolean().optional().describe("Filter to vehicles with ignition on (true) or off (false)."),
    },
  },
  async (args) => {
    try {
      const statuses = await client.getVehicleStatus({
        registration: args.registration,
        vehicleId: args.vehicle_id,
        ignition: args.ignition,
        odometerInKm: true,
      });
      return { content: [{ type: "text", text: JSON.stringify({ count: statuses.length, statuses }, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "get_trips",
  {
    title: "Get trips",
    description:
      "Trip history for a date range: route (start/end location and coordinates), distance, duration, idle time, and driving " +
      "behavior (harsh braking/cornering/acceleration, speeding events). Defaults to the previous 24 hours. Cartrack caps each " +
      "request at 31 days — longer ranges are chunked automatically. Fleet-wide queries cannot be filtered by vehicle at the API " +
      "level (Cartrack has no such filter on the fleet-wide endpoint); pass `registration` to query one vehicle directly instead.",
    inputSchema: {
      ...dateRangeShape,
      registration: z.string().optional().describe("Exact registration to get trips for one vehicle instead of the whole fleet."),
      include_private: z.boolean().optional().describe("Include trips marked private. Defaults to false."),
    },
  },
  async (args) => {
    try {
      const { start, end } = previous24HourWindow();
      const trips = await client.getTrips({
        startTimestamp: args.start_timestamp ?? start,
        endTimestamp: args.end_timestamp ?? end,
        registration: args.registration,
        includePrivate: args.include_private,
      });
      return { content: [{ type: "text", text: JSON.stringify({ count: trips.length, trips }, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  },
);

server.registerTool(
  "get_fuel_data",
  {
    title: "Get fuel data",
    description:
      "Fuel level and consumption for a date range, fleet-wide or for one vehicle. Defaults to the previous 24 hours. When no " +
      "`registration` is given, fetches the whole fleet in one batch (Cartrack's bulk endpoints, capped at 100 vehicles and a " +
      "24-hour window); wider ranges or a single vehicle fall back to per-vehicle history, capped at 31 days per request and " +
      "paced to Cartrack's 10-requests/minute limit on the bulk endpoints.",
    inputSchema: {
      ...dateRangeShape,
      registration: z.string().optional().describe("Exact registration to get fuel data for one vehicle instead of the whole fleet."),
    },
  },
  async (args) => {
    try {
      const { start, end } = previous24HourWindow();
      const startTimestamp = args.start_timestamp ?? start;
      const endTimestamp = args.end_timestamp ?? end;

      let registrations: string[];
      if (args.registration) {
        registrations = [args.registration];
      } else {
        const vehicles = await client.listVehicles();
        registrations = vehicles.map((v) => v.registration);
      }

      const fuel = await client.getFuelData({ startTimestamp, endTimestamp, registrations });
      return { content: [{ type: "text", text: JSON.stringify(fuel, null, 2) }] };
    } catch (err) {
      return toolError(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
