import { useEffect, useMemo, useState } from 'react';
import { api, downloadFile } from '../lib/api';
import type { CustodyReport, CustodyStint } from '../lib/types';

/**
 * "In June, which driver had which vehicle and which mobile?"
 *
 * Reads the assignment ledger rather than the current pointers, so reassigning a truck no
 * longer erases last month. Drivers holding nothing are shown deliberately — an idle driver
 * or an unassigned month is usually the thing worth spotting.
 */

// A month is not the same instant everywhere: June starts 10 hours earlier in Sydney than in
// UTC. Getting this wrong silently shifts day-counts at every boundary, so it is a visible
// control rather than a hidden assumption.
const ZONES = [
  'UTC',
  'Australia/Sydney',
  'Australia/Perth',
  'Asia/Singapore',
  'Asia/Kolkata',
  'Europe/Paris',
  'Europe/London',
];

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function StintCell({ stints, monthDays, driverCountry }: {
  stints: CustodyStint[];
  monthDays: number;
  /** Today's country for this driver. A stint recorded elsewhere is called out explicitly. */
  driverCountry?: string | null;
}) {
  if (!stints.length) {
    return <span style={{ color: 'var(--muted)', fontStyle: 'italic', fontSize: 12.5 }}>— none —</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {stints.map(s => {
        const wholeMonth = s.days >= monthDays - 0.05;
        return (
          <div key={s.assignmentId} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{
              background: 'var(--panel-2)', border: '1px solid var(--line-2)',
              borderRadius: 5, padding: '1px 7px',
              fontSize: 11.5, fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-2)',
            }}>
              {s.label || '—'}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {wholeMonth ? 'all month' : `${s.from.slice(5)} → ${s.to.slice(5)}`}
              {' · '}
              <b style={{ color: 'var(--text-2)' }}>{s.days}d</b>
            </span>
            {s.country && driverCountry && s.country !== driverCountry && (
              <span
                className="badge amber"
                style={{ fontSize: 10 }}
                title={`Recorded while the driver was in ${s.country}. They are in ${driverCountry} now — moving country does not rewrite earlier months.`}
              >
                in {s.country}
              </span>
            )}
            {s.stillOpen && <span className="badge green" style={{ fontSize: 10 }}>current</span>}
            {s.backfilled && (
              <span
                className="badge gray"
                style={{ fontSize: 10 }}
                title="Start date inferred when history was first imported — the real handover may have been earlier."
              >
                since at least
              </span>
            )}
            <AuditTrail stint={s} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Who moved this asset, and when.
 *
 * The ledger has recorded `assignedBy`/`releasedBy` since the custody feature shipped, but the
 * report dropped them on the way to the page — so the one screen you open to ask "who reassigned
 * that van?" could not answer it, and the only way to find out was to read the database.
 *
 * Shown compactly with the full detail on hover: the common question is "was this me or someone
 * else", which a name answers, while the exact timestamps matter only when something is disputed.
 * Older records can predate the audit fields, so nothing is rendered when we genuinely do not
 * know — an empty byline is honest, a guessed one is not.
 */
function AuditTrail({ stint }: { stint: CustodyStint }) {
  if (!stint.assignedBy && !stint.releasedBy) return null;

  const at = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

  const detail = [
    stint.assignedBy ? `Assigned by ${stint.assignedBy}${at(stint.assignedAt) ? ` on ${at(stint.assignedAt)}` : ''}` : null,
    stint.releasedBy ? `Released by ${stint.releasedBy}${at(stint.releasedAt) ? ` on ${at(stint.releasedAt)}` : ''}` : null,
  ].filter(Boolean).join('\n');

  return (
    <span
      title={detail}
      style={{
        fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap',
        borderLeft: '1px solid var(--line-2)', paddingLeft: 8, marginLeft: 2,
      }}
    >
      by <b style={{ color: 'var(--text-2)' }}>{stint.releasedBy || stint.assignedBy}</b>
      {at(stint.releasedAt || stint.assignedAt) && (
        <> · {new Date((stint.releasedAt || stint.assignedAt)!).toLocaleDateString()}</>
      )}
    </span>
  );
}

export function AssetHistory() {
  const [month, setMonth] = useState(thisMonth);
  const [tz, setTz] = useState(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  });
  const [report, setReport] = useState<CustodyReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyAssigned, setOnlyAssigned] = useState(false);
  const [query, setQuery] = useState('');

  const zones = useMemo(() => (ZONES.includes(tz) ? ZONES : [tz, ...ZONES]), [tz]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api.get<CustodyReport>(`/api/reports/custody?month=${month}&tz=${encodeURIComponent(tz)}`)
      .then(r => { if (alive) setReport(r); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : 'Could not load the report'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [month, tz]);

  const rows = useMemo(() => {
    if (!report) return [];
    const q = query.trim().toLowerCase();
    return report.rows.filter(r => {
      if (onlyAssigned && !r.vehicles.length && !r.mobiles.length) return false;
      if (!q) return true;
      return (
        r.driver.name.toLowerCase().includes(q) ||
        r.vehicles.some(s => (s.label || '').toLowerCase().includes(q)) ||
        r.mobiles.some(s => (s.label || '').toLowerCase().includes(q))
      );
    });
  }, [report, onlyAssigned, query]);

  const isFuture = month > thisMonth();

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Asset history</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Who had which vehicle and which mobile, month by month
          </p>
        </div>
        <button
          className="btn"
          disabled={!report || !report.rows.length}
          onClick={() => downloadFile(
            `/api/reports/custody.csv?month=${month}&tz=${encodeURIComponent(tz)}`,
            `custody-${month}.csv`
          )}
        >
          Export CSV
        </button>
      </div>

      {/* Controls */}
      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button className="btn-ghost" onClick={() => setMonth(m => shiftMonth(m, -1))} title="Previous month">←</button>
          <input
            type="month"
            className="input"
            style={{ width: 160 }}
            value={month}
            onChange={e => e.target.value && setMonth(e.target.value)}
          />
          <button
            className="btn-ghost"
            onClick={() => setMonth(m => shiftMonth(m, 1))}
            disabled={isFuture}
            title="Next month"
          >
            →
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Timezone</span>
          <select className="input" style={{ width: 190 }} value={tz} onChange={e => setTz(e.target.value)}>
            {zones.map(z => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>

        <input
          className="input"
          style={{ width: 200 }}
          placeholder="Search driver or asset…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />

        <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text-2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyAssigned} onChange={e => setOnlyAssigned(e.target.checked)} />
          Only drivers with assets
        </label>
      </div>

      {error && <div className="error-text">{error}</div>}

      {report && !error && (
        <div className="stat-row">
          <div className="stat"><div className="v">{report.totals.drivers}</div><div className="k">Drivers</div></div>
          <div className="stat"><div className="v" style={{ color: 'var(--green)' }}>{report.totals.driversWithVehicle}</div><div className="k">Had a vehicle</div></div>
          <div className="stat"><div className="v" style={{ color: 'var(--green)' }}>{report.totals.driversWithMobile}</div><div className="k">Had a mobile</div></div>
          <div className="stat"><div className="v" style={{ color: report.totals.driversWithNothing ? 'var(--amber)' : undefined }}>{report.totals.driversWithNothing}</div><div className="k">Had nothing</div></div>
          <div className="stat"><div className="v">{report.totals.vehicleStints + report.totals.mobileStints}</div><div className="k">Handovers touching this month</div></div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Driver</th>
              <th>Country</th>
              <th style={{ minWidth: 240 }}>Vehicle</th>
              <th style={{ minWidth: 240 }}>Mobile</th>
              <th style={{ textAlign: 'right' }}>Days</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>Loading {monthLabel(month)}…</td></tr>
            )}

            {!loading && rows.map(r => (
              <tr key={r.driver._id}>
                <td style={{ fontWeight: 600 }}>
                  {r.driver.name}
                  {!r.driver.active && <span className="badge gray" style={{ marginLeft: 8, fontSize: 10 }}>exited</span>}
                </td>
                <td style={{ fontSize: 12.5, color: 'var(--muted)' }}>{r.driver.country || '—'}</td>
                <td><StintCell stints={r.vehicles} monthDays={report?.monthDays ?? 30} driverCountry={r.driver.country} /></td>
                <td><StintCell stints={r.mobiles} monthDays={report?.monthDays ?? 30} driverCountry={r.driver.country} /></td>
                <td style={{ textAlign: 'right', fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  {r.vehicleDays ? <div>🚚 {r.vehicleDays}d</div> : null}
                  {r.mobileDays ? <div>📱 {r.mobileDays}d</div> : null}
                  {!r.vehicleDays && !r.mobileDays ? '—' : null}
                </td>
              </tr>
            ))}

            {!loading && !rows.length && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '44px 24px', color: 'var(--muted)', lineHeight: 1.7 }}>
                  <div style={{ fontSize: 32, opacity: 0.25, marginBottom: 8 }}>📋</div>
                  Nothing recorded for <b>{monthLabel(month)}</b>.<br />
                  History begins when assets are first assigned — earlier months stay empty
                  unless the backfill was run.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {report && (
        <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 12, lineHeight: 1.6 }}>
          Dates and day-counts are shown in <b>{report.tz}</b>. A stint is counted from the day it
          started up to (not including) the day it ended, clipped to this month — so every holder
          of one asset adds up to the month, with any shortfall being days it sat unassigned.
          An <span className="badge amber" style={{ fontSize: 10 }}>in …</span> tag means that
          stint was recorded while the driver was in a different country from where they are now.
        </p>
      )}
    </div>
  );
}
