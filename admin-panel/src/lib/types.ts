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
