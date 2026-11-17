import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { api } from '../lib/api';
import type { AreaCutResult, AreaSplitResult, DeliveryOverlap, RemainingOverlap } from '../lib/types';

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
  onCut,
  mode = 'split',
}: {
  scopeId: string;
  area: SplitArea;
  onClose: () => void;
  onDone: (result: AreaSplitResult) => void;
  /** The area was cut around other deliveries and kept whole (no zones made). */
  onCut?: (result: AreaCutResult) => void;
  /**
   * `split`: cut into zones (and optionally around other deliveries).
   * `cut`: only cut around other deliveries, keeping the area whole — for a zone, a client's site,
   * a small strip: anything that must not be split but was drawn over another delivery.
   */
  mode?: 'split' | 'cut';
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
  const [busy, setBusy] = useState<'preview' | 'split' | 'cut-preview' | 'cut' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [overlaps, setOverlaps] = useState<DeliveryOverlap[]>([]);
  /** Whether the overlap check has answered — "nothing overlaps" is only said once it has. */
  const [overlapState, setOverlapState] = useState<'loading' | 'done' | 'failed'>('loading');
  /** Deliveries to cut around — the ground they already cover is taken out of the zones. */
  const [cut, setCut] = useState<string[]>([]);
  /** "Cut around only": what cutting this one area (no split) would do. */
  const [cutPreview, setCutPreview] = useState<AreaCutResult | null>(null);

  // Whose ground this area sits on — MEASURED shared ground (km2), so outlines that only touch are
  // not listed. Vietnam's countrywide FC1-2 area covered all seven FC4-5 TPA sites and both FC3
  // city polygons. Asked up front so the choice is there before any preview.
  useEffect(() => {
    let live = true;
    setOverlapState('loading');
    api
      .get<{ deliveries: DeliveryOverlap[] }>(`/api/network/versions/${scopeId}/areas/${area._id}/overlaps`)
      .then((r) => {
        if (!live) return;
        setOverlaps(r.deliveries || []);
        setOverlapState('done');
      })
      .catch(() => { if (live) setOverlapState('failed'); });
    return () => { live = false; };
  }, [scopeId, area._id]);

  const lo = Number(minKm);
  const hi = Number(maxKm);
  const typed = minKm.trim() !== '' && maxKm.trim() !== '' && Number.isFinite(lo) && Number.isFinite(hi);
  const valid = typed && lo >= MIN_ZONE_KM && hi >= lo;
  const plan = valid ? zonePlan(totalKm, lo, hi, absorb) : null;
  const canSplit = picks.length > 0;

  const change = (fn: () => void) => {
    fn();
    setPreview(null);
    setCutPreview(null);
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
        { minKm: lo, maxKm: hi, absorbRemainder: absorb, apply, cutAround: cut }
      );
      if (apply) onDone(result);
      else setPreview(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The area could not be split');
    } finally {
      setBusy(null);
    }
  };

  /** Cut around the ticked deliveries, keeping this area whole: preview, then apply. */
  const runCut = async (apply: boolean) => {
    if (!cut.length) return;
    setBusy(apply ? 'cut' : 'cut-preview');
    setError(null);
    try {
      const result = await api.post<AreaCutResult>(
        `/api/network/versions/${scopeId}/areas/${area._id}/cut-around`,
        { cutAround: cut, apply }
      );
      if (apply) onCut?.(result);
      else {
        setPreview(null);
        setCutPreview(result);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The area could not be cut around');
    } finally {
      setBusy(null);
    }
  };

  const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const km1 = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  /** Area, readable at every size: 2.06 km², 0.75 km², 4,500 m². */
  const area2 = (sqKm: number) => (sqKm >= 0.1
    ? `${sqKm.toLocaleString(undefined, { maximumFractionDigits: 2 })} km²`
    : `${Math.round(sqKm * 1e6).toLocaleString()} m²`);
  const size = lo === hi ? `${fmt(lo)} km` : `${fmt(lo)}–${fmt(hi)} km`;
  /** How much of this area's road lies inside a delivery, once the preview has worked it out. */
  const overlapKm = (versionId: string) => preview?.overlaps?.find((o) => o.versionId === versionId)?.km;
  const labelOf = (versionId: string) => overlaps.find((o) => o.versionId === versionId)?.label || 'another delivery';
  /** Overlaps the manager has NOT ticked: the zones will be drawn over these, on purpose or not. */
  const untickedOverlaps = overlaps.filter((o) => !cut.includes(o.versionId));

  /** What is left overlapping after a cut, in red: it must never pass in silence. */
  const remainingBox = (remaining: RemainingOverlap[] | undefined, what: string) => {
    if (remaining && remaining.length) {
      return (
        <div className="cov-issue error" style={{ marginTop: 10 }}>
          <b>
            {remaining.length} {remaining.length === 1 ? what : `${what}s`} would still overlap after the cut:
          </b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {remaining.map((r) => (
              <li key={r.code}>
                {r.name} — {area2(r.sqKm)} on {r.with.join(', ')}
              </li>
            ))}
          </ul>
          It lies (almost) wholly inside that ground, so cutting would leave nothing of it. Decide which
          delivery that ground belongs to before going on.
        </div>
      );
    }
    if (cut.length) {
      return (
        <div className="cov-issue ok" style={{ marginTop: 10 }}>
          ✓ Checked: nothing overlaps {cut.map(labelOf).join(' or ')} after the cut.
        </div>
      );
    }
    return null;
  };

  /**
   * Whose ground this area sits on, measured. Shown before anything else — this is the decision the
   * size is cut around. "Nothing overlaps" is said out loud, so its absence is never ambiguous.
   */
  const overlapBox = (
    <>
      {overlapState === 'loading' && (
        <p className="cov-sub" style={{ margin: '0 0 12px' }}>
          <span className="cov-spinner" /> Checking whether this area overlaps any other delivery…
        </p>
      )}
      {overlapState === 'failed' && (
        <div className="cov-issue warn" style={{ margin: '0 0 12px' }}>
          Could not check for overlaps with other deliveries just now.{' '}
          {mode === 'split' ? 'The split itself still works.' : 'Try again in a moment.'}
        </div>
      )}
      {overlapState === 'done' && overlaps.length === 0 && (
        <div className="cov-issue ok" style={{ margin: '0 0 12px' }}>
          ✓ No other delivery&apos;s areas overlap this one{mode === 'cut' ? ' — there is nothing to cut around.' : '.'}
        </div>
      )}
      {overlaps.length > 0 && (
        <div className="cov-issue warn" style={{ margin: '0 0 12px' }}>
          <b>
            ⚠ This area overlaps {overlaps.length === 1 ? 'another delivery' : `${overlaps.length} other deliveries`}
          </b>{' '}
          — the shared ground is measured below (outlines that only touch are not counted). Tick a
          delivery to cut around its areas instead of drawing over them. This area&apos;s own roads
          inside such a hole stay with it: they are its road class, not the other delivery&apos;s.
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            {overlaps.map((o) => (
              <label key={o.versionId} className="cov-toggle" style={{ margin: 0, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={cut.includes(o.versionId)}
                  disabled={busy !== null}
                  onChange={(e) => change(() => setCut((c) => (e.target.checked
                    ? [...c, o.versionId]
                    : c.filter((x) => x !== o.versionId))))}
                />
                <span>
                  <b>Cut around {o.label}</b> — {o.sqKm !== undefined ? `${area2(o.sqKm)} shared with ` : ''}
                  {o.areas} area{o.areas === 1 ? '' : 's'}
                  {overlapKm(o.versionId) !== undefined
                    ? ` · ${km1(overlapKm(o.versionId) as number)} km of this area's road inside`
                    : ''}
                  {o.list && o.list.length > 0 ? (
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      {o.list
                        .map((a) => `${a.name}: ${area2(a.sqKm)}${a.share !== null && a.share !== undefined ? ` (${Math.round(a.share * 100)}% of it)` : ''}`)
                        .join(' · ')}
                      {o.areas > o.list.length ? ` · and ${o.areas - o.list.length} more` : ''}
                    </span>
                  ) : o.names.length ? (
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{o.names.join(', ')}</span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  );

  const cutPreviewBox = cutPreview && (
    <>
      <p className="cov-sub" style={{ margin: '14px 0 0' }}>
        Cutting around {cut.map(labelOf).join(' and ')} takes <b>{area2(cutPreview.cutSqKm)}</b> out of{' '}
        {area.name} ({area2(cutPreview.beforeSqKm)} → {area2(cutPreview.afterSqKm)}). It stays one area:
        same code, same driver, all {cutPreview.area.links.toLocaleString()} of its roads.
        {cutPreview.excluded
          .filter((e) => e.links > 0)
          .map((e) => ` ${km1(e.km)} km of its road inside ${e.label} stays with it.`)
          .join('')}
      </p>
      {remainingBox(cutPreview.remaining, 'area')}
    </>
  );

  if (mode === 'cut') {
    return (
      <Modal title={`Cut around other deliveries · ${area.name}`} onClose={busy ? () => {} : onClose}>
        <p className="cov-sub" style={{ marginTop: 0 }}>
          Takes other deliveries&apos; ground out of {area.name} without splitting it: their areas become
          holes in this one. Nothing else changes.
        </p>
        {overlapBox}
        {cutPreviewBox}
        {busy && (
          <p className="cov-sub" style={{ margin: '14px 0 0' }}>
            <span className="cov-spinner" /> {busy === 'cut' ? 'Cutting… do not close this window.' : 'Working out the cut…'}
          </p>
        )}
        {error && <div className="cov-issue error" style={{ marginTop: 12 }}>{error}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" disabled={busy !== null} onClick={onClose}>Cancel</button>
          {cutPreview ? (
            <button
              className="btn"
              disabled={busy !== null || cutPreview.remaining.length > 0}
              onClick={() => runCut(true)}
            >
              {busy === 'cut' ? 'Cutting…' : 'Cut around'}
            </button>
          ) : (
            <button className="btn" disabled={busy !== null || cut.length === 0} onClick={() => runCut(false)}>
              {busy === 'cut-preview' ? 'Working…' : cut.length ? 'Preview cut' : 'Tick a delivery above'}
            </button>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Split into zones · ${area.name}`} onClose={busy ? () => {} : onClose}>
      <p className="cov-sub" style={{ marginTop: 0 }}>
        {area.name} has <b>{km1(totalKm)} km</b> of road across {area.targetLinks.toLocaleString()} roads.
        Choose how much road each zone should hold: the area is cut into zones of that size, each
        one piece of ground, named after the suburbs inside it.
      </p>

      {overlapBox}

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
          {preview.zonesCutAround ? (
            <p className="cov-sub" style={{ margin: '10px 0 0' }}>
              {preview.zonesCutAround} of the zones are cut around ground another delivery already
              covers.
              {(preview.excluded || [])
                .filter((e) => e.links > 0)
                .map((e) => ` ${km1(e.km)} km of road inside ${e.label} stays with the zone around it.`)
                .join('')}
            </p>
          ) : null}
          {remainingBox(preview.remaining, 'zone')}
          {untickedOverlaps.length > 0 && (
            <div className="cov-issue warn" style={{ marginTop: 10 }}>
              These zones will be drawn over{' '}
              {untickedOverlaps.map((o) => `${o.label}${o.sqKm !== undefined ? ` (${area2(o.sqKm)})` : ''}`).join(' and ')}.
              Tick “Cut around” above if they should be kept apart.
            </div>
          )}
          <p className="cov-sub" style={{ margin: '10px 0 0' }}>
            Splitting replaces {area.name} with these zones; land with no road on it is in no zone.
            Roads already driven stay driven. To change the size later, pick any zone and use
            “Join zones back”.
          </p>
        </>
      )}

      {cutPreviewBox}

      {busy && (
        <p className="cov-sub" style={{ margin: '14px 0 0' }}>
          <span className="cov-spinner" />{' '}
          {busy === 'preview'
            ? 'Working out the zones… this can take half a minute.'
            : busy === 'cut-preview'
              ? 'Working out the cut…'
              : busy === 'cut'
                ? 'Cutting… do not close this window.'
                : 'Splitting… do not close this window.'}
        </p>
      )}
      {error && <div className="cov-issue error" style={{ marginTop: 12 }}>{error}</div>}

      <div className="modal-actions">
        <button className="btn-ghost" disabled={busy !== null} onClick={onClose}>Cancel</button>
        {cutPreview ? (
          <>
            <button className="btn-ghost" disabled={busy !== null} onClick={() => change(() => {})}>
              Back
            </button>
            <button
              className="btn"
              disabled={busy !== null || cutPreview.remaining.length > 0}
              onClick={() => runCut(true)}
            >
              {busy === 'cut' ? 'Cutting…' : 'Cut around, keep as one area'}
            </button>
          </>
        ) : preview ? (
          <>
            <button className="btn-ghost" disabled={busy !== null} onClick={() => change(() => {})}>
              Change size
            </button>
            <button className="btn" disabled={busy !== null || (preview.remaining?.length ?? 0) > 0} onClick={() => run(true)}>
              {busy === 'split' ? 'Splitting…' : `Split into ${preview.zones.length} zones`}
            </button>
          </>
        ) : (
          <>
            {/* An area that should stay whole but sits on another delivery: cut, do not split. */}
            {cut.length > 0 && onCut && (
              <button className="btn-ghost" disabled={busy !== null} onClick={() => runCut(false)}>
                {busy === 'cut-preview' ? 'Working…' : 'Cut around only (no split)'}
              </button>
            )}
            <button
              className="btn"
              disabled={busy !== null || !canSplit || !valid || (plan?.count ?? 0) < 2}
              onClick={() => run(false)}
            >
              {busy === 'preview' ? 'Working…' : 'Preview zones'}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
