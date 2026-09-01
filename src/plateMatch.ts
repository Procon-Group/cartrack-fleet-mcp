/**
 * Cartrack's registrations are sometimes driver-name-prefixed (e.g. "OTTO-N176274W"), while
 * the fleet workbook's Fleet Register/Fuel Log use the plain plate ("N176274W") — confirmed
 * against real data from both sides on 2026-09-01. Normalize by stripping non-alphanumerics,
 * then match exactly or by suffix (the Cartrack side ending in the workbook's plate).
 */
export function normalizePlate(reg: string): string {
  return reg.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** True if a Cartrack registration and a workbook/fleet-register plate refer to the same vehicle. */
export function platesMatch(cartrackRegistration: string, workbookRegistration: string): boolean {
  const a = normalizePlate(cartrackRegistration);
  const b = normalizePlate(workbookRegistration);
  return a === b || a.endsWith(b);
}

/** Finds the workbook-side entry (keyed by workbook registration) matching a Cartrack registration. */
export function findByPlate<T>(cartrackRegistration: string, workbookMap: Map<string, T>): T | undefined {
  for (const [workbookReg, value] of workbookMap) {
    if (platesMatch(cartrackRegistration, workbookReg)) return value;
  }
  return undefined;
}
