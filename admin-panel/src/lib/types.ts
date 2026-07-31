export type Role = 'admin' | 'manager' | 'user';

export interface User {
  _id: string;
  name: string;
  email: string;
  phone?: string | null;
  country?: string | null;
  role: Role;
  managerId?: string | null;
  vehicleId?: { _id: string; plateNumber: string; model?: string } | string | null;
  active: boolean;
  createdAt?: string;
  lastLoginAt?: string | null;
}

export interface Vehicle {
  _id: string;
  plateNumber: string;
  model?: string | null;
  managerId?: string | null;
  assignedDriverId?: { _id: string; name: string; email: string } | string | null;
  active: boolean;
}

<<<<<<< Updated upstream
=======
/* ── Driving weather ── */
export type DrivingRisk = 'clear' | 'caution' | 'unsafe';

export interface WeatherSlot {
  dt: number;
  at: string;            // "HH:MM" at the forecast location
  risk: DrivingRisk;
  reasons: string[];
  tempC: number | null;
  feelsLikeC: number | null;
  windKmh: number | null;
  gustKmh: number | null;
  popPct: number;
  visibilityKm: number | null;
  rainMm: number;
  snowMm: number;
  icon: string | null;
  description: string;
}

export interface WeatherGroup {
  key: string;
  lat: number;
  lon: number;
  place: string | null;
  country: string | null;
  localTimeNow: string;
  verdict: DrivingRisk | null;
  headline: string;
  date: string | null;
  slots: WeatherSlot[];
  worstWindowFrom: string | null;
  worstWindowTo: string | null;
  stale: boolean;
  cachedAgeSeconds: number;
  drivers: { _id: string; name: string; country?: string | null; project?: string | null; lastSeenAt?: string }[];
}

export interface DrivingWeather {
  configured: boolean;
  generatedAt?: string;
  dayOffset?: number;
  groups: WeatherGroup[];
  unplaced: { _id: string; name: string; country?: string | null; project?: string | null }[];
  failures?: string[];
  totals: {
    clear: number; caution: number; unsafe: number; unplaced: number;
    locations?: number; apiCalls?: number;
  };
  thresholds?: {
    windCautionKmh: number; gustUnsafeKmh: number; activeDays: number; cacheMinutes: number;
  };
}

export type DeviceStatus = 'in_stock' | 'assigned' | 'repair' | 'lost' | 'retired';

/** A physical handset, tracked as an asset in its own right (not fields on a driver). */
export interface MobileDevice {
  _id: string;
  imei?: string | null;
  secondaryImei?: string | null;
  serial?: string | null;
  label?: string | null;
  displayLabel?: string;
  phoneModel?: string | null;
  androidVersion?: string | null;
  workPhone?: string | null;
  phoneCase?: string | null;
  phoneScreenguard?: string | null;
  country?: string | null;
  notes?: string | null;
  status: DeviceStatus;
  currentDriverId?: { _id: string; name: string; email: string } | string | null;
  managerId?: { _id: string; name: string } | string | null;
  active: boolean;
  createdAt?: string;
}

export type AssetKind = 'vehicle' | 'mobile';

/** One stint of custody. `endedAt: null` (open: true) means still held. */
export interface Assignment {
  _id: string;
  assetKind: AssetKind;
  assetId: string;
  driverId: { _id: string; name: string; email: string } | string;
  driverName?: string | null;
  assetLabel?: string | null;
  startedAt: string;
  endedAt: string | null;
  open: boolean;
  country?: string | null;
  project?: string | null;
  backfilled?: boolean;
  note?: string | null;
  assignedBy?: { _id: string; name: string } | string | null;
  releasedBy?: { _id: string; name: string } | string | null;
}

/** One asset held during the reported month, clipped to that month. */
export interface CustodyStint {
  assignmentId: string;
  assetId: string;
  label: string | null;
  from: string;
  to: string;
  days: number;
  startedBefore: boolean;
  stillOpen: boolean;
  backfilled: boolean;
  country?: string | null;
  project?: string | null;
  note?: string | null;
}

export interface CustodyRow {
  driver: { _id: string; name: string; email: string | null; country?: string | null; active: boolean; exitDate?: string | null };
  vehicles: CustodyStint[];
  mobiles: CustodyStint[];
  vehicleDays: number;
  mobileDays: number;
}

export interface CustodyReport {
  month: string;
  tz: string;
  from: string;
  to: string;
  monthDays: number;
  rows: CustodyRow[];
  totals: {
    drivers: number;
    driversWithVehicle: number;
    driversWithMobile: number;
    driversWithNothing: number;
    vehicleStints: number;
    mobileStints: number;
  };
}

>>>>>>> Stashed changes
export interface Coord {
  lat: number;
  lon: number;
  speed?: number;
  heading?: number | null;
  recordedAt?: string;
}

export interface Trip {
  _id: string;
  driverId: { _id: string; name: string; email: string } | string;
  vehicleId?: { _id: string; plateNumber: string } | string | null;
  status: 'active' | 'completed' | 'timed_out';
  startedAt: string;
  endedAt?: string | null;
  startLocation?: Coord | null;
  endLocation?: Coord | null;
  lastLocation?: Coord | null;
  distanceMeters: number;
  maxSpeedKmh: number;
  pointCount: number;
}

export interface LiveDriver {
  tripId: string;
  driver: { _id: string; name: string; email: string; phone?: string; country?: string | null };
  vehicle?: { _id: string; plateNumber: string; model?: string } | null;
  location?: Coord | null;
  startedAt: string;
  distanceMeters: number;
  maxSpeedKmh: number;
  stale: boolean;
}

export interface ParkedDriver {
  tripId: string;
  driver: { _id: string; name: string; email: string; phone?: string; country?: string | null };
  vehicle?: { _id: string; plateNumber: string; model?: string } | null;
  location?: Coord | null;
  endedAt?: string | null;
}

// Socket 'location' event payload emitted by the backend on each ingest.
export interface LocationEvent {
  driverId: string;
  driverName: string;
  managerId: string | null;
  vehicleId: string | null;
  tripId: string;
  lat: number;
  lon: number;
  speedKmh: number;
  heading: number | null;
  recordedAt: string;
  ended: boolean;
}
