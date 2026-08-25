import type { Layer, PickingInfo } from '@deck.gl/core';
import { GeoJsonLayer, PathLayer } from '@deck.gl/layers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
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

const LINK_ZOOM = 11.5;
const LINK_LIMIT = 6000;

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
  1: [124, 58, 237],
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
}: {
  /** A committed version — shows coverage and lets road links load. */
  versionId?: string;
  /** An uncommitted import — shows work areas read straight off the shapefile. */
  importJobId?: string;
  mode: 'coverage' | 'priority' | 'driver';
  height?: number;
  onSelectArea?: (areaId: string) => void;
  /** Areas currently selected for assignment. Drawn with a heavy outline. */
  selectedIds?: string[];
  /** Click on a polygon. `additive` is true when shift/ctrl was held. */
  onToggleSelect?: (areaId: string, additive: boolean) => void;
  /** areaId -> colour of the driver holding it, for the 'driver' mode. */
  driverColorByArea?: Record<string, [number, number, number]>;
  /** Frame this one area when it changes. The six clusters sit far apart, so arriving from the
   *  areas table has to land on the area you clicked rather than on the whole state. */
  focusAreaId?: string | null;
}) {
  const mapRef = useRef<Map3DHandle>(null);
  const [areas, setAreas] = useState<AreaCollection | null>(null);
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [zoom, setZoom] = useState(0);
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

  const handleMoveEnd = useCallback(
    (bbox: [number, number, number, number], z: number) => {
      setZoom(z);
      if (!versionId || z < LINK_ZOOM) {
        setLinks([]);
        setTruncated(false);
        return;
      }
      const ticket = ++linkRequest.current;
      setLinksLoading(true);
      api
        .get<{ links: LinkRow[]; truncated: boolean }>(
          `/api/network/versions/${versionId}/links?bbox=${bbox.map((n) => n.toFixed(5)).join(',')}&limit=${LINK_LIMIT}`
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
    [versionId]
  );

  const selected = useMemo(() => new Set(selectedIds || []), [selectedIds]);
  // A primitive deck.gl can compare — a Set never differs by identity in a useMemo dep.
  const selectionKey = (selectedIds || []).join(',');

  const layers = useMemo<Layer[]>(() => {
    const shadeOf = (p: AreaProps): [number, number, number] => {
      if (mode === 'driver') {
        return driverColorByArea?.[p.areaId || ''] || [203, 213, 225]; // unassigned = pale slate
      }
      return mode === 'coverage' ? coverageColor(p.pct || 0) : priorityColor(p.priority);
    };

    const out: Layer[] = [];

    if (areas?.features.length) {
      out.push(
        new GeoJsonLayer<AreaProps>({
          id: 'work-areas',
          data: areas as unknown as never,
          pickable: true,
          stroked: true,
          filled: true,
          getFillColor: (f: { properties: AreaProps }) => {
            const id = f.properties.areaId || '';
            if (selected.has(id)) return [124, 58, 237, 190]; // selected reads first, before hue
            const c = shadeOf(f.properties);
            // Translucent so the basemap's streets stay readable underneath — the fill is a
            // summary, not a mask.
            return [c[0], c[1], c[2], 110];
          },
          getLineColor: (f: { properties: AreaProps }) => {
            const id = f.properties.areaId || '';
            if (selected.has(id)) return [91, 33, 182, 255];
            const c = shadeOf(f.properties);
            return [c[0], c[1], c[2], 235];
          },
          // Selected polygons get a heavy border so a chosen cluster is legible even where the
          // areas are tiny and packed, which is most of inner Melbourne.
          getLineWidth: (f: { properties: AreaProps }) =>
            selected.has(f.properties.areaId || '') ? 3 : 1,
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1.2,
          updateTriggers: {
            // deck.gl caches accessor results; without naming every input here a selection would
            // change state but not repaint.
            getFillColor: [mode, selectionKey, driverColorByArea],
            getLineColor: [mode, selectionKey, driverColorByArea],
            getLineWidth: [selectionKey],
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

    if (links.length) {
      out.push(
        new PathLayer<LinkRow>({
          id: 'road-links',
          data: links,
          pickable: true,
          getPath: (d) => d.coordinates,
          // Green once driven, neutral slate until then. Uncovered is the normal state at the
          // start of a project, so it must not look like an error.
          getColor: (d) => (d.covered ? [5, 150, 105, 235] : [100, 116, 139, 190]),
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

    return out;
  }, [areas, links, mode, onSelectArea, onToggleSelect, selected, selectionKey, driverColorByArea]);

  const getTooltip = useCallback((info: PickingInfo) => {
    const obj = info.object as (AreaFeature & LinkRow) | undefined;
    if (!obj) return null;

    if ('properties' in obj && obj.properties) {
      const p = obj.properties;
      const rows: string[] = [];
      if (p.parentName) rows.push(`<div style="opacity:.7">${p.parentName}</div>`);
      rows.push(`<div style="opacity:.7">P${p.priority} · ${p.areaCode}</div>`);
      if (typeof p.targetMeters === 'number') {
        rows.push(
          `<div style="margin-top:4px">${km(p.coveredMeters || 0)} / ${km(p.targetMeters)} km · <b>${(p.pct || 0).toFixed(1)}%</b></div>`
        );
        rows.push(`<div style="opacity:.7">${(p.targetLinks || 0).toLocaleString()} links</div>`);
      }
      return {
        html: `<div style="font:12px/1.5 system-ui;padding:2px"><b>${p.name || p.areaCode}</b>${rows.join('')}</div>`,
      };
    }

    if (obj.linkId) {
      return {
        html: `<div style="font:12px/1.5 system-ui;padding:2px"><b>${obj.name || 'Unnamed road'}</b><div style="opacity:.7">FC${obj.funcClass ?? '?'} · ${Math.round(obj.lengthMeters)} m · ${obj.dirTravel === 'B' ? 'two-way' : 'one-way'}</div><div style="margin-top:3px">${obj.covered ? '✓ driven' : 'not driven yet'}</div><div style="opacity:.55;font-family:monospace;font-size:11px">${obj.linkId}</div></div>`,
      };
    }
    return null;
  }, []);

  const linksHint = !versionId
    ? 'Road links appear once the import is committed'
    : zoom < LINK_ZOOM
      ? 'Zoom in to load road links'
      : linksLoading
        ? 'Loading road links…'
        : truncated
          ? `Showing the first ${LINK_LIMIT.toLocaleString()} links — zoom in further to see them all`
          : `${links.length.toLocaleString()} links in view`;

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
        {mode === 'driver' ? (
          <div className="cov-legend-row">
            <span>Colour = assigned driver</span>
            <span className="cov-swatch" style={{ background: 'rgb(203,213,225)' }} />
            <span>unassigned</span>
          </div>
        ) : mode === 'coverage' ? (
          <>
            <div className="cov-legend-row">
              <span className="cov-swatch" style={{ background: 'rgb(148,163,184)' }} />
              <span className="cov-swatch" style={{ background: 'rgb(76,156,144)' }} />
              <span className="cov-swatch" style={{ background: 'rgb(5,150,105)' }} />
              <span>0% → 100% covered</span>
            </div>
            <div className="cov-legend-row">
              <span className="cov-line" style={{ background: 'rgb(5,150,105)' }} />
              <span>driven</span>
              <span className="cov-line" style={{ background: 'rgb(100,116,139)' }} />
              <span>not yet</span>
            </div>
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
