import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Drivers } from './pages/Drivers';
import { LiveMap } from './pages/LiveMap';
import { Login } from './pages/Login';
import { AppUpdates } from './pages/AppUpdates';
import { Managers } from './pages/Managers';
import { TripDetail } from './pages/TripDetail';
import { Trips } from './pages/Trips';
import { Vehicles } from './pages/Vehicles';

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
        <Route path="/drivers" element={<Drivers />} />
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
