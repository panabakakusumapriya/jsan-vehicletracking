import type { Layer, PickingInfo } from '@deck.gl/core';
import { PathStyleExtension } from '@deck.gl/extensions';
import { GeoJsonLayer, PathLayer } from '@deck.gl/layers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { decodePolyline6 } from '../lib/polyline';
import { Map3D, type Map3DHandle } from '../lib/map3d/Map3D';

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

// The viewport scope's cap. Higher than the old browse limit because this layer is now the answer
// to "show me the roads", not a teaser that expected you to zoom in — but still a cap, because all
// 402 polygons together hold 653,494 links.
const INVIEW_LINK_LIMIT = 30000;
// One area at a time, so a bigger cap is affordable: the largest area in delivery 1 holds ~4,800
// links. The server caps the parameter at 10,000 regardless.
const AREA_LINK_LIMIT = 10000;

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

/**
 * A road inside an assigned area, as positional tuples: [linkId, funcClass, covered, coords].
 * No field names on the wire — at 100k links the key names would cost more than the coordinates.
 */
type AssignedLinkTuple = [string, number | null, 0 | 1, [number, number][], number];

interface AssignedLink {
  linkId: string;
  funcClass: number | null;
  covered: boolean;
  path: [number, number][];
  /** Who first drove it, so the road can be drawn in that person's colour. */
  driverId: string | null;
  driverName: string | null;
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

const km = (m: number) => (m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });

/**
 * Lets the polygon outline be dashed. Built once at module scope — deck.gl compares extensions by
 * identity, and a new instance per render would rebuild the layer on every frame.
 */
const DASHED_OUTLINE = new PathStyleExtension({ dash: true });
/** Dash in pixels, matching lineWidthUnits. [] is deck.gl's "draw this one solid". */
const DASH_PATTERN: [number, number] = [6, 4];
const SOLID: [number, number] = [0, 0];

export function CoverageMap({
  versionId,
  importJobId,
  mode,
  height = 520,
  onSelectArea,
  focusAreaId,
  selectedIds,
  onToggleSelect,
  driverColorByArea,
  driverNamesByArea,
  driverLegend,
  showAreas = true,
  roadScope = 'assigned',
  colorRoadsByDriver = false,
  assignedKey,
  areaRoadsFor,
  showTracks = false,
  tracksFrom,
  tracksTo,
  tracksAreaId,
  driverColorById,
  onTracksMeta,
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
  height?: number;
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
   *   inview   — every road in EVERY polygon, bounded by the viewport instead of by assignment.
   *              It has to be bounded by something: all 402 areas hold 653,494 links, five times
   *              what the complete scopes can ship, so this one draws what is on screen and says
   *              plainly when it has truncated.
   */
  roadScope?: 'off' | 'assigned' | 'covered' | 'inview';
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
  /**
   * Load and draw every road inside this ONE area, whatever the zoom.
   *
   * The viewport loader deliberately refuses below zoom 11.5 — 61,563 km of hairlines at country
   * zoom is a grey smear. That rule is right for browsing and wrong for verifying: a manager
   * checking whether a suburb is finished needs to see the whole suburb's streets at once, framed
   * on the area rather than on whatever happens to be in view. Scoped by areaId, so the request
   * is bounded by the area rather than by the screen.
   */
  areaRoadsFor?: string | null;
  /** Draw the fleet's snapped routes for the project over the network. */
  showTracks?: boolean;
  /** ISO dates. The window is what keeps this payload finite — see versionTracks on the backend. */
  tracksFrom?: string;
  tracksTo?: string;
  /** Limit tracks to trips recorded while this area was assigned. */
  tracksAreaId?: string | null;
  /** driverId -> colour, so a track and the polygons that driver holds read as one person. */
  driverColorById?: Record<string, [number, number, number]>;
  /** Reports what came back, so the page can show the count and how many are still snapping. */
  onTracksMeta?: (meta: { count: number; pendingSnap: number; truncated: boolean }) => void;
}) {
  const mapRef = useRef<Map3DHandle>(null);
  const [areas, setAreas] = useState<AreaCollection | null>(null);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [tracks, setTracks] = useState<TrackPath[]>([]);
  const trackRequest = useRef(0);
  const [assignedLinks, setAssignedLinks] = useState<AssignedLink[]>([]);
  const [assignedLoading, setAssignedLoading] = useState(false);
  const assignedRequest = useRef(0);
  // Roads for one whole area, loaded independently of the viewport loader below.
  const [areaLinks, setAreaLinks] = useState<LinkRow[]>([]);
  const [areaLinksLoading, setAreaLinksLoading] = useState(false);
  const areaLinkRequest = useRef(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [linksLoading, setLinksLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const framed = useRef(false);

  // Guards a slow response for a viewport the user has already left from overwriting a newer one.
  const linkRequest = useRef(0);

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

  // Frame a requested area once its outline is in hand. Runs on either ordering — the click can
  // arrive before or after the fetch resolves.
  useEffect(() => {
    if (!focusAreaId || !areas) return;
    const hit = areas.features.find((f) => f.properties.areaId === focusAreaId);
    const box = hit?.properties.bbox;
    if (box) {
      framed.current = true; // suppress the whole-extent fit that would otherwise fight this
      requestAnimationFrame(() => mapRef.current?.fitBounds(box, 14));
    }
  }, [focusAreaId, areas]);

  // Every road in a held area. One request per version — not per pan — because the answer does
  // not depend on where the camera is.
  useEffect(() => {
    if (!versionId || (roadScope !== 'assigned' && roadScope !== 'covered')) {
      setAssignedLinks([]);
      return;
    }
    const ticket = ++assignedRequest.current;
    setAssignedLoading(true);
    api
      .get<{
        links: AssignedLinkTuple[];
        truncated: boolean;
        drivers: { driverId: string; name: string }[];
      }>(`/api/network/versions/${versionId}/assigned-links?scope=${roadScope}`)
      .then((r) => {
        if (ticket !== assignedRequest.current) return;
        // The wire format indexes into a short driver list rather than repeating a 24-character
        // id on every one of tens of thousands of links.
        const who = r.drivers || [];
        setAssignedLinks(
          r.links.map(([linkId, funcClass, covered, path, driverIdx]) => ({
            linkId,
            funcClass,
            covered: covered === 1,
            path,
            driverId: driverIdx >= 0 && who[driverIdx] ? who[driverIdx].driverId : null,
            driverName: driverIdx >= 0 && who[driverIdx] ? who[driverIdx].name : null,
          }))
        );
      })
      .catch(() => {
        if (ticket === assignedRequest.current) setAssignedLinks([]);
      })
      .finally(() => {
        if (ticket === assignedRequest.current) setAssignedLoading(false);
      });
  }, [versionId, roadScope, assignedKey]);

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
      });
  }, [versionId, showTracks, tracksFrom, tracksTo, tracksAreaId, onTracksMeta]);

  // Every road inside one area, at any zoom. Bounded by the area's own bbox AND by areaId, so a
  // request stays the size of a suburb rather than the size of the screen.
  useEffect(() => {
    if (!versionId || !areaRoadsFor || !areas || roadScope === 'off') {
      setAreaLinks([]);
      return;
    }
    const box = areas.features.find((f) => f.properties.areaId === areaRoadsFor)?.properties.bbox;
    if (!box) {
      setAreaLinks([]);
      return;
    }
    const ticket = ++areaLinkRequest.current;
    setAreaLinksLoading(true);
    api
      .get<{ links: LinkRow[]; truncated: boolean }>(
        `/api/network/versions/${versionId}/links?bbox=${box
          .map((n) => n.toFixed(5))
          .join(',')}&areaId=${areaRoadsFor}&limit=${AREA_LINK_LIMIT}`
      )
      .then((r) => {
        if (ticket === areaLinkRequest.current) setAreaLinks(r.links);
      })
      .catch(() => {
        if (ticket === areaLinkRequest.current) setAreaLinks([]);
      })
      .finally(() => {
        if (ticket === areaLinkRequest.current) setAreaLinksLoading(false);
      });
  }, [versionId, areaRoadsFor, areas, roadScope]);

  // The last camera the map settled on. Kept because roads can be switched on without the map
  // moving, and the only other source of the viewport is the move event itself — without this,
  // ticking the box did nothing at all until you happened to pan.
  const lastView = useRef<{ bbox: [number, number, number, number] } | null>(null);

  const loadLinks = useCallback(
    (bbox: [number, number, number, number]) => {
      if (!versionId || roadScope !== 'inview') {
        setLinks([]);
        setTruncated(false);
        return;
      }
      const ticket = ++linkRequest.current;
      setLinksLoading(true);
      api
        .get<{ links: LinkRow[]; truncated: boolean }>(
          `/api/network/versions/${versionId}/links?bbox=${bbox.map((n) => n.toFixed(5)).join(',')}&limit=${INVIEW_LINK_LIMIT}`
        )
        .then((r) => {
          if (ticket !== linkRequest.current) return;
          setLinks(r.links);
          setTruncated(r.truncated);
        })
        .catch(() => {
          if (ticket === linkRequest.current) setLinks([]);
        })
        .finally(() => {
          if (ticket === linkRequest.current) setLinksLoading(false);
        });
    },
    [versionId, roadScope]
  );

  const handleMoveEnd = useCallback(
    (bbox: [number, number, number, number]) => {
      lastView.current = { bbox };
      loadLinks(bbox);
    },
    [loadLinks]
  );

  // Switching roads on (or changing version) loads them for wherever the camera already is.
  useEffect(() => {
    const view = lastView.current;
    if (!view) return;
    loadLinks(view.bbox);
  }, [loadLinks]);

  // getTooltip is created once; reading the prop directly would pin the first render's value and
  // the tooltip would name whoever held the area when the map first drew.
  const driverNamesRef = useRef(driverNamesByArea);
  driverNamesRef.current = driverNamesByArea;

  const selected = useMemo(() => new Set(selectedIds || []), [selectedIds]);
  // A primitive deck.gl can compare — a Set never differs by identity in a useMemo dep.
  const selectionKey = (selectedIds || []).join(',');

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
    const ASSIGNED_BLUE: [number, number, number, number] = [37, 99, 235, 255];

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
            return [c[0], c[1], c[2], 110];
          },
          // The outline answers "whose is this", independently of the fill's percentage.
          getLineColor: (f: { properties: AreaProps }) => {
            const id = f.properties.areaId || '';
            if (selected.has(id)) return [91, 33, 182, 255];
            // A signed-off area gets an emerald border. Deliberately the OUTLINE and not the fill:
            // completion and percentage are independent facts, and a manager needs to read both
            // at once — "done" and "done at 44%" is a real combination.
            if (f.properties.completed) return [4, 120, 87, 255];
            if (mode === 'assignment') {
              // Both blue: an area is an area. Solid means someone holds it, dashed means it is
              // still waiting — the same language the delivered design used.
              return isAssigned(f.properties) ? ASSIGNED_BLUE : [37, 99, 235, 200];
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
                ? 2.2
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
            getFillColor: [mode, selectionKey, driverColorByArea, roadScope],
            getLineColor: [mode, selectionKey, driverColorByArea],
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
    if (tracks.length) {
      out.push(
        new PathLayer<TrackPath>({
          id: 'driven-tracks',
          data: tracks,
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

    if (links.length) {
      out.push(
        new PathLayer<LinkRow>({
          id: 'road-links',
          data: links,
          pickable: true,
          getPath: (d) => d.coordinates,
          // The same contract as every other road layer on this map: red outstanding, blue
          // driven. It used to be green-on-slate, from when this layer was a browsing aid at high
          // zoom rather than the answer to "show me the roads".
          getColor: (d) => (d.covered ? [37, 99, 235, 235] : [220, 38, 38, 215]),
          // Arterials heavier than local streets, matching how the basemap already reads.
          getWidth: (d) => (d.funcClass && d.funcClass <= 3 ? 5 : d.funcClass === 4 ? 3.5 : 2.2),
          widthUnits: 'meters',
          widthMinPixels: 1.4,
          widthMaxPixels: 8,
          capRounded: true,
          jointRounded: true,
        })
      );
    }

    if (assignedLinks.length) {
      out.push(
        new PathLayer<AssignedLink>({
          id: 'assigned-road-links',
          data: assignedLinks,
          pickable: true,
          getPath: (d) => d.path,
          /**
           * RED still to drive, BLUE driven. This is the contract the driver's phone uses and it
           * is not negotiable by default, because it is the one question the map exists to answer.
           *
           * Colouring driven roads per driver instead was a mistake worth recording: the palette
           * handed one driver the same red as "to drive" and two others orange and magenta, so at
           * hairline width a suburb that was 54% finished read as entirely outstanding. Per-driver
           * colour is now opt-in, for when the question really is "whose work is this" rather
           * than "what is left".
           */
          getColor: (d) => {
            if (!d.covered) return [220, 38, 38, 220];
            const c = (colorRoadsByDriver && d.driverId && driverColorById?.[d.driverId]) || [37, 99, 235];
            return [c[0], c[1], c[2], 235];
          },
          getWidth: (d) => (d.funcClass && d.funcClass <= 3 ? 4.5 : d.funcClass === 4 ? 3.2 : 2.2),
          widthUnits: 'meters',
          widthMinPixels: 1.3,
          widthMaxPixels: 8,
          capRounded: true,
          jointRounded: true,
          updateTriggers: { getColor: [driverColorById, colorRoadsByDriver] },
        })
      );
    }

    if (areaLinks.length) {
      out.push(
        new PathLayer<LinkRow>({
          id: 'area-road-links',
          data: areaLinks,
          pickable: true,
          getPath: (d) => d.coordinates,
          /**
           * The DRIVER'S colours, on purpose: blue where the street is recorded as driven, red
           * where it is still outstanding.
           *
           * The fleet-wide layer above uses green-on-slate because at country zoom "not driven
           * yet" is the normal state of 61,563 km and must not read as an error. Inside a single
           * area being verified the question is the opposite one — what is left — and the manager
           * should be looking at the same picture the driver has on the phone, where red means
           * still to drive. Two colour languages for two genuinely different questions.
           */
          getColor: (d) => (d.covered ? [37, 99, 235, 240] : [220, 38, 38, 225]),
          getWidth: (d) => (d.funcClass && d.funcClass <= 3 ? 5 : d.funcClass === 4 ? 3.5 : 2.4),
          widthUnits: 'meters',
          widthMinPixels: 1.6,
          widthMaxPixels: 9,
          capRounded: true,
          jointRounded: true,
        })
      );
    }

    return out;
  }, [
    areas,
    links,
    areaLinks,
    assignedLinks,
    tracks,
    driverColorById,
    showAreas,
    mode,
    onSelectArea,
    onToggleSelect,
    selected,
    selectionKey,
    driverColorByArea,
  ]);

  const getTooltip = useCallback((info: PickingInfo) => {
    const obj = info.object as (AreaFeature & LinkRow & TrackPath) | undefined;
    if (!obj) return null;

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

    // An assigned-network link carries a decoded path and no metadata — the wire format drops
    // every field the layer does not draw, so it must not fall into the branch below that reads
    // a name and a length.
    if (obj.linkId && Array.isArray((obj as unknown as AssignedLink).path)) {
      const a = obj as unknown as AssignedLink;
      return {
        html: `<div style="font:12px/1.5 system-ui;padding:2px"><b>${
          a.covered ? '✓ driven' : 'not driven yet'
        }</b>${
          a.covered && a.driverName ? `<div>by ${a.driverName}</div>` : ''
        }<div style="opacity:.7">FC${a.funcClass ?? '?'}</div><div style="opacity:.55;font-family:monospace;font-size:11px">${a.linkId}</div></div>`,
      };
    }

    if (obj.linkId) {
      return {
        html: `<div style="font:12px/1.5 system-ui;padding:2px"><b>${obj.name || 'Unnamed road'}</b><div style="opacity:.7">FC${obj.funcClass ?? '?'} · ${Math.round(obj.lengthMeters)} m · ${obj.dirTravel === 'B' ? 'two-way' : 'one-way'}</div><div style="margin-top:3px">${obj.covered ? '✓ driven' : 'not driven yet'}</div><div style="opacity:.55;font-family:monospace;font-size:11px">${obj.linkId}</div></div>`,
      };
    }
    return null;
  }, []);

  const areaRoadsNote =
    areaRoadsFor && areaLinks.length
      ? ` · ${areaLinks.length.toLocaleString()} in the selected area (blue = driven, red = still to drive)`
      : '';

  const drivenCount = assignedLinks.reduce((n, l) => n + (l.covered ? 1 : 0), 0);
  const assignedHint = assignedLoading
    ? 'Loading routes…'
    : assignedLinks.length
      ? `${assignedLinks.length.toLocaleString()} ${roadScope === 'covered' ? 'driven roads, project-wide' : 'roads in assigned areas'}` +
        // Pointless in the 'covered' scope, where the count is 100% by definition.
        (roadScope === 'covered'
          ? ''
          : ` · ${drivenCount.toLocaleString()} driven (${((drivenCount / assignedLinks.length) * 100).toFixed(0)}%)`) +
        ` · ${colorRoadsByDriver ? 'driven roads take the driver’s colour, red = to drive' : 'red = to drive, blue = driven'}`
      : '';

  const inviewDriven = links.reduce((n, l) => n + (l.covered ? 1 : 0), 0);
  const linksHint = !versionId
    ? 'Road links appear once the import is committed'
    : roadScope === 'off'
      ? 'Roads hidden — pick a Routes scope to draw them'
      : assignedHint
        ? assignedHint
        : linksLoading || areaLinksLoading
          ? 'Loading roads…'
          : roadScope === 'inview'
            ? (truncated
                // Say so rather than letting an arbitrary 30,000 of 653,494 read as the whole truth.
                ? `Showing the first ${INVIEW_LINK_LIMIT.toLocaleString()} roads in view — zoom in to see every one`
                : `${links.length.toLocaleString()} roads in view · ${inviewDriven.toLocaleString()} driven`) + areaRoadsNote
            : '';

  return (
    <div className="cov-map" style={{ height }}>
      <Map3D
        ref={mapRef}
        center={[144.96, -37.81]}
        zoom={7}
        pitch={0}
        layers={layers}
        getTooltip={getTooltip}
        onMoveEnd={handleMoveEnd}
      />

      <div className="cov-map-legend">
        {mode === 'assignment' ? (
          <>
            {/* Outline first, because it is the fact people look for: whose is this. */}
            <div className="cov-legend-row">
              <span className="cov-line" style={{ background: 'rgb(37,99,235)' }} />
              <span>assigned</span>
              <span
                className="cov-line"
                style={{ background: 'none', borderTop: '2px dashed rgb(37,99,235)', height: 0 }}
              />
              <span>unassigned</span>
              <span className="cov-line" style={{ background: 'rgb(4,120,87)' }} />
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

      {(loading || error) && (
        <div className="cov-map-overlay">
          {error ? <span style={{ color: 'var(--red)' }}>{error}</span> : 'Loading work areas…'}
        </div>
      )}
    </div>
  );
}
