import 'leaflet/dist/leaflet.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
// Imported for its side effect too: it hooks `beforeinstallprompt` at module load, which
// Chrome may fire before React has mounted.
import { registerServiceWorker } from './lib/pwa';
import { SocketProvider } from './lib/socket';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <SocketProvider>
          <App />
        </SocketProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);

// After paint — the worker is what receives push while the panel is closed, but nothing on
// screen waits for it.
window.addEventListener('load', () => {
  registerServiceWorker();
});
