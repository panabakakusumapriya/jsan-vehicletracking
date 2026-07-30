export type Role = 'admin' | 'manager' | 'user';

export interface User {
  _id: string;
  name: string;
  email: string;
  phone?: string | null;
  country?: string | null;
  timezone?: string | null;
  role: Role;
  managerId?: string | null;
  vehicleId?: { _id: string; plateNumber: string; model?: string } | string | null;
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
  managerId?: string | null;
  assignedDriverId?: { _id: string; name: string; email: string } | string | null;
  active: boolean;
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
