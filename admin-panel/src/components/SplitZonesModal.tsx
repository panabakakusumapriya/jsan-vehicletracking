import { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { api } from '../lib/api';
import type { AreaSplitResult } from '../lib/types';

/** What the dialog needs to know about the area being split. */
export interface SplitArea {
  _id: string;
  areaCode: string;
  name: string;
  targetMeters: number;
  targetLinks: number;
}

/** The server will not make a zone smaller than this (backend workAreaSplit.optionsFrom). */
const MIN_ZONE_KM = 5;
/** What one driver is normally given, when the area is big enough for the question to arise. */
const USUAL = { min: 250, max: 300 };

/**
 * How many zones a length of road makes at a given size, and how big they come out — the same
 * rule as backend/src/services/areaSplit.js#zonePlan, so the dialog can answer as the numbers are
 * typed. The server's preview is still what counts.
 */
export function zonePlan(totalKm: number, minKm: number, maxKm: number, absorb: boolean) {
  const middle = (minKm + maxKm) / 2;
  const fewest = Math.max(1, Math.ceil(totalKm / maxKm - 1e-9));
  const most = Math.floor(totalKm / minKm + 1e-9);
  if (most >= fewest) {
    let best = fewest;
    for (let k = fewest; k <= most; k++) {
      if (Math.abs(totalKm / k - middle) < Math.abs(totalKm / best - middle)) best = k;
    }
    return { count: best, each: totalKm / best, leftover: null as number | null };
  }
  if (absorb || most < 1) {
    const count = Math.max(1, most);
    return { count, each: totalKm / count, leftover: null };
  }
  return { count: most + 1, each: middle, leftover: totalKm - most * middle };
}

/** A size range that cuts `totalKm` into exactly `count` zones: 10% either side of an equal share. */
function sizeFor(totalKm: number, count: number) {
  const each = totalKm / count;
  return { min: Math.max(MIN_ZONE_KM, Math.floor(each * 0.9)), max: Math.max(MIN_ZONE_KM, Math.ceil(each * 1.1)) };
}

interface Pick {
  label: string;
  min: number;
  max: number;
}

/**
 * One-click sizes that WORK for this area.
 *
 * A big area gets the sizes a dispatcher thinks in ("250–300 km"); an area too small for those
 * gets counts instead ("2 zones · about 54 km each"), because 250–300 km means nothing to an
 * island with 108 km of road — and a dialog that opens on a size the area cannot be cut to, then
 * only says no, reads as broken.
 */
function picksFor(totalKm: number): Pick[] {
  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (totalKm >= 2 * USUAL.min) {
    return [[200, 250], [250, 300], [300, 350]]
      .filter(([min]) => totalKm >= 2 * min)
      .map(([min, max]) => ({
        label: `${min}–${max} km · about ${zonePlan(totalKm, min, max, true).count} zones`,
        min,
        max,
      }));
  }
  return [2, 3, 4]
    .filter((count) => totalKm / count >= MIN_ZONE_KM)
    .map((count) => ({ label: `${count} zones · about ${fmt(totalKm / count)} km each`, ...sizeFor(totalKm, count) }));
}

/**
 * Cut one area into zones a driver can finish.
 *
 * One area goes to one driver, and a customer's file can hand over an area nobody could cover —
 * Auckland arrived as a single 4,408 km polygon. The manager says how much road a zone should
 * hold; the server cuts the area into that many compact, connected pieces, named after the
 * suburbs inside them, and the pieces replace the area on the map.
 *
 * Two steps on purpose: Preview shows the zones that would be made (and writes nothing), and only
 * then does the Split button appear. Changing a number throws the preview away.
 */
export function SplitZonesModal({
  scopeId,
  area,
  onClose,
  onDone,
}: {
  scopeId: string;
  area: SplitArea;
  onClose: () => void;
  onDone: (result: AreaSplitResult) => void;
}) {
  const totalKm = area.targetMeters / 1000;
  const picks = useMemo(() => picksFor(totalKm), [totalKm]);
  // Open on a size this area can actually be cut to: the usual one when it is big enough for
  // that, otherwise two equal zones.
  const opening = picks.find((p) => p.min === USUAL.min && p.max === USUAL.max) ?? picks[0] ?? USUAL;

  const [minKm, setMinKm] = useState(String(opening.min));
  const [maxKm, setMaxKm] = useState(String(opening.max));
  const [absorb, setAbsorb] = useState(true);
  const [preview, setPreview] = useState<AreaSplitResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'split' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lo = Number(minKm);
  const hi = Number(maxKm);
  const typed = minKm.trim() !== '' && maxKm.trim() !== '' && Number.isFinite(lo) && Number.isFinite(hi);
  const valid = typed && lo >= MIN_ZONE_KM && hi >= lo;
  const plan = valid ? zonePlan(totalKm, lo, hi, absorb) : null;
  const canSplit = picks.length > 0;

  const change = (fn: () => void) => {
    fn();
    setPreview(null);
    setError(null);
  };
  const choose = (pick: Pick) => change(() => {
    setMinKm(String(pick.min));
    setMaxKm(String(pick.max));
  });

  const run = async (apply: boolean) => {
    if (!valid) return;
    setBusy(apply ? 'split' : 'preview');
    setError(null);
    try {
      const result = await api.post<AreaSplitResult>(
        `/api/network/versions/${scopeId}/areas/${area._id}/split`,
        { minKm: lo, maxKm: hi, absorbRemainder: absorb, apply }
      );
      if (apply) onDone(result);
      else setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The area could not be split');
    } finally {
      setBusy(null);
    }
  };

  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const km1 = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const size = lo === hi ? `${fmt(lo)} km` : `${fmt(lo)}–${fmt(hi)} km`;

  return (
    <Modal title={`Split into zones · ${area.name}`} onClose={busy ? () => {} : onClose}>
      <p className="cov-sub" style={{ marginTop: 0 }}>
        {area.name} has <b>{km1(totalKm)} km</b> of road across {area.targetLinks.toLocaleString()} roads.
        Choose how much road each zone should hold: the area is cut into zones of that size, each
        one piece of ground, named after the suburbs inside it.
      </p>

      {!canSplit ? (
        <div className="cov-issue warn">
          {km1(totalKm)} km is too little road to split — a zone cannot be smaller than {MIN_ZONE_KM} km.
        </div>
      ) : (
        <>
          <div className="split-picks">
            <span className="split-picks-label">Quick choice</span>
            <div className="cov-presets">
              {picks.map((pick) => (
                <button
                  key={pick.label}
                  type="button"
                  disabled={busy !== null}
                  className={valid && lo === pick.min && hi === pick.max ? 'on' : ''}
                  onClick={() => choose(pick)}
                >
                  {pick.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="split-min">Each zone from (km)</label>
              <input
                id="split-min"
                className="input"
                type="number"
                min={MIN_ZONE_KM}
                step={5}
                value={minKm}
                disabled={busy !== null}
                onChange={(e) => change(() => setMinKm(e.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="split-max">To (km)</label>
              <input
                id="split-max"
                className="input"
                type="number"
                min={MIN_ZONE_KM}
                step={5}
                value={maxKm}
                disabled={busy !== null}
                onChange={(e) => change(() => setMaxKm(e.target.value))}
              />
            </div>
          </div>

          <label className="cov-toggle" style={{ marginTop: 2 }}>
            <input
              type="checkbox"
              checked={absorb}
              disabled={busy !== null}
              onChange={(e) => change(() => setAbsorb(e.target.checked))}
            />
            <span>
              If a small part is left over, <b>add it to the neighbouring zones</b> — they may then
              run a little over the maximum. Untick to keep the leftover as a smaller zone of its own.
            </span>
          </label>

          {/* One line under the inputs that always says what the numbers above will do. */}
          {!preview && !typed && (
            <div className="cov-issue warn" style={{ marginTop: 14 }}>
              Enter two numbers, or use a quick choice above. For one exact size, put the same
              number in both boxes.
            </div>
          )}
          {!preview && typed && !valid && (
            <div className="cov-issue warn" style={{ marginTop: 14 }}>
              {hi < lo
                ? 'The first number has to be the smaller one — for example 250 to 300.'
                : `A zone cannot be smaller than ${MIN_ZONE_KM} km.`}
            </div>
          )}
          {!preview && plan && plan.count < 2 && (
            <div className="cov-issue warn" style={{ marginTop: 14 }}>
              Zones of {size} are bigger than this area can be cut into: it has {km1(totalKm)} km of
              road, so each of two zones would hold about {fmt(totalKm / 2)} km.
              {absorb && totalKm > hi
                ? ' Untick the box above to get one zone of that size and a smaller leftover, or use'
                : ' Use'}{' '}
              a quick choice above, or type a size of {fmt(Math.floor(totalKm / 2))} km or less.
            </div>
          )}
          {!preview && plan && plan.count >= 2 && (
            <div className="cov-issue ok" style={{ marginTop: 14 }}>
              {plan.leftover !== null
                ? `That makes ${plan.count} zones: ${plan.count - 1} of about ${fmt(plan.each)} km and a leftover of about ${fmt(plan.leftover)} km.`
                : `That makes ${plan.count} zones of about ${fmt(plan.each)} km each${plan.each > hi + 0.5 ? ' — the leftover shared out among them' : ''}.`}
            </div>
          )}
        </>
      )}

      {preview && (
        <>
          <p className="cov-sub" style={{ margin: '14px 0 8px' }}>
            <b>{preview.zones.length} zones</b>, {fmt(Math.min(...preview.zones.map((z) => z.km)))}–
            {fmt(Math.max(...preview.zones.map((z) => z.km)))} km.
            {preview.namesFrom?.startsWith('none') &&
              ' The place names could not be fetched just now, so the zones are numbered only.'}
            {/* Water, or a gap in the customer's network, can leave a part of the area that
                does not divide any closer — the North Shore is three zones of 277 km whatever
                size is asked for. Say so rather than let the range look ignored. */}
            {(() => {
              const off = preview.zones.filter((z) => z.km < lo - 1 || z.km > Math.max(hi, plan?.each ?? hi) * 1.06);
              return off.length
                ? ` ${off.length} of them fall outside the size asked for: a piece of the area that stands apart (an island, an outlying town, a shore cut off by water) is zoned by itself and does not divide any closer.`
                : '';
            })()}
          </p>
          <div className="split-zones">
            {preview.zones.map((z) => (
              <div key={z.code} className="split-zone">
                <span className="name">{z.name}</span>
                <span className="km">{fmt(z.km)} km</span>
                <span className="roads">{z.links.toLocaleString()} roads</span>
              </div>
            ))}
          </div>
          {preview.unplacedLinks > 0 && (
            <p className="cov-sub" style={{ margin: '10px 0 0' }}>
              {preview.unplacedLinks.toLocaleString()} road{preview.unplacedLinks === 1 ? '' : 's'} (
              {km1(preview.unplacedKm ?? 0)} km) on small detached pieces — an islet with a single
              road — are too little for a zone and are left out.
            </p>
          )}
          <p className="cov-sub" style={{ margin: '10px 0 0' }}>
            Splitting replaces {area.name} with these zones; land with no road on it is in no zone.
            Roads already driven stay driven. To change the size later, pick any zone and use
            “Join zones back”.
          </p>
        </>
      )}

      {busy && (
        <p className="cov-sub" style={{ margin: '14px 0 0' }}>
          <span className="cov-spinner" />{' '}
          {busy === 'preview' ? 'Working out the zones… this can take half a minute.' : 'Splitting… do not close this window.'}
        </p>
      )}
      {error && <div className="cov-issue error" style={{ marginTop: 12 }}>{error}</div>}

      <div className="modal-actions">
        <button className="btn-ghost" disabled={busy !== null} onClick={onClose}>Cancel</button>
        {preview ? (
          <>
            <button className="btn-ghost" disabled={busy !== null} onClick={() => change(() => {})}>
              Change size
            </button>
            <button className="btn" disabled={busy !== null} onClick={() => run(true)}>
              {busy === 'split' ? 'Splitting…' : `Split into ${preview.zones.length} zones`}
            </button>
          </>
        ) : (
          <button
            className="btn"
            disabled={busy !== null || !canSplit || !valid || (plan?.count ?? 0) < 2}
            onClick={() => run(false)}
          >
            {busy === 'preview' ? 'Working…' : 'Preview zones'}
          </button>
        )}
      </div>
    </Modal>
  );
}
