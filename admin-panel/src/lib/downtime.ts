/**
 * Downtime drivers report from the app — time stopped for a reason (a weather stop, a vehicle
 * change-over). It counts toward working hours as soon as it is saved; there is no approval step.
 * status 'approved' = counted ('pending' / 'rejected' only on entries from before that changed).
 */
export type DowntimeRow = {
  id: string;
  driverId: string;
  driverName: string | null;
  timezone: string;
  date: string;
  startAt: string;
  endAt: string;
  durationMs: number;
  reason: string;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected';
};

export const DOWNTIME_REASON: Record<string, string> = {
  weather: 'Weather',
  vehicle_changeover: 'Vehicle change-over',
  vehicle_issue: 'Vehicle issue',
  road_closed: 'Road closed',
  waiting_instructions: 'Waiting for instructions',
  fuel: 'Fuel',
  other: 'Other',
};
