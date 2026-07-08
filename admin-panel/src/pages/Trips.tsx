import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { dt, km, statusBadge } from '../lib/format';
import type { Trip } from '../lib/types';

const driverName = (d: Trip['driverId']) => (typeof d === 'object' && d ? d.name : '—');
const plate = (v: Trip['vehicleId']) => (typeof v === 'object' && v ? v.plateNumber : '—');

export function Trips() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');

  useEffect(() => {
    setLoading(true);
    api
      .get<{ trips: Trip[] }>(`/api/trips${status ? `?status=${status}` : ''}`)
      .then((r) => setTrips(r.trips))
      .finally(() => setLoading(false));
  }, [status]);

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Trips</h1>
        <select className="input" style={{ width: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="timed_out">Timed out</option>
        </select>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Driver</th>
              <th>Vehicle</th>
              <th>Status</th>
              <th>Started</th>
              <th>Distance</th>
              <th>Max speed</th>
              <th>Points</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {trips.map((t) => (
              <tr key={t._id}>
                <td>{driverName(t.driverId)}</td>
                <td>{plate(t.vehicleId)}</td>
                <td>
                  <span className={`badge ${statusBadge(t.status)}`}>{t.status}</span>
                </td>
                <td>{dt(t.startedAt)}</td>
                <td>{km(t.distanceMeters)}</td>
                <td>{Math.round(t.maxSpeedKmh)} km/h</td>
                <td>{t.pointCount}</td>
                <td>
                  <Link to={`/trips/${t._id}`}>View path →</Link>
                </td>
              </tr>
            ))}
            {!loading && trips.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                  No trips yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
