export type Role = 'admin' | 'manager' | 'team_lead' | 'user';
export type TabPermission = 'edit' | 'view' | 'hidden';

/** All tab keys across admin panel and SSDS tool. */
export const ALL_TAB_KEYS = [
  'live_map', 'trips', 'drivers', 'mobiles', 'vehicles', 'weather', 'hotels',
  'couriers', 'ukm', 'coverage', 'app_health', 'asset_history', 'reports',
  'managers', 'projects', 'app_updates',
  'ssds_portal', 'timesheets', 'daily_status_report',
] as const;

export type TabKey = typeof ALL_TAB_KEYS[number];

export const TAB_LABELS: Record<TabKey, string> = {
  live_map: 'Live Map',
  trips: 'Trips',
  drivers: 'Drivers',
  mobiles: 'Mobiles',
  vehicles: 'Vehicles',
  weather: 'Predictive Weather',
  hotels: 'Hotels',
  couriers: 'Couriers',
  ukm: 'UKM',
  coverage: 'Coverage',
  app_health: 'App Health',
  asset_history: 'Asset History',
  reports: 'Reports',
  managers: 'Users',
  projects: 'Projects',
  app_updates: 'App Updates',
  ssds_portal: 'SSDS Portal',
  timesheets: 'Timesheets',
  daily_status_report: 'Daily Status Report',
};

export const ADMIN_PANEL_TABS: TabKey[] = [
  'live_map', 'trips', 'drivers', 'mobiles', 'vehicles', 'weather', 'hotels',
  'couriers', 'ukm', 'coverage', 'app_health', 'asset_history', 'reports',
  'managers', 'projects', 'app_updates',
];

export const SSDS_TABS: TabKey[] = ['ssds_portal', 'timesheets', 'daily_status_report'];

export const ADMIN_ONLY_TABS: TabKey[] = [
  'managers', 'projects', 'app_updates',
];

/** The tenancy boundary managers/team leads/drivers operate inside. Admin-managed. */
export interface Project {
  _id: string;
  name: string;
  code?: string | null;
  country?: string | null;
  active: boolean;
  // Which UKM dedup universe this project's coverage belongs to. Projects sharing a scope share
  // one history: a road first driven under one is not new road again under another. null means
  // the fleet-wide default scope, which is where every project starts — see the backend's
  // services/coverageScope.js for why sharing is the default and separating is the exception.
  coverageScopeId?: string | null;
  // Optional uniqueness reset inside a scope, for a deliberately repeated capture campaign.
  coverageCycleId?: string | null;
  createdAt?: string;
}

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
  // Required for manager/team_lead/user at creation (see backend user.controller.js). A driver
  // always holds exactly one; a manager/team lead can hold several (one manager can run more
  // than one project at once). A driver creator (manager/team lead) can only ever place a new
  // driver inside one of THEIR OWN projects. `project` below is a denormalized display copy of
  // the name(s), kept in sync by the server.
  projectIds?: (string | { _id: string; name: string; code?: string | null; country?: string | null })[];
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
  tabPermissions?: Partial<Record<TabKey, TabPermission>>;
}

export interface Vehicle {
  _id: string;
  plateNumber: string;
  vid?: string | null;
  model?: string | null;
  country?: string | null;
  managerId?: string | null;
  assignedDriverId?: { _id: string; name: string; email: string; country?: string; project?: string } | string | null;
  active: boolean;
  comments?: string | null;
}

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
  driverName?: string | null;
  workMail?: string | null;
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
  currentDriverId?: { _id: string; name: string; email: string; country?: string; project?: string } | string | null;
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
  /**
   * Who made the change and when — the audit trail the ledger has always recorded.
   * `assignedAt`/`releasedAt` are the real moments of the change, unlike `from`/`to` above which
   * are clipped to the reporting month. `releasedBy`/`releasedAt` are null while still held.
   */
  assignedBy?: string | null;
  assignedAt?: string | null;
  releasedBy?: string | null;
  releasedAt?: string | null;
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

export type MapMatchStatus = 'pending' | 'matching' | 'matched' | 'failed' | 'skipped';

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
  // Valhalla-matched ("cleaned") layer — additive, populated asynchronously after the trip
  // completes. null/undefined until mapMatchStatus is 'matched'. See backend services/mapMatcher.js.
  cleanedDistanceMeters?: number | null;
  cleanedRouteShapes?: string[] | null;
  mapMatchStatus?: MapMatchStatus;
  // Fraction of the trace (0..1) genuinely snapped to roads. Below 1 means some stretch could not
  // be matched and kept its raw GPS geometry instead, so the "snapped" route is partly raw — see
  // matchSegment() in the backend's services/valhalla.js.
  cleanedMatchedRatio?: number | null;
  // Road in this trip not covered by any EARLIER trip by the same driver — the cross-day "unique
  // KM" figure. Same route driven again tomorrow contributes 0. null until the trip is matched,
  // since it is derived from the snapped route. See backend services/roadSegments.js.
  ukmMeters?: number | null;
  // Distinct road within this trip alone (a road driven 3× in one trip counts once).
  ukmWithinTripMeters?: number | null;
  // The UKM stretches only, as encoded polyline6 — road that was new to this trip. Drawn
  // highlighted over the muted full route so previously-driven road is visually distinct.
  ukmNewShapes?: string[] | null;
  ukmComputedAt?: string | null;

  // ---- Global UKM: road new to the whole coverage programme, not just to this driver ----
  // The four fields above dedupe against this driver's own history only. These dedupe against
  // every driver and every project sharing the trip's coverage scope, which is the figure the
  // customer is billed on. Both are kept — see backend services/globalUkm.js.
  coverageScopeId?: string | null;
  coverageCycleId?: string | null;
  // 'pending' means not established yet, which is NOT 'computed' with a value of 0. A trip that
  // covered no new road and a trip nobody has measured must never render the same way.
  ukmStatus?: 'pending' | 'computed' | 'review' | 'failed';
  // Road covered by this trip once same-trip repeats are removed.
  distinctRoadMeters?: number | null;
  // Real distance re-driven inside this trip: cleaned distance minus the distinct figure.
  sameTripRepeatMeters?: number | null;
  // The part of that distinct road somebody in the scope had already covered.
  historicalDuplicateMeters?: number | null;
  // Road nobody in the scope had ever covered before this trip reached it. The number.
  globalUniqueMeters?: number | null;
  // Distance whose road identity could not be established (raw-GPS fallback in a partial match).
  // Held apart rather than counted as new road.
  unmatchedReviewMeters?: number | null;
  // Server-decided map geometry, encoded polyline6. The client draws these; it never derives them.
  ukmUniqueShapes?: string[] | null;
  ukmDuplicateShapes?: string[] | null;
  globalUkmComputedAt?: string | null;
  ukmAlgorithmVersion?: string | null;

  // ---- Assigned-network coverage: measured against the customer's road links and the polygons
  // the driver held during the trip. See backend services/linkCoverage.js.
  assignedAreaIds?: string[];
  assignedNetworkVersionId?: string | null;
  // Snapped distance inside / outside the assigned polygons. null when no polygon was held.
  inAreaMeters?: number | null;
  outAreaMeters?: number | null;
  outAreaShapes?: string[] | null;
  // Assigned-route UKM: the customer's links inside the driver's areas that this trip covered first.
  linkUkmMeters?: number | null;
  // Same, any area of the network.
  linkUkmNetworkMeters?: number | null;
  linkUkmShapes?: string[] | null;
  linkCoveredCount?: number | null;
  linkCoverageStatus?: 'pending' | 'computed' | 'review' | 'no_network' | 'failed';
  linkCoverageComputedAt?: string | null;
  // Which UKM the driver is measured on, and that figure — the one every surface should show.
  ukmBasis?: 'assigned' | 'global' | null;
  effectiveUkmMeters?: number | null;
}

export interface LiveDriver {
  tripId: string;
  driver: { _id: string; name: string; email: string; phone?: string; country?: string | null; project?: string | null };
  vehicle?: { _id: string; plateNumber: string; model?: string } | null;
  location?: Coord | null;
  startedAt: string;
  distanceMeters: number;
  maxSpeedKmh: number;
  /**
   * moving  - a GPS fix within STALE_AFTER_SECONDS
   * stopped - no recent fix, but the app is still heartbeating: parked or waiting, not lost
   * stale   - neither; we genuinely cannot account for the driver
   */
  state?: 'moving' | 'stopped' | 'stale';
  appAlive?: boolean;
  /** True only when we cannot account for the driver at all. Kept for older callers. */
  stale: boolean;
}

export interface ParkedDriver {
  /** Seconds since the trip ended — how long the vehicle has been sitting there. */
  parkedForSeconds?: number | null;
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

/* ---------------------------------------------------------------- Coverage
 * The customer-supplied target network: work areas, road links, and progress
 * against them. See backend/src/models/NetworkVersion.js.
 */

export interface CrsInfo {
  wkt: string | null;
  name: string | null;
  datum: string | null;
  projected: boolean;
  compatible: boolean;
  note: string | null;
}

export interface DbfField {
  name: string;
  type: string;
  length: number;
  decimals: number;
}

export interface ImportIssue {
  code: string;
  message: string;
}

export interface ColumnMapping {
  areaCode: string | null;
  areaName: string | null;
  areaParent: string | null;
  priority: string | null;
  areaSqm: string | null;
  linkId: string | null;
  linkName: string | null;
  funcClass: string | null;
  dirTravel: string | null;
  autoAccess: string | null;
}

/** The preflight — everything we know before a single document is written. */
export interface ImportReport {
  generatedAt: string;
  mapping: ColumnMapping;
  boundary: {
    file: string;
    otherLayersInZip: string[];
    shapeTypeName: string;
    recordCount: number;
    bbox: number[];
    crs: CrsInfo;
    fields: DbfField[];
    sample: Record<string, unknown>[];
    byPriority: { priority: number; areas: number; areaSqKm: number; links: number; meters: number }[];
  };
  network: {
    file: string;
    otherLayersInZip: string[];
    shapeTypeName: string;
    recordCount: number;
    bbox: number[];
    crs: CrsInfo;
    fields: DbfField[];
    sample: Record<string, unknown>[];
    totalMeters: number;
    avgMeters: number;
    unnamedLinks: number;
    zeroLengthLinks: number;
    multiPartLinks: number;
    byFuncClass: { funcClass: number | null; links: number; meters: number }[];
    byDirTravel: { dir: string; links: number; meters: number }[];
    lengthBuckets: { bucket: string; links: number }[];
    // Null when no road-network archive was supplied — work areas alone are a valid import, and
    // "no layer given" is a different fact from "a layer with zero roads".
  } | null;
  join: {
    orphanLinks: number;
    orphanMeters: number;
    areasWithoutLinks: number;
    matchedAreas: number;
  };
  totals: { areas: number; links: number; targetMeters: number; orphanMeters: number };
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

export type ImportStatus =
  | 'draft'
  | 'queued'
  | 'parsing'
  | 'awaiting_approval'
  | 'committing'
  | 'ready'
  | 'failed'
  | 'cancelled';

export interface ImportFileInfo {
  name: string | null;
  bytes: number;
  sha256: string | null;
  uploadedAt: string | null;
}

export interface ImportJob {
  _id: string;
  projectId: { _id: string; name: string; code?: string | null } | string;
  requestedBy?: { _id: string; name: string; email?: string } | string;
  label: string;
  status: ImportStatus;
  files: { boundary: ImportFileInfo; network: ImportFileInfo };
  mapping: ColumnMapping;
  includeOrphanLinks: boolean;
  report: ImportReport | null;
  progress: { phase: string | null; done: number; total: number };
  networkVersionId: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type NetworkVersionStatus = 'building' | 'ready' | 'active' | 'superseded' | 'failed';

export interface NetworkVersion {
  _id: string;
  projectId: { _id: string; name: string; code?: string | null } | string;
  label: string;
  status: NetworkVersionStatus;
  sourceCRS: { boundary: string | null; network: string | null };
  counts: { areas: number; links: number; orphanLinks: number };
  targetMeters: number;
  orphanMeters: number;
  byPriority: { priority: number; areas: number; links: number; meters: number }[];
  byFuncClass: { funcClass: number | null; links: number; meters: number }[];
  createdBy?: { _id: string; name: string } | null;
  activatedBy?: { _id: string; name: string } | null;
  activatedAt: string | null;
  createdAt: string;
}

export interface CoverageBand {
  priority?: number;
  funcClass?: number | null;
  areas?: number;
  links: number;
  meters: number;
  coveredMeters: number;
  coveredLinks: number;
}

export interface CoverageSummary {
  coveredMeters: number;
  coveredLinks: number;
  targetMeters: number;
  targetLinks: number;
  byPriority: CoverageBand[];
  byFuncClass: CoverageBand[];
}

export interface CoverageArea {
  _id: string;
  areaCode: string;
  name: string;
  parentName: string | null;
  priority: number;
  areaSqKm: number | null;
  targetMeters: number;
  targetLinks: number;
  coveredMeters: number;
  coveredLinks: number;
  bbox?: number[];
}

/** Which driver is responsible for a work area. See backend/src/models/AreaAssignment.js. */
export interface AreaAssignment {
  _id: string;
  projectId: string;
  networkVersionId: string;
  areaId: string;
  driverId: { _id: string; name: string; email?: string; driverStatus?: string } | string;
  areaName: string | null;
  areaCode: string | null;
  driverName: string | null;
  assignedBy?: { _id: string; name: string } | string | null;
  assignedAt: string;
  releasedBy?: { _id: string; name: string } | string | null;
  releasedAt: string | null;
  note: string | null;
}
