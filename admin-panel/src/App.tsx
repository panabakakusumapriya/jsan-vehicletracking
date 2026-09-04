import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { DriverLayout } from './components/DriverLayout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AssetHistory } from './pages/AssetHistory';
import { Couriers } from './pages/Couriers';
import { Coverage } from './pages/Coverage';
import { Drivers } from './pages/Drivers';
import { Hotels } from './pages/Hotels';
import { LiveMap } from './pages/LiveMap';
import { Login } from './pages/Login';
import { AppUpdates } from './pages/AppUpdates';
import { Managers } from './pages/Managers';
import { Projects } from './pages/Projects';
import { Markers } from './pages/Markers';
import { SessionMap } from './pages/SessionMap';
import { TripDetail } from './pages/TripDetail';
import { Trips } from './pages/Trips';
import { Mobiles } from './pages/Mobiles';
import { Reports } from './pages/Reports';
import { Vehicles } from './pages/Vehicles';
import { AppHealth } from './pages/AppHealth';
import { Ukm } from './pages/Ukm';
import { Weather } from './pages/Weather';
import { SsdsPortal } from './pages/SsdsPortal';
import { SsdsTimesheets } from './pages/SsdsTimesheets';
import { SsdsDailyReports } from './pages/SsdsDailyReports';
import { DriverMySsds } from './pages/DriverMySsds';
import { DriverMyTimesheets } from './pages/DriverMyTimesheets';
import { DriverMyDailyReports } from './pages/DriverMyDailyReports';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<LiveMap />} />
        <Route path="/trips" element={<Trips />} />
        <Route path="/trips/:id" element={<TripDetail />} />
        <Route path="/trips/:id/map" element={<SessionMap />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/drivers" element={<Drivers />} />
        <Route path="/mobiles" element={<Mobiles />} />
        <Route path="/asset-history" element={<AssetHistory />} />
        <Route path="/weather" element={<Weather />} />
        <Route path="/hotels" element={<Hotels />} />
        <Route path="/couriers" element={<Couriers />} />
        <Route path="/vehicles" element={<Vehicles />} />
        <Route path="/ukm" element={<Ukm />} />
        <Route path="/coverage" element={<Coverage />} />
        <Route path="/app-health" element={<AppHealth />} />
        <Route
          path="/managers"
          element={
            <ProtectedRoute adminOnly tabKey="managers">
              <Managers />
            </ProtectedRoute>
          }
        />
        <Route
          path="/projects"
          element={
            <ProtectedRoute adminOnly tabKey="projects">
              <Projects />
            </ProtectedRoute>
          }
        />
        <Route
          path="/markers"
          element={
            <ProtectedRoute adminOnly tabKey="markers">
              <Markers />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app-updates"
          element={
            <ProtectedRoute adminOnly tabKey="app_updates">
              <AppUpdates />
            </ProtectedRoute>
          }
        />
        <Route
          path="/ssds-portal"
          element={
            <ProtectedRoute tabKey="ssds_portal">
              <SsdsPortal />
            </ProtectedRoute>
          }
        />
        <Route
          path="/ssds-timesheets"
          element={
            <ProtectedRoute tabKey="timesheets">
              <SsdsTimesheets />
            </ProtectedRoute>
          }
        />
        <Route
          path="/ssds-daily-reports"
          element={
            <ProtectedRoute tabKey="daily_status_report">
              <SsdsDailyReports />
            </ProtectedRoute>
          }
        />
      </Route>
      {/* ── Driver Portal ── */}
      <Route
        element={
          <ProtectedRoute>
            <DriverLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/driver" element={<DriverMySsds />} />
        <Route path="/driver/timesheets" element={<DriverMyTimesheets />} />
        <Route path="/driver/daily-reports" element={<DriverMyDailyReports />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
