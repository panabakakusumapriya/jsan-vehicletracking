import { API_URL, api, tokenStore } from './api';

/**
 * Every road of a delivery, at full detail, ready for the GPU — the client half of
 * backend/src/services/roadBlobs.js (the file format is described there).
 *
 * One file per delivery, downloaded once: its URL carries a key that changes only when the
 * delivery does, so the browser keeps it, and so does this module for as long as the page is open.
 * Positions come out as Float32 offsets from the delivery's own centre, to be drawn with
 * COORDINATE_SYSTEM.LNGLAT_OFFSETS: float32 near an origin is precise to a few centimetres, where
 * float32 absolute longitudes would be off by metres.
 */

export interface RoadNet {
  versionId: string;
  key: string;
  linkCount: number;
  vertexCount: number;
  /** [lon, lat] every position is an offset from. */
  origin: [number, number];
  /** lon/lat offsets in degrees, two per vertex. */
  positions: Float32Array;
  /** Vertex index each link starts at; one extra entry at the end. */
  startIndices: Uint32Array;
  fc: Uint8Array;
  /** Index into `areas`, 65535 = in no area. */
  area: Uint16Array;
  areas: { id: string; code: string; name: string }[];
  /** Link ids in file order — numbers for HERE data, text otherwise. */
  ids: Float64Array | string[];
}

export const NO_AREA = 65535;

export interface RoadBlobInfo {
  versionId: string;
  key: string;
  links: number;
}

/** The driven state of one delivery's roads, from GET …/road-state. */
export interface RoadState {
  /** Per delivery: driver index per link, -1 where the road is not driven. */
  coveredBy: Map<string, Int16Array>;
  drivers: { driverId: string; name: string }[];
  heldCodes: Set<string>;
  signedOffCodes: Set<string>;
}

const decoded = new Map<string, RoadNet>(); // `${versionId}-${key}`

function decode(buf: ArrayBuffer): RoadNet {
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'RDB1') throw new Error('Not a road file');
  const headerLen = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen)).replace(/\0+$/, '').trim());
  const data = 8 + headerLen;
  const sec = <T>(name: string, Type: { new (b: ArrayBuffer, o: number, l: number): T; BYTES_PER_ELEMENT: number }) => {
    const [off, len] = header.sections[name] as [number, number];
    return new Type(buf, data + off, len / Type.BYTES_PER_ELEMENT);
  };
  const starts = sec('starts', Uint32Array);
  const coords = sec('coords', Int32Array);
  const scale = header.scale as number;
  const bbox = header.bbox as [number, number, number, number] | null;
  const origin: [number, number] = bbox ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] : [0, 0];
  // Undo the deltas in integers (exact), then make each vertex an offset from the origin.
  const ox = Math.round(origin[0] * scale);
  const oy = Math.round(origin[1] * scale);
  const positions = new Float32Array(header.vertexCount * 2);
  let lon = 0;
  let lat = 0;
  for (let i = 0; i < positions.length; i += 2) {
    lon += coords[i];
    lat += coords[i + 1];
    positions[i] = (lon - ox) / scale;
    positions[i + 1] = (lat - oy) / scale;
  }
  return {
    versionId: header.versionId,
    key: header.key,
    linkCount: header.linkCount,
    vertexCount: header.vertexCount,
    origin: [ox / scale, oy / scale],
    positions,
    startIndices: new Uint32Array(starts), // a copy, so the file's buffer can be let go
    fc: new Uint8Array(sec('fc', Uint8Array)),
    area: new Uint16Array(sec('area', Uint16Array)),
    areas: header.areas,
    ids: header.ids || new Float64Array(sec('ids', Float64Array)),
  };
}

/** Download (or recall) one delivery's roads. `onBytes` reports progress as bytes arrive. */
export async function loadRoadNet(info: RoadBlobInfo, onBytes?: (n: number) => void): Promise<RoadNet> {
  const name = `${info.versionId}-${info.key}`;
  const hit = decoded.get(name);
  if (hit) return hit;
  const token = tokenStore.get();
  const res = await fetch(`${API_URL}/api/network/road-blob/${info.versionId}/${info.key}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 410) throw Object.assign(new Error('The road file changed'), { stale: true });
  if (!res.ok) throw new Error(`Roads could not be loaded (${res.status})`);
  let buf: ArrayBuffer;
  if (res.body && onBytes) {
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
      onBytes(total);
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.length; }
    buf = all.buffer;
  } else {
    buf = await res.arrayBuffer();
  }
  const net = decode(buf);
  // Older copies of this delivery are not needed once a newer one is in.
  for (const k of [...decoded.keys()]) if (k.startsWith(`${info.versionId}-`)) decoded.delete(k);
  decoded.set(name, net);
  return net;
}

export async function listRoadBlobs(scopeId: string): Promise<RoadBlobInfo[]> {
  const r = await api.get<{ blobs: RoadBlobInfo[] }>(`/api/network/versions/${scopeId}/road-blobs`);
  return r.blobs || [];
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function loadRoadState(scopeId: string, nets: RoadNet[]): Promise<RoadState> {
  const r = await api.get<{
    versions: { versionId: string; key: string; covered: string; coveredBy: string }[];
    drivers: { driverId: string; name: string }[];
    heldCodes: string[];
    signedOffCodes: string[];
  }>(`/api/network/versions/${scopeId}/road-state`);
  const coveredBy = new Map<string, Int16Array>();
  for (const v of r.versions) {
    const net = nets.find((n) => n.versionId === v.versionId);
    // A state for a different file than the one on screen would colour the wrong roads.
    if (!net || net.key !== v.key) continue;
    const idx = new Uint32Array(fromBase64(v.covered).buffer);
    const who = fromBase64(v.coveredBy);
    const per = new Int16Array(net.linkCount).fill(-1);
    for (let i = 0; i < idx.length; i++) {
      if (idx[i] < per.length) per[idx[i]] = who[i] === 255 ? 254 : who[i];
    }
    coveredBy.set(v.versionId, per);
  }
  return {
    coveredBy,
    drivers: r.drivers || [],
    heldCodes: new Set(r.heldCodes || []),
    signedOffCodes: new Set(r.signedOffCodes || []),
  };
}

/** A link's id as text, for tooltips. */
export const linkIdAt = (net: RoadNet, i: number) =>
  Array.isArray(net.ids) ? net.ids[i] : String((net.ids as Float64Array)[i]);
