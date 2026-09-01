export interface PaginationMeta {
  from: number;
  to: number;
  current_page: number;
  per_page: number;
  last_page: number;
  total: number;
}

export interface ApiErrorBody {
  error: {
    code: number;
    message: string;
    data?: Record<string, string[]>;
  };
}

export class CartrackApiError extends Error {
  constructor(
    public status: number,
    public code: number,
    message: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "CartrackApiError";
  }
}

export interface Vehicle {
  vehicle_id: number;
  terminal_id?: string;
  registration: string;
  terminal_serial?: string;
  default_timezone?: string;
  monthly_mileage_limit?: number;
  vehicle_name?: string;
  licence_code?: string;
  licence_issued_date?: string;
  licence_expiry_date?: string;
  max_speed?: number;
  manufacturer?: string;
  model?: string;
  model_year?: string;
  colour?: string;
  chassis_number?: string;
  is_under_maintenance: boolean;
  vehicle_type_id?: number;
  vehicle_type?: string;
  has_camera?: boolean;
  sensors?: {
    fuel_canbus_consumed?: boolean;
    fuel_canbus_level?: boolean;
    fuel_analog_level?: boolean;
    electric_battery?: boolean;
    electric_charging?: boolean;
  };
  [key: string]: unknown;
}

export interface VehicleStatus {
  vehicle_id: number;
  registration: string;
  engine_type?: string;
  chassis_number?: string;
  event_ts?: string;
  bearing?: number;
  speed?: number;
  ignition?: boolean;
  idling?: boolean;
  odometer?: number;
  rpm?: number;
  driver?: {
    driver_id?: string;
    first_name?: string;
    last_name?: string;
  };
  fuel?: {
    updated?: string;
    level?: number;
    // Cartrack's live API actually returns this misspelled as "precentage_left" (confirmed
    // against a real response on 2026-09-01) — the OpenAPI spec's "percentage_left" doesn't
    // match. Both are read defensively in case Cartrack fixes the typo later.
    percentage_left?: number;
    precentage_left?: number;
    total_consumed?: number;
  };
  electric?: {
    battery_percentage_left?: number;
    battery_ts?: string;
    charging_status?: "PLUGGED_NOT_CHARGING" | "PLUGGED_CHARGING" | "UNPLUGGED";
    charging_status_ts?: string;
  };
  location?: {
    updated?: string;
    longitude?: number;
    latitude?: number;
    gps_fix_type?: number;
    position_description?: string;
    geofence_ids?: string[];
  };
  [key: string]: unknown;
}

export interface Trip {
  trip_id: string;
  vehicle_id: number;
  registration: string;
  chassis_number?: string;
  start_timestamp: string;
  end_timestamp: string;
  trip_duration?: string;
  trip_duration_seconds?: number;
  start_location?: string;
  start_coordinates?: { latitude: number; longitude: number };
  end_location?: string;
  end_coordinates?: { latitude: number; longitude: number };
  start_odometer?: number;
  end_odometer?: number;
  trip_distance?: number;
  start_geofence_name?: string;
  end_geofence_name?: string;
  thresholds_speeding_events?: number;
  thresholds_speeding_duration_seconds?: number;
  road_speeding_events?: number;
  road_speeding_duration_seconds?: number;
  max_speed?: number;
  harsh_braking_events?: number;
  harsh_cornering_events?: number;
  harsh_acceleration_events?: number;
  idle_time?: string;
  idle_time_seconds?: number;
  driver_id?: string;
  driver_name?: string;
  driver_surname?: string;
  trip_type?: string;
  is_private?: boolean;
  [key: string]: unknown;
}

export interface FuelConsumed {
  vehicle_id: number;
  registration: string;
  fuel_consumed_start?: number;
  fuel_consumed_end?: number;
  fuel_consumed: number;
}

export interface FuelLevel {
  vehicle_id: number;
  registration: string;
  start_period?: { liters: number; timestamp: string; accurate: boolean };
  end_period?: { liters: number; timestamp: string; accurate: boolean };
  estimated_fuel_used?: number;
  calibrated?: boolean;
}

export interface FuelFill {
  vehicle_id: number;
  registration: string;
  chassis_number?: string;
  fill_amount_litres: number;
  fill_timestamp: string;
  fill_odometer?: number;
  fill_location?: string;
  latitude?: number;
  longitude?: number;
  accurate?: boolean;
}
