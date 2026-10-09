import { COORDINATE_SYSTEM, type Layer, type PickingInfo } from '@deck.gl/core';
import { DataFilterExtension, PathStyleExtension } from '@deck.gl/extensions';
import { GeoJsonLayer, IconLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { decodePolyline6 } from '../lib/polyline';
import { PIN_SIZE, escapeHtml, pinIcon, type DriverPin } from '../lib/driverPins';
import {
  NO_AREA,
  linkIdAt,
  listRoadBlobs,
  loadRoadNet,
  loadRoadState,
  type RoadNet,
  type RoadState,
} from '../lib/roadNetwork';
import { Map3D, type Map3DHandle } from '../lib/map3d/Map3D';
import { MarkerCard, pinUrl, type TripMarker } from './TripMarkers';

/**
 * WebGL view of a customer's work areas and target road network.
 *
 * Everything here is sized by one fact: the first delivery is 402 polygons and 654,447 road links.
 * That is far past what an SVG or canvas map can draw, which is why this rides the deck.gl +
 * MapLibre stack already used for trip playback rather than the Leaflet one used elsewhere.
 *
 * Two different strategies, because the two layers have different problems:
 *
 *   - Areas are few but detailed, so they arrive once, pre-simplified server-side (25 m tolerance,
 *     7.4 MB -> 0.86 MB) and stay resident.
 *   - Links are enormous but only ever locally interesting, so they are fetched per viewport and
 *     only past a zoom where drawing them means something. At country zoom 61,563 km of hairlines
 *     is a grey smear that tells you nothing and costs everything.
 */

/**
 * Roads are hidden by scope ("in assigned areas", "everything driven") on the GPU rather than by
 * rebuilding the geometry: one value per vertex, 1 shown, 0 not. Hidden roads cannot be hovered
 * either, which an alpha of zero would not give. Built once — deck.gl compares extensions by identity.
 */
const ROAD_FILTER = new DataFilterExtension({ filterSize: 1 });
const RED: [number, number, number] = [220, 38, 38];
const BLUE: [number, number, number] = [37, 99, 235];

type Geometry = { type: string; coordinates: unknown };

interface AreaProps {
  areaId?: string;
  areaCode: string;
  name: string;
  parentName: string | null;
  priority: number;
  areaSqKm?: number | null;
  targetMeters?: number;
  targetLinks?: number;
  coveredMeters?: number;
  coveredLinks?: number;
  pct?: number;
  bbox?: [number, number, number, number] | null;
  /** A manager has signed this area off. Independent of `pct` on purpose — see AreaCompletion. */
  completed?: boolean;
  completedAt?: string | null;
  completedByName?: string | null;
  /**
   * Who holds this area, delivered with the polygon itself. Authoritative over the separately
   * fetched assignment list, which can be older than the map it is describing.
   */
  assignedTo?: string[];
}

interface AreaFeature {
  type: 'Feature';
  id?: string;
  geometry: Geometry;
  properties: AreaProps;
}

interface AreaCollection {
  type: 'FeatureCollection';
  bbox: [number, number, number, number] | null;
  approximated: number;
  features: AreaFeature[];
}

/** One snapped route as the API returns it: polyline6 chunks, one per matched stretch. */
interface TrackRow {
  tripId: string;
  driverId: string;
  driverName: string;
  startedAt: string;
  cleanedMeters: number;
  shapes: string[];
}

/** One drawable stretch. Chunks stay separate so a gap in the match is not bridged by a line. */
interface TrackPath {
  tripId: string;
  driverId: string;
  driverName: string;
  startedAt: string;
  cleanedMeters: number;
  path: [number, number][];
}

interface LinkRow {
  linkId: string;
  name: string | null;
  funcClass: number | null;
  dirTravel: string;
  lengthMeters: number;
  areaCode: string | null;
  coordinates: [number, number][];
  covered: boolean;
  /** Its area is signed off as completed — drawn as done whether or not a trip recorded it. */
  signedOff?: boolean;
}

/** Distinct hues per band. Deliberately not a ramp — priority is nominal, not ordinal, until the
 *  customer confirms what the ordering means. */
const PRIORITY_COLOR: Record<number, [number, number, number]> = {
  0: [148, 163, 184],
  1: [0, 80, 169],
  2: [37, 99, 235],
  3: [217, 119, 6],
};

const priorityColor = (p: number): [number, number, number] => PRIORITY_COLOR[p] || [107, 114, 128];

/** Slate at 0% to green at 100%, so an area's state reads without consulting a legend. */
function coverageColor(pct: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (pct || 0) / 100));
  return [
    Math.round(148 + (5 - 148) * t),
    Math.round(163 + (150 - 163) * t),
    Math.round(184 + (105 - 184) * t),
  ];
}

/** The pinned area card's width — also the room the camera leaves for it when framing an area. */
const POPUP_WIDTH = 320;

const km = (m: number) => (m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });

/**
 * Lets the polygon outline be dashed. Built once at module scope — deck.gl compares extensions by
 * identity, and a new instance per render would rebuild the layer on every frame.
 */
const DASHED_OUTLINE = new PathStyleExtension({ dash: true });
/** Dash in pixels, matching lineWidthUnits. [] is deck.gl's "draw this one solid". */
const DASH_PATTERN: [number, number] = [6, 4];
const SOLID: [number, number] = [0, 0];
/**
 * A pin must be seen: no depth test, so nothing the basemap extrudes can stand in front of it.
 * Same treatment as the trip markers and the replay vehicle.
 */
const ALWAYS_ON_TOP = { depthCompare: 'always', depthWriteEnabled: false } as const;

export function CoverageMap({
  versionId,
  importJobId,
  mode,
  height = 520,
  onSelectArea,
  focusAreaId,
  focusNonce = 0,
  selectedIds,
  onToggleSelect,
  driverColorByArea,
  driverNamesByArea,
  driverLegend,
  showAreas = true,
  roadScope = 'assigned',
  colorRoadsByDriver = false,
  assignedKey,
  showTracks = false,
  tracksFrom,
  tracksTo,
  tracksAreaId,
  driverColorById,
  driverFilter,
  highlightAreaIds,
  onTracksMeta,
  areaPopupId,
  areaPopup,
  driverPins,
  selectedPinId,
  onPickPin,
  pinPopup,
  pinTrail,
  focusPoint,
}: {
  /** A committed version — shows coverage and lets road links load. */
  versionId?: string;
  /** An uncommitted import — shows work areas read straight off the shapefile. */
  importJobId?: string;
  /**
   * What the polygons encode.
   *
   * `assignment` is the working view and carries TWO facts at once, because they are read
   * together — "Morgan has it, and it is 44% done". The outline says who holds it; the fill says
   * how much of it is driven. They used to be separate Driver and Coverage tabs, which meant
   * answering that one question took two clicks and a memory of the first picture.
   *
   * `priority` stays its own view: the customer's band is a label, not a quantity, so it cannot
   * share an encoding with a percentage.
   */
  mode: 'assignment' | 'priority';
  /** Pixels, or any CSS length — fullscreen passes '100vh'. */
  height?: number | string;
  onSelectArea?: (areaId: string) => void;
  /** Areas currently selected for assignment. Drawn with a heavy outline. */
  selectedIds?: string[];
  /** Click on a polygon. `additive` is true when shift/ctrl was held. */
  onToggleSelect?: (areaId: string, additive: boolean) => void;
  /** areaId -> colour of the driver holding it, for the 'driver' mode. */
  driverColorByArea?: Record<string, [number, number, number]>;
  /** areaId -> names of every driver holding it. Shown in the tooltip; the fill can only carry one
   *  colour, so this is where a shared area actually becomes legible. */
  driverNamesByArea?: Record<string, string[]>;
  /** Which colour is which person, and how much road they have driven on this network. */
  driverLegend?: { name: string; color: [number, number, number]; meters?: number }[];
  /** Frame this one area when it changes. The six clusters sit far apart, so arriving from the
   *  areas table has to land on the area you clicked rather than on the whole state. */
  focusAreaId?: string | null;
  /** Changes on every request to frame `focusAreaId`, so asking for the SAME area again — after
   *  panning away — still moves the camera. Without it the effect sees no change and does nothing. */
  focusNonce?: number;
  /** Draw the work-area polygons at all. Off leaves the roads on their own basemap. */
  showAreas?: boolean;
  /**
   * Which roads to draw, all in the same red/blue contract.
   *
   *   off      — none.
   *   assigned — every road in a held area: outstanding work included. Complete, any zoom.
   *   covered  — every road anyone has driven, project-wide, whoever holds it now. Complete, any
   *              zoom. This is the only scope that shows work whose assignment has been released
   *              or that arrived through a history import.
   *   all      — every road of the network, at full detail, at any zoom.
   *
   * All three draw from the same full-detail road files (lib/roadNetwork.ts), downloaded once and
   * kept by the browser; a scope only decides which of those roads are shown.
   */
  roadScope?: 'off' | 'assigned' | 'covered' | 'all';
  /**
   * Draw every road inside a polygon somebody currently holds — red still to drive, blue driven.
   *
   * Unlike the viewport scope this one is complete: it is the size of the territory actually out
   * with crews, not the size of the delivery, which is what lets a dispatcher read the whole
   * assigned picture zoomed out to a region.
   */
  /** Draw driven roads in the colour of whoever drove them, instead of the standard blue. */
  colorRoadsByDriver?: boolean;
  /** Changes when assignments or coverage move, so the layer refetches rather than going stale. */
  assignedKey?: string;
  /** Draw the fleet's snapped routes for the project over the network. */
  showTracks?: boolean;
  /** ISO dates. The window is what keeps this payload finite — see versionTracks on the backend. */
  tracksFrom?: string;
  tracksTo?: string;
  /** Limit tracks to trips recorded while this area was assigned. */
  tracksAreaId?: string | null;
  /** driverId -> colour, so a track and the polygons that driver holds read as one person. */
  driverColorById?: Record<string, [number, number, number]>;
  /**
   * Drivers the page is focused on. Empty/absent means everyone. Tracks are narrowed to them and
   * roads someone else drove are faded, so "what has Morgan done" reads without the rest vanishing.
   */
  driverFilter?: string[];
  /** Areas held by the filtered drivers; everything else is faded. Null = no filter. */
  highlightAreaIds?: Set<string> | null;
  /**
   * A card pinned beside one area — the click-a-polygon panel. It sits off the area's right edge
   * (left edge when there is no room) and follows the polygon as the camera moves, so the numbers
   * are read next to the shape they describe rather than in a corner of the map.
   */
  areaPopupId?: string | null;
  areaPopup?: ReactNode;
  /**
   * Where each driver left off: one pin per driver at the last fix of their last drive (or where
   * they are right now, if that drive is still open). Drawn above everything else.
   */
  driverPins?: DriverPin[];
  /** The picked pin's driver. Its card takes the place of the area card while it is picked. */
  selectedPinId?: string | null;
  /** A pin was clicked — or clicked again, which un-picks it (null). */
  onPickPin?: (driverId: string | null) => void;
  /** The card pinned beside the picked pin. */
  pinPopup?: ReactNode;
  /** The picked driver's last drive, drawn in their colour up to the pin. */
  pinTrail?: { color: [number, number, number]; paths: [number, number][][] } | null;
  /** Move the camera to this point. `nonce` changes per request, so asking twice still moves. */
  focusPoint?: { lon: number; lat: number; nonce: number } | null;
  /** Reports what came back, so the page can show the count and how many are still snapping. */
  onTracksMeta?: (meta: { count: number; pendingSnap: number; truncated: boolean }) => void;
}) {
  const mapRef = useRef<Map3DHandle>(null);
  const [areas, setAreas] = useState<AreaCollection | null>(null);
  /**
   * Markers drivers dropped on this delivery's ground (the last year), drawn as pins over the
   * roads — the reviewer sees "Road Is Impassable" where the red road is. Toggle in the legend.
   */
  const [fieldMarkers, setFieldMarkers] = useState<TripMarker[]>([]);
  const [showMarkers, setShowMarkers] = useState(true);
  const [pickedMarker, setPickedMarker] = useState<TripMarker | null>(null);
  const [tracks, setTracks] = useState<TrackPath[]>([]);
  const trackRequest = useRef(0);
  const [tracksLoading, setTracksLoading] = useState(false);
  /** Every road of each delivery in scope, at full detail (lib/roadNetwork.ts). */
  const [nets, setNets] = useState<RoadNet[]>([]);
  /** Which of those roads are driven, and which areas are held or signed off. */
  const [roadState, setRoadState] = useState<RoadState | null>(null);
  /** Download progress while road files come in; null when nothing is loading. */
  const [netLoading, setNetLoading] = useState<{ done: number; total: number; mb: number } | null>(null);
  const [netError, setNetError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const framed = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const areaPopupIdRef = useRef(areaPopupId);
  areaPopupIdRef.current = areaPopupId;

  const source = versionId
    ? `/api/network/versions/${versionId}/areas.geojson`
    : importJobId
      ? `/api/network/imports/${importJobId}/preview.geojson`
      : null;

  useEffect(() => {
    if (!source) return;
    setLoading(true);
    setError(null);
    framed.current = false;
    api
      .get<AreaCollection>(source)
      .then((fc) => {
        setAreas(fc);
        if (fc.bbox && !framed.current) {
          framed.current = true;
          // rAF so the camera move lands after MapLibre has sized its canvas.
          requestAnimationFrame(() => mapRef.current?.fitBounds(fc.bbox!, 11));
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load work areas'))
      .finally(() => setLoading(false));
  }, [source]);

  // A sign-off, a clear or an assignment changes what the polygons say (the completed border, the
  // fill, who holds it). Refetch them quietly — without re-framing the camera the reader has set.
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) { firstKey.current = false; return; }
    if (!source) return;
    api.get<AreaCollection>(source).then(setAreas).catch(() => {});
  }, [assignedKey, source]);

  // Frame a requested area once its outline is in hand. Runs on either ordering — the click can
  // arrive before or after the fetch resolves.
  useEffect(() => {
    if (!focusAreaId || !areas) return;
    const hit = areas.features.find((f) => f.properties.areaId === focusAreaId);
    const box = hit?.properties.bbox;
    if (box) {
      framed.current = true; // suppress the whole-extent fit that would otherwise fight this
      // When this area's card is about to open beside it, frame the polygon off-centre so the
      // card lands on empty map instead of on top of the streets being checked.
      const wide = (wrapRef.current?.clientWidth || 0) >= 760;
      const padding = wide && focusAreaId === areaPopupIdRef.current
        ? { top: 60, bottom: 60, left: 60, right: POPUP_WIDTH + 70 }
        : 48;
      requestAnimationFrame(() => mapRef.current?.fitBounds(box, 14, padding));
    }
  }, [focusAreaId, focusNonce, areas]);

  /**
   * Every road of the network, once. The files are keyed by what they contain, so the browser
   * keeps them between visits and only a changed delivery downloads again; they arrive one
   * delivery at a time and each is drawn as soon as it is in.
   */
  const wantRoads = Boolean(versionId) && roadScope !== 'off';
  useEffect(() => {
    if (!versionId || !wantRoads) {
      setNets([]);
      return undefined;
    }
    let alive = true;
    (async () => {
      setNetError(null);
      try {
        let list = await listRoadBlobs(versionId);
        if (!alive) return;
        // Deliveries that are no longer in view (another region picked) go at once.
        const wanted = new Set(list.map((b) => `${b.versionId}-${b.key}`));
        setNets((prev) => prev.filter((n) => wanted.has(`${n.versionId}-${n.key}`)));
        setNetLoading({ done: 0, total: list.length, mb: 0 });
        const got: RoadNet[] = [];
        let mbDone = 0;
        for (let i = 0; i < list.length; i++) {
          let net: RoadNet;
          try {
            // eslint-disable-next-line no-await-in-loop
            net = await loadRoadNet(list[i], (bytes) => {
              if (alive) setNetLoading({ done: i, total: list.length, mb: mbDone + bytes / 1e6 });
            });
          } catch (err) {
            // A delivery changed between listing and fetching (a split, a roads-only import).
            if (!(err as { stale?: boolean }).stale) throw err;
            // eslint-disable-next-line no-await-in-loop
            list = await listRoadBlobs(versionId);
            const fresh = list.find((b) => b.versionId === list[i]?.versionId) || list[i];
            if (!fresh) continue;
            // eslint-disable-next-line no-await-in-loop
            net = await loadRoadNet(fresh);
          }
          if (!alive) return;
          mbDone += (net.vertexCount * 8) / 1e6 / 4; // a rough figure for the bar; exact bytes vary
          got.push(net);
          setNets([...got]);
        }
        if (alive) setNets(got);
      } catch (e) {
        if (alive) setNetError(e instanceof Error ? e.message : 'Roads could not be loaded');
      } finally {
        if (alive) setNetLoading(null);
      }
    })();
    return () => {
      alive = false;
    };
    // assignedKey: a split or a roads-only import gives a delivery a new file.
  }, [versionId, wantRoads, assignedKey]);

  // What is driven, held and signed off — small, and fetched again whenever the page says the
  // picture moved (a sign-off, a clear, an assignment).
  const netKeys = nets.map((n) => `${n.versionId}-${n.key}`).join(',');
  useEffect(() => {
    if (!versionId || !nets.length) {
      setRoadState(null);
      return undefined;
    }
    let alive = true;
    loadRoadState(versionId, nets)
      .then((st) => { if (alive) setRoadState(st); })
      .catch((err) => {
        // Roads stay drawn, uncoloured by state, rather than vanish — but say why.
        // eslint-disable-next-line no-console
        console.warn('Road state could not be loaded', err);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId, netKeys, assignedKey]);

  // The fleet's snapped routes for this project. Nothing is drawn until the matcher has finished
  // with a trip — see versionTracks: raw GPS over a road network reads as coverage that the
  // ledger does not agree with.
  useEffect(() => {
    if (!versionId || !showTracks) {
      setTracks([]);
      return;
    }
    const params = new URLSearchParams();
    if (tracksFrom) params.set('from', tracksFrom);
    if (tracksTo) params.set('to', tracksTo);
    if (tracksAreaId) params.set('areaId', tracksAreaId);
    const ticket = ++trackRequest.current;
    setTracksLoading(true);
    api
      .get<{ tracks: TrackRow[]; pendingSnap: number; truncated: boolean }>(
        `/api/network/versions/${versionId}/tracks?${params}`
      )
      .then((r) => {
        if (ticket !== trackRequest.current) return;
        const paths: TrackPath[] = [];
        for (const t of r.tracks) {
          for (const shape of t.shapes) {
            const path = decodePolyline6(shape);
            // A one-point chunk is not a line; deck.gl would draw nothing and warn.
            if (path.length < 2) continue;
            paths.push({
              tripId: t.tripId,
              driverId: t.driverId,
              driverName: t.driverName,
              startedAt: t.startedAt,
              cleanedMeters: t.cleanedMeters,
              path,
            });
          }
        }
        setTracks(paths);
        onTracksMeta?.({
          count: r.tracks.length,
          pendingSnap: r.pendingSnap,
          truncated: r.truncated,
        });
      })
      .catch(() => {
        if (ticket === trackRequest.current) setTracks([]);
      })
      .finally(() => {
        if (ticket === trackRequest.current) setTracksLoading(false);
      });
  }, [versionId, showTracks, tracksFrom, tracksTo, tracksAreaId, onTracksMeta]);

  // The last camera the map settled on. Kept because roads can be switched on without the map
  // moving, and the only other source of the viewport is the move event itself — without this,
  // ticking the box did nothing at all until you happened to pan.
  const lastView = useRef<{ bbox: [number, number, number, number] } | null>(null);
  const lastZoom = useRef(0);

  // "Show me where this driver is": go there, close enough to read the streets, and never
  // further out than the reader already was.
  useEffect(() => {
    if (!focusPoint) return;
    framed.current = true; // a whole-extent fit arriving late must not pull the camera back
    const zoom = Math.max(lastZoom.current, 13.5);
    requestAnimationFrame(() => mapRef.current?.flyTo([focusPoint.lon, focusPoint.lat], zoom));
  }, [focusPoint]);

  const handleMoveEnd = useCallback((bbox: [number, number, number, number], zoom: number) => {
    lastView.current = { bbox };
    lastZoom.current = zoom;
  }, []);

  // getTooltip is created once; reading the prop directly would pin the first render's value and
  // the tooltip would name whoever held the area when the map first drew.
  const driverNamesRef = useRef(driverNamesByArea);
  driverNamesRef.current = driverNamesByArea;
  const netsRef = useRef(nets);
  netsRef.current = nets;
  const roadStateRef = useRef(roadState);
  roadStateRef.current = roadState;

  const selected = useMemo(() => new Set(selectedIds || []), [selectedIds]);
  // A primitive deck.gl can compare — a Set never differs by identity in a useMemo dep.
  const selectionKey = (selectedIds || []).join(',');
  const filterKey = (driverFilter || []).join(',');
  const driverSet = useMemo(() => new Set(driverFilter || []), [driverFilter]);
  const visibleTracks = useMemo(
    () => (driverSet.size ? tracks.filter((t) => driverSet.has(t.driverId)) : tracks),
    [tracks, driverSet]
  );

  /**
   * Colours and visibility per road, per delivery, worked out on the CPU once per change of state
   * or setting and handed to the GPU as typed arrays (one value per vertex, as deck.gl's binary
   * paths need). RED still to drive, BLUE driven — or signed off, which counts as done on this
   * map. A driven road takes its driver's colour when tinting is on, and fades when the page is
   * focused on other drivers.
   */
  const roadPaint = useMemo(() => {
    if (roadScope === 'off') return [];
    const drivers = roadState?.drivers || [];
    return nets.map((net) => {
      const per = roadState?.coveredBy.get(net.versionId);
      // Per area: 1 held by a driver, 2 signed off.
      const flags = new Uint8Array(net.areas.length);
      net.areas.forEach((a, i) => {
        if (roadState?.heldCodes.has(a.code)) flags[i] |= 1;
        if (roadState?.signedOffCodes.has(a.code)) flags[i] |= 2;
      });
      const colors = new Uint8Array(net.vertexCount * 4);
      const show = new Float32Array(net.vertexCount);
      let shown = 0;
      let driven = 0;
      for (let i = 0; i < net.linkCount; i++) {
        const ai = net.area[i];
        const f = ai === NO_AREA ? 0 : flags[ai];
        const d = per ? per[i] : -1;
        const covered = d >= 0;
        const visible = roadScope === 'all' || (roadScope === 'assigned' ? (f & 3) !== 0 : covered);
        if (!visible) continue;
        shown += 1;
        if (covered) driven += 1;
        let c: [number, number, number] = RED;
        let a = 225;
        // 1 = still to drive, 2 = done: drawn as separate layers (below) so the driven roads can
        // be the thicker ones at every zoom.
        let bucket = 1;
        if (covered) {
          bucket = 2;
          const who = d < drivers.length ? drivers[d].driverId : null;
          c = (colorRoadsByDriver && who && driverColorById?.[who]) || BLUE;
          if (driverSet.size > 0 && !(who && driverSet.has(who))) a = 45;
        } else if (f & 2) {
          c = BLUE;
          bucket = 2;
          if (driverSet.size > 0) a = 45;
        }
        for (let v = net.startIndices[i]; v < net.startIndices[i + 1]; v++) {
          const o = v * 4;
          colors[o] = c[0];
          colors[o + 1] = c[1];
          colors[o + 2] = c[2];
          colors[o + 3] = a;
          show[v] = bucket;
        }
      }
      return { net, colors, show, shown, driven };
    });
  }, [nets, roadState, roadScope, colorRoadsByDriver, driverColorById, driverSet]);

  /**
   * Two layers per delivery over the SAME binary: the roads still to drive first, thin; the driven
   * roads on top, thick. Colour alone was not enough — at a glance the eye reads width before hue,
   * so the work done is the heavier line and what is left sits as the thin red mesh behind it. The
   * layers share positions and colours; only the filter value (1 to-drive, 2 done) differs.
   */
  const roadLayers = useMemo<Layer[]>(
    () =>
      roadPaint.flatMap(({ net, colors, show }) =>
        (
          [
            { suffix: 'todo', range: [0.5, 1.5], width: 3, min: 1.3, max: 6 },
            { suffix: 'done', range: [1.5, 2.5], width: 5, min: 2.4, max: 10 },
          ] as const
        ).map(
          (b) =>
            new PathLayer({
              id: `roads-${net.versionId}-${b.suffix}`,
              data: {
                length: net.linkCount,
                startIndices: net.startIndices,
                attributes: {
                  getPath: { value: net.positions, size: 2 },
                  getColor: { value: colors, size: 4, normalized: true },
                  getFilterValue: { value: show, size: 1 },
                },
              },
              // The binary is used as-is: open paths, offsets from the delivery's own centre
              // (float32 near an origin is precise to centimetres; absolute longitudes are not).
              _pathType: 'open',
              coordinateSystem: COORDINATE_SYSTEM.LNGLAT_OFFSETS,
              coordinateOrigin: [net.origin[0], net.origin[1], 0],
              getWidth: b.width,
              widthUnits: 'meters',
              widthMinPixels: b.min,
              widthMaxPixels: b.max,
              capRounded: true,
              jointRounded: true,
              pickable: true,
              extensions: [ROAD_FILTER],
              filterRange: b.range,
            } as never)
        )
      ),
    [roadPaint]
  );

  const areaBbox = areas?.bbox ? areas.bbox.join(',') : '';
  useEffect(() => {
    setFieldMarkers([]);
    setPickedMarker(null);
    if (!areaBbox) return undefined;
    const [w, s, e, n] = areaBbox.split(',').map(Number);
    const pad = 0.02; // a marker on the boundary street still belongs to the map
    let alive = true;
    api
      .get<{ markers: TripMarker[] }>(`/api/markers?days=365&bbox=${[w - pad, s - pad, e + pad, n + pad].join(',')}`)
      .then((r) => { if (alive) setFieldMarkers(r.markers); })
      .catch(() => { /* auxiliary — the coverage map must not degrade over it */ });
    return () => { alive = false; };
  }, [areaBbox]);

  const layers = useMemo<Layer[]>(() => {
    // The fill is always a quantity: how much of the area is driven, or which band it sits in.
    const shadeOf = (p: AreaProps): [number, number, number] =>
      mode === 'assignment' ? coverageColor(p.pct || 0) : priorityColor(p.priority);

    /**
     * Held by somebody right now. The polygon's own `assignedTo` is the truth; the colour map is
     * only a fallback for an older server that does not send it yet.
     */
    const isAssigned = (p: AreaProps) =>
      (p.assignedTo ? p.assignedTo.length > 0 : false) || Boolean(driverColorByArea?.[p.areaId || '']);
    /**
     * An assigned polygon is drawn as an OUTLINE, with no fill at all.
     *
     * The fill is what hides the roads inside it, and once the assigned network is on the map
     * those roads — red outstanding, blue driven — are the thing being read. A translucent wash
     * over them costs more than it says: the polygon's boundary already carries the whole of
     * "this belongs to someone", and the driver legend below carries who.
     */
    const OUTLINE_ONLY: [number, number, number, number] = [0, 0, 0, 0];
    // Green outlines, so an area boundary never reads as a road: blue on this map means driven.
    const AREA_GREEN: [number, number, number, number] = [22, 163, 74, 255];

    /** Outside the driver filter: kept on the map for context, but pushed well back. */
    const isFaded = (p: AreaProps) =>
      Boolean(highlightAreaIds) && !highlightAreaIds!.has(p.areaId || '') && !selected.has(p.areaId || '');

    const out: Layer[] = [];

    if (showAreas && areas?.features.length) {
      out.push(
        new GeoJsonLayer<AreaProps>({
          id: 'work-areas',
          data: areas as unknown as never,
          pickable: true,
          stroked: true,
          filled: true,
          getFillColor: (f: { properties: AreaProps }) => {
            const id = f.properties.areaId || '';
            if (selected.has(id)) return [0, 80, 169, 190]; // selected reads first, before hue
            /**
             * An assigned area keeps NO fill while its roads are on the map.
             *
             * Those roads are the same fact at higher resolution — red outstanding, blue driven —
             * so a percentage wash over them would bury the detail to restate the summary. Switch
             * the assigned-routes layer off and the fill comes back, because then the polygon is
             * the only thing left carrying it.
             */
            if (mode === 'assignment' && roadScope !== 'off' && isAssigned(f.properties)) {
              return OUTLINE_ONLY;
            }
            const c = shadeOf(f.properties);
            // Translucent so the basemap's streets stay readable underneath — the fill is a
            // summary, not a mask.
            return [c[0], c[1], c[2], isFaded(f.properties) ? 25 : 110];
          },
          // The outline answers "whose is this", independently of the fill's percentage.
          getLineColor: (f: { properties: AreaProps }) => {
            const id = f.properties.areaId || '';
            if (selected.has(id)) return [91, 33, 182, 255];
            if (isFaded(f.properties)) return [100, 116, 139, 70];
            // A signed-off area gets an emerald border. Deliberately the OUTLINE and not the fill:
            // completion and percentage are independent facts, and a manager needs to read both
            // at once — "done" and "done at 44%" is a real combination.
            if (f.properties.completed) return [6, 95, 70, 255]; // deep green, drawn thickest
            if (mode === 'assignment') {
              // Both green: an area is an area. Solid means someone holds it, dashed means it is
              // still waiting — the same language the delivered design used.
              return isAssigned(f.properties) ? AREA_GREEN : [22, 163, 74, 200];
            }
            const c = shadeOf(f.properties);
            return [c[0], c[1], c[2], 235];
          },
          // Selected polygons get a heavy border so a chosen cluster is legible even where the
          // areas are tiny and packed, which is most of inner Melbourne.
          // An assigned outline has to carry on its own what a fill used to say, so it is drawn
          // heavier than an unassigned one.
          getLineWidth: (f: { properties: AreaProps }) =>
            selected.has(f.properties.areaId || '')
              ? 3
              : f.properties.completed
                ? 3
                : isAssigned(f.properties)
                  ? 2
                  : 1,
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1.2,
          /**
           * Dashed while unassigned, solid once it is somebody's. Selected and completed areas
           * stay solid, so the state being acted on is never the ambiguous one.
           *
           * Spread through a cast because PathStyleExtension contributes `extensions` and
           * `getDashArray` at runtime and GeoJsonLayer's prop type does not know about them. The
           * cast is deliberately confined to these two props rather than loosening the layer.
           */
          ...({
            extensions: [DASHED_OUTLINE],
            getDashArray: (f: { properties: AreaProps }) =>
              mode === 'assignment' &&
              !isAssigned(f.properties) &&
              !f.properties.completed &&
              !selected.has(f.properties.areaId || '')
                ? DASH_PATTERN
                : SOLID,
          } as object),
          updateTriggers: {
            // deck.gl caches accessor results; without naming every input here a selection would
            // change state but not repaint.
            getFillColor: [mode, selectionKey, driverColorByArea, roadScope, highlightAreaIds],
            getLineColor: [mode, selectionKey, driverColorByArea, highlightAreaIds],
            // Width now depends on whether an area is assigned, so the colour map belongs here too
            // — without it, assigning an area would recolour its outline but not thicken it.
            getLineWidth: [selectionKey, driverColorByArea],
          },
          onClick: (info: PickingInfo & { srcEvent?: MouseEvent }) => {
            const props = (info.object as AreaFeature | undefined)?.properties;
            if (!props?.areaId) return;
            if (onToggleSelect) {
              const e = info.srcEvent;
              onToggleSelect(props.areaId, Boolean(e && (e.shiftKey || e.ctrlKey || e.metaKey)));
            } else if (onSelectArea) {
              onSelectArea(props.areaId);
            }
          },
        })
      );
    }

    // Under the road layers on purpose: the tracks say where the fleet went, the roads say what
    // that earned. When they disagree — a street driven but not claimed — the road's colour is
    // the one that must win the eye.
    if (visibleTracks.length) {
      out.push(
        new PathLayer<TrackPath>({
          id: 'driven-tracks',
          data: visibleTracks,
          pickable: true,
          getPath: (d) => d.path,
          // Coloured by driver, with the same palette the polygons use, so a track and the areas
          // that person holds read as one crew.
          getColor: (d) => {
            const c = driverColorById?.[d.driverId] || [124, 58, 237];
            return [c[0], c[1], c[2], 200];
          },
          getWidth: 3,
          widthUnits: 'meters',
          widthMinPixels: 1.5,
          widthMaxPixels: 6,
          capRounded: true,
          jointRounded: true,
          updateTriggers: { getColor: [driverColorById] },
        })
      );
    }

    // The picked driver's last drive, up to their pin. Where the tracks are — under the roads —
    // and wider than them, so it reads as a band behind the red and blue rather than repainting it.
    if (pinTrail && pinTrail.paths.length) {
      const trailColor: [number, number, number, number] = [...pinTrail.color, 215];
      out.push(
        new PathLayer<[number, number][]>({
          id: 'last-drive',
          data: pinTrail.paths,
          getPath: (d) => d,
          getColor: trailColor,
          getWidth: 12,
          widthUnits: 'meters',
          widthMinPixels: 5,
          widthMaxPixels: 14,
          capRounded: true,
          jointRounded: true,
        })
      );
    }

    // Every road of the network, one binary layer per delivery — see roadLayers below.
    out.push(...roadLayers);

    if (driverPins && driverPins.length) {
      // A ring on the ground at the exact spot: green under whoever is moving right now, the
      // driver's own colour under the picked pin.
      const ringed = driverPins.filter((p) => p.state === 'moving' || p.driverId === selectedPinId);
      if (ringed.length) {
        out.push(
          new ScatterplotLayer<DriverPin>({
            id: 'driver-pin-rings',
            data: ringed,
            getPosition: (d) => [d.lon, d.lat],
            getFillColor: (d) =>
              d.state === 'moving' ? [5, 150, 105, 60] : [d.color[0], d.color[1], d.color[2], 55],
            getLineColor: (d) =>
              d.state === 'moving' ? [5, 150, 105, 230] : [d.color[0], d.color[1], d.color[2], 230],
            stroked: true,
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            getRadius: (d) => (d.driverId === selectedPinId ? 15 : 11),
            radiusUnits: 'pixels',
            parameters: ALWAYS_ON_TOP,
            updateTriggers: { getRadius: [selectedPinId], getFillColor: [selectedPinId], getLineColor: [selectedPinId] },
          })
        );
      }
      out.push(
        new IconLayer<DriverPin>({
          id: 'driver-pins',
          data: driverPins,
          pickable: true,
          getPosition: (d) => [d.lon, d.lat],
          getIcon: (d) => pinIcon(d.name, d.color, d.state),
          // Pixels, not metres: this map is read at the scale of a state, where a pin sized like
          // a vehicle would be a speck. The same size at every zoom, a little larger when picked.
          getSize: (d) => (d.driverId === selectedPinId ? PIN_SIZE * 1.2 : PIN_SIZE),
          sizeUnits: 'pixels',
          // The icon is full colour, so only the alpha is used: an old position is drawn fainter.
          getColor: (d) => [255, 255, 255, d.alpha],
          parameters: ALWAYS_ON_TOP,
          updateTriggers: { getSize: [selectedPinId] },
          onClick: (info: PickingInfo) => {
            const pin = info.object as DriverPin | undefined;
            if (!pin) return false;
            onPickPin?.(pin.driverId === selectedPinId ? null : pin.driverId);
            // Handled: the polygon underneath must not also take this click as a selection.
            return true;
          },
        })
      );
    }

    if (showMarkers && fieldMarkers.length > 0) {
      out.push(
        new IconLayer<TripMarker>({
          id: 'field-markers',
          data: fieldMarkers,
          pickable: true,
          getPosition: (m) => [m.lon, m.lat],
          getIcon: (m) => ({ url: pinUrl(m.category?.color), width: 48, height: 64, anchorY: 62 }),
          // Pixels: this map is read at the scale of a region, where a pin sized in metres vanishes.
          getSize: 30,
          sizeUnits: 'pixels',
          parameters: ALWAYS_ON_TOP,
          onClick: (info: PickingInfo) => {
            const m = info.object as TripMarker | undefined;
            if (!m) return false;
            setPickedMarker(m);
            // Handled: the area underneath must not also take this click.
            return true;
          },
        })
      );
    }

    return out;
  }, [
    showMarkers,
    fieldMarkers,
    driverPins,
    selectedPinId,
    onPickPin,
    pinTrail,
    areas,
    roadLayers,
    visibleTracks,
    driverColorById,
    colorRoadsByDriver,
    driverSet,
    filterKey,
    highlightAreaIds,
    roadScope,
    showAreas,
    mode,
    onSelectArea,
    onToggleSelect,
    selected,
    selectionKey,
    driverColorByArea,
  ]);

  const getTooltip = useCallback((info: PickingInfo) => {
    const layerId = info.layer?.id || '';
    if (layerId === 'field-markers' && info.object) {
      const m = info.object as TripMarker;
      return {
        html: `<div style="font:12px/1.5 system-ui;padding:2px"><b>${escapeHtml(m.category?.name ?? 'Marker')}</b><div>${escapeHtml(
          [m.driverName, m.vehiclePlate].filter(Boolean).join(' '),
        )}</div><div style="opacity:.7">${escapeHtml(new Date(m.recordedAt).toLocaleString())}</div></div>`,
      };
    }
    if (layerId.startsWith('roads-') && info.index >= 0) {
      const net = netsRef.current.find((n) => layerId.startsWith(`roads-${n.versionId}-`));
      if (!net) return null;
      const st = roadStateRef.current;
      const d = st?.coveredBy.get(net.versionId)?.[info.index] ?? -1;
      const ai = net.area[info.index];
      const area = ai === NO_AREA ? null : net.areas[ai];
      const signed = Boolean(area && st?.signedOffCodes.has(area.code));
      const who = d >= 0 && st && d < st.drivers.length ? st.drivers[d].name : null;
      const fc = net.fc[info.index];
      return {
        html: `<div style="font:12px/1.5 system-ui;padding:2px"><b>${
          d >= 0 ? '✓ driven' : signed ? '✓ area signed off' : 'not driven yet'
        }</b>${who ? `<div>by ${escapeHtml(who)}</div>` : ''}${
          d < 0 && signed ? '<div style="opacity:.7">no trip recorded on it</div>' : ''
        }<div style="opacity:.7">${fc ? `FC${fc}` : 'FC ?'}${area ? ` · ${escapeHtml(area.name)}` : ' · outside every area'}</div><div style="opacity:.55;font-family:monospace;font-size:11px">${escapeHtml(
          linkIdAt(net, info.index)
        )}</div></div>`,
      };
    }
    const obj = info.object as (AreaFeature & LinkRow & TrackPath) | undefined;
    if (!obj) return null;

    if ((obj as unknown as DriverPin).kind === 'pin') {
      const pin = obj as unknown as DriverPin;
      return {
        html: `<div style="font:12px/1.5 system-ui;padding:2px"><b>${escapeHtml(pin.name)}</b><div>${escapeHtml(
          pin.status
        )}</div><div style="opacity:.7">${escapeHtml(pin.where)}</div></div>`,
      };
    }

    if (obj.tripId) {
      return {
        html: `<div style="font:12px/1.5 system-ui;padding:2px"><b>${obj.driverName}</b><div style="opacity:.7">${new Date(
          obj.startedAt
        ).toLocaleString()}</div><div style="margin-top:3px">${(obj.cleanedMeters / 1000).toFixed(1)} km snapped</div></div>`,
      };
    }

    if ('properties' in obj && obj.properties) {
      const p = obj.properties;
      const rows: string[] = [];
      if (p.parentName) rows.push(`<div style="opacity:.7">${p.parentName}</div>`);
      rows.push(`<div style="opacity:.7">P${p.priority} · ${p.areaCode}</div>`);
      // Same source the fill uses, so the hover can never contradict the panel.
      const holders = p.assignedTo?.length
        ? p.assignedTo
        : driverNamesRef.current?.[p.areaId || ''] || [];
      rows.push(
        holders.length
          ? `<div style="margin-top:4px"><b>${holders.join(', ')}</b></div>`
          : '<div style="margin-top:4px;opacity:.6">Unassigned</div>'
      );
      if (typeof p.targetMeters === 'number') {
        rows.push(
          `<div style="margin-top:4px">${km(p.coveredMeters || 0)} / ${km(p.targetMeters)} km · <b>${(p.pct || 0).toFixed(1)}%</b></div>`
        );
        rows.push(`<div style="opacity:.7">${(p.targetLinks || 0).toLocaleString()} links</div>`);
      }
      if (p.completed) {
        rows.push(
          `<div style="margin-top:4px;color:#059669"><b>✓ Completed</b>${
            p.completedByName ? ` · ${p.completedByName}` : ''
          }</div>`
        );
      }
      return {
        html: `<div style="font:12px/1.5 system-ui;padding:2px"><b>${p.name || p.areaCode}</b>${rows.join('')}</div>`,
      };
    }

    return null;
  }, []);

  const roadsShown = roadPaint.reduce((n, r) => n + r.shown, 0);
  const roadsDriven = roadPaint.reduce((n, r) => n + r.driven, 0);
  const linksHint = !versionId
    ? 'Road links appear once the import is committed'
    : roadScope === 'off'
      ? 'Roads hidden — switch on a road layer to draw them'
      : netError
        ? `Roads could not be loaded — ${netError}`
        : netLoading
          ? `Loading every road at full detail… ${netLoading.mb.toFixed(0)} MB${
              netLoading.total > 1 ? ` · delivery ${netLoading.done + 1} of ${netLoading.total}` : ''
            } (first time only — kept by the browser after this)`
          : nets.length && !roadState
            ? `${nets.reduce((n, x) => n + x.linkCount, 0).toLocaleString()} roads drawn · checking which are driven…`
            : roadsShown
            ? `${roadsShown.toLocaleString()} ${
                roadScope === 'covered' ? 'driven roads' : roadScope === 'assigned' ? 'roads in assigned areas' : 'roads'
              }${roadScope === 'covered' ? '' : ` · ${roadsDriven.toLocaleString()} driven (${((roadsDriven / roadsShown) * 100).toFixed(0)}%)`} · ${
                colorRoadsByDriver ? 'driven roads take the driver’s colour (thick), thin red = still to drive' : 'thick blue = done, thin red = still to drive'
              }`
            : nets.length
              ? roadScope === 'assigned' ? 'No area is out with a driver' : 'Nothing driven yet'
              : '';

  // One card at a time. A picked pin's card takes the place of the area's: the reader asked about
  // the driver, and two callouts on one map end up on top of each other.
  const pickedPin = (selectedPinId && driverPins?.find((p) => p.driverId === selectedPinId)) || null;
  const pinCardOpen = Boolean(pickedPin && pinPopup);
  const pinLon = pinCardOpen ? pickedPin!.lon : null;
  const pinLat = pinCardOpen ? pickedPin!.lat : null;

  const popupBox = useMemo(() => {
    // A pin is a point: a box with no extent, which the placement below handles like any other.
    if (pinLon != null && pinLat != null) return [pinLon, pinLat, pinLon, pinLat];
    if (!areaPopupId || !areas) return null;
    const box = areas.features.find((f) => f.properties.areaId === areaPopupId)?.properties.bbox;
    return box && box.length === 4 ? box : null;
  }, [areaPopupId, areas, pinLon, pinLat]);
  const popupBoxRef = useRef(popupBox);
  popupBoxRef.current = popupBox;
  const pinCardRef = useRef(pinCardOpen);
  pinCardRef.current = pinCardOpen;

  /**
   * Pin the card beside the area. Written straight to the element's style because it runs on
   * every camera frame — a React state update per frame would re-render the whole map layer set.
   */
  const placePopup = useCallback(() => {
    const el = popupRef.current;
    const wrap = wrapRef.current;
    const box = popupBoxRef.current;
    if (!el || !wrap) return;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;

    // Narrow map: a callout beside a polygon has nowhere to go, so dock it as a bottom sheet.
    if (W < 560 || !box) {
      el.className = 'cov-area-pop docked';
      el.style.transform = '';
      return;
    }

    const [w, s, e, n] = box;
    const midLat = (s + n) / 2;
    const east = mapRef.current?.project([e, midLat]);
    const west = mapRef.current?.project([w, midLat]);
    const north = mapRef.current?.project([(w + e) / 2, n]);
    const south = mapRef.current?.project([(w + e) / 2, s]);
    if (!east || !west || !north || !south) return;

    const pw = el.offsetWidth;
    const ph = el.offsetHeight;
    // Beside a pin the card clears the teardrop, and points at its head rather than at its tip.
    const forPin = pinCardRef.current;
    const GAP = forPin ? 30 : 14;
    const EDGE = 10;
    const anchorY = (north[1] + south[1]) / 2 - (forPin ? 28 : 0);

    // Right of the area first; the left if that would run off the map; otherwise whichever side
    // has more room, clamped inside the frame.
    let side: 'right' | 'left' = 'right';
    let x = east[0] + GAP;
    if (x + pw > W - EDGE) {
      const lx = west[0] - GAP - pw;
      if (lx >= EDGE) { x = lx; side = 'left'; }
      else if (W - east[0] < west[0]) { x = Math.max(EDGE, lx); side = 'left'; }
    }
    x = Math.min(Math.max(EDGE, x), W - pw - EDGE);
    const y = Math.min(Math.max(EDGE, anchorY - ph / 2), Math.max(EDGE, H - ph - EDGE));

    // The caret points at the area's middle, and only while that middle is actually on screen.
    const caretY = anchorY - y;
    const anchorVisible = anchorY > 0 && anchorY < H && east[0] > 0 && west[0] < W;
    const caretOk = anchorVisible && caretY > 16 && caretY < ph - 16;

    el.className = `cov-area-pop side-${side}${caretOk ? '' : ' no-caret'}`;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.style.setProperty('--caret-y', `${Math.round(caretY)}px`);
  }, []);

  // Re-place when the area changes, when its outline arrives, and whenever the card's own size
  // changes (it loads in two steps: a "Loading…" line, then the full numbers).
  useLayoutEffect(() => {
    placePopup();
    const el = popupRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => placePopup());
    ro.observe(el);
    return () => ro.disconnect();
  }, [placePopup, popupBox, areaPopupId, pinCardOpen]);

  return (
    <div ref={wrapRef} className="cov-map" style={{ height }}>
      <Map3D
        ref={mapRef}
        center={[144.96, -37.81]}
        zoom={7}
        pitch={0}
        layers={layers}
        getTooltip={getTooltip}
        onMoveEnd={handleMoveEnd}
        onMove={placePopup}
      />

      {pinCardOpen ? (
        <div key="pin" ref={popupRef} className="cov-area-pop" role="dialog" aria-label="Selected driver">
          {pinPopup}
        </div>
      ) : (
        areaPopupId && areaPopup && (
          <div key="area" ref={popupRef} className="cov-area-pop" role="dialog" aria-label="Selected area">
            {areaPopup}
          </div>
        )
      )}

      {pickedMarker && showMarkers && (
        <MarkerCard marker={pickedMarker} onClose={() => setPickedMarker(null)} style={{ zIndex: 6 }} />
      )}

      <div className="cov-map-legend">
        {mode === 'assignment' ? (
          <>
            {/* Outline first, because it is the fact people look for: whose is this. */}
            <div className="cov-legend-row">
              <span className="cov-line" style={{ background: 'rgb(22,163,74)' }} />
              <span>assigned</span>
              <span
                className="cov-line"
                style={{ background: 'none', borderTop: '2px dashed rgb(22,163,74)', height: 0 }}
              />
              <span>unassigned</span>
              <span className="cov-line" style={{ background: 'rgb(6,95,70)', height: 4 }} />
              <span>completed</span>
            </div>
            <div className="cov-legend-row">
              <span className="cov-swatch" style={{ background: 'rgb(148,163,184)' }} />
              <span className="cov-swatch" style={{ background: 'rgb(76,156,144)' }} />
              <span className="cov-swatch" style={{ background: 'rgb(5,150,105)' }} />
              <span>fill: 0% → 100% driven</span>
            </div>
            {(driverLegend || []).length > 0 && (
              <div className="cov-legend-drivers">
                {(driverLegend || []).slice(0, 10).map((d) => (
                  <span key={d.name} className="cov-legend-row" style={{ gap: 5 }}>
                    <span className="cov-swatch" style={{ background: `rgb(${d.color.join(',')})` }} />
                    <span>
                      {d.name}
                      {/* The kilometres are the point: a name with 0 km is a test account holding
                          an empty area, and a name with 3,701 km is where the work went. */}
                      {typeof d.meters === 'number' && (
                        <span style={{ color: 'var(--muted)' }}> · {km(d.meters)} km</span>
                      )}
                    </span>
                  </span>
                ))}
                {(driverLegend || []).length > 10 && (
                  <span className="cov-legend-note">+{(driverLegend || []).length - 10} more</span>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="cov-legend-row">
            {[0, 1, 2, 3].map((p) => (
              <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span className="cov-swatch" style={{ background: `rgb(${priorityColor(p).join(',')})` }} />
                P{p}
              </span>
            ))}
          </div>
        )}
        <div className="cov-legend-note">{linksHint}</div>
        {fieldMarkers.length > 0 && (
          <label className="cov-legend-row" style={{ cursor: 'pointer', gap: 6 }}>
            <input type="checkbox" checked={showMarkers} onChange={(e) => setShowMarkers(e.target.checked)} />
            <img src={pinUrl('#ef4444')} alt="" width={11} height={15} />
            <span>
              {fieldMarkers.length} marker{fieldMarkers.length === 1 ? '' : 's'} dropped by drivers · click one for details
            </span>
          </label>
        )}
        {driverPins && driverPins.length > 0 && (
          <div className="cov-legend-note">
            Pins: where each driver’s last drive ended · green dot = driving now
          </div>
        )}
        {onToggleSelect && (
          <div className="cov-legend-note">
            Click an area to select it · shift-click to add more
          </div>
        )}
        {areas && areas.approximated > 0 && (
          <div className="cov-legend-note" style={{ color: 'var(--amber)' }}>
            {areas.approximated} area(s) drawn as bounding boxes — re-import to store real outlines
          </div>
        )}
      </div>

      {!loading && (netLoading || tracksLoading) && (
        <div className="cov-map-busy" role="status">
          <span className="cov-spinner" />
          Loading{tracksLoading ? ' tracks' : ' roads'}…
        </div>
      )}

      {(loading || error) && (
        <div className="cov-map-overlay">
          {error ? <span style={{ color: 'var(--red)' }}>{error}</span> : 'Loading work areas…'}
        </div>
      )}
    </div>
  );
}
