import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { AssetHistory } from './pages/AssetHistory';
import { Couriers } from './pages/Couriers';
import { Drivers } from './pages/Drivers';
import { Hotels } from './pages/Hotels';
import { LiveMap } from './pages/LiveMap';
import { Login } from './pages/Login';
import { AppUpdates } from './pages/AppUpdates';
import { Managers } from './pages/Managers';
import { Projects } from './pages/Projects';
import { SessionMap } from './pages/SessionMap';
import { TripDetail } from './pages/TripDetail';
import { Trips } from './pages/Trips';
import { Mobiles } from './pages/Mobiles';
import { Reports } from './pages/Reports';
import { Vehicles } from './pages/Vehicles';
import { Weather } from './pages/Weather';

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
        <Route
          path="/managers"
          element={
            <ProtectedRoute adminOnly>
              <Managers />
            </ProtectedRoute>
          }
        />
        <Route
          path="/projects"
          element={
            <ProtectedRoute adminOnly>
              <Projects />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app-updates"
          element={
            <ProtectedRoute adminOnly>
              <AppUpdates />
            </ProtectedRoute>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
