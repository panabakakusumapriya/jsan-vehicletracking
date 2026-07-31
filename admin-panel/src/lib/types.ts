export type Role = 'admin' | 'manager' | 'team_lead' | 'user';

export interface User {
  _id: string;
  name: string;
  email: string;
  phone?: string | null;
  country?: string | null;
  timezone?: string | null;
  role: Role;
  managerId?: string | { _id: string; name: string } | null;
  teamLeadId?: string | { _id: string; name: string } | null;
  vehicleId?: { _id: string; plateNumber: string; model?: string; vid?: string | null } | string | null;
  // Cache of the driver's open mobile assignment, set from the Drivers screen.
  mobileDeviceId?: { _id: string; label?: string | null; imei?: string | null; phoneModel?: string | null } | string | null;
  active: boolean;
  createdAt?: string;
  lastLoginAt?: string | null;
  // Driver profile
  driverId?: string | null;
  project?: string | null;
  scope?: string | null;
  region?: string | null;
  drivingLocation?: string | null;
  driverMode?: string | null;
  poc?: string | null;
  contact?: string | null;
  personalMail?: string | null;
  driverAddress?: string | null;
  ctsMail?: string | null;
  driverStatus?: string | null;
  joiningDate?: string | null;
  exitDate?: string | null;
  pricePerHour?: number | null;
  perDiem?: number | null;
  currency?: string | null;
  language?: string | null;
  // Mobile/device
  workPhone?: string | null;
  imei?: string | null;
  secondaryImei?: string | null;
  phoneModel?: string | null;
  androidVersion?: string | null;
  phoneCase?: string | null;
  phoneScreenguard?: string | null;
}

export interface Vehicle {
  _id: string;
  plateNumber: string;
  vid?: string | null;
  model?: string | null;
  country?: string | null;
  managerId?: string | null;
  assignedDriverId?: { _id: string; name: string; email: string } | string | null;
  active: boolean;
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
  timezone?: string | null;
  distanceMeters: number;
  maxSpeedKmh: number;
  pointCount: number;
}

export interface LiveDriver {
  tripId: string;
  driver: { _id: string; name: string; email: string; phone?: string; country?: string | null; project?: string | null };
  vehicle?: { _id: string; plateNumber: string; model?: string } | null;
  location?: Coord | null;
  startedAt: string;
  distanceMeters: number;
  maxSpeedKmh: number;
  stale: boolean;
}

export interface ParkedDriver {
  tripId: string;
  driver: { _id: string; name: string; email: string; phone?: string; country?: string | null; project?: string | null };
  vehicle?: { _id: string; plateNumber: string; model?: string } | null;
  location?: Coord | null;
  endedAt?: string | null;
}

// Socket 'alert' event — and the identical JSON body delivered by Web Push when the panel
// is closed. Raised by the backend watchdog (services/driverWatchdog.js).
export interface AlertEvent {
  type: 'driver-offline' | 'driver-online' | 'test';
  title: string;
  body: string;
  driverId: string | null;
  driverName: string | null;
  managerId?: string | null;
  tripId?: string;
  vehiclePlate?: string | null;
  country?: string | null;
  lastSeenAt?: string | null;
  silentMinutes?: number | null;
  tag?: string;
  url?: string;
  ts: string;
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
