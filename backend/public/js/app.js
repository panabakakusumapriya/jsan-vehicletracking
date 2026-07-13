/* ════════════════════════════════════════════
   JSAN Fleet Tracker — Admin Panel
   app.js
════════════════════════════════════════════ */

// ── STATE ─────────────────────────────────
const state = {
  token: null,
  user: null,
  currentPage: null,
  map: null,
  mapLayer: null,
  socket: null,
  markers: new Map(),         // driverId → leaflet marker
  liveDrivers: [],
  tripsPage: 1,
  tripsTotal: 0,
};

// ── API CLIENT ────────────────────────────
const API_BASE = '/api';

async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(API_BASE + path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

// ── AUTH ──────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const btnText = document.getElementById('login-btn-text');
  const btnLoader = document.getElementById('login-btn-loader');

  errEl.classList.add('hidden');
  btnText.classList.add('hidden');
  btnLoader.classList.remove('hidden');

  try {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('jsan_token', data.token);
    localStorage.setItem('jsan_user', JSON.stringify(data.user));
    bootApp();
  } catch (err) {
    errEl.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${err.message}`;
    errEl.classList.remove('hidden');
  } finally {
    btnText.classList.remove('hidden');
    btnLoader.classList.add('hidden');
  }
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('jsan_token');
  localStorage.removeItem('jsan_user');
  if (state.socket) { state.socket.disconnect(); state.socket = null; }
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}

function togglePassword() {
  const input = document.getElementById('login-password');
  const icon = document.getElementById('eye-icon');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'fas fa-eye-slash';
  } else {
    input.type = 'password';
    icon.className = 'fas fa-eye';
  }
}

// ── BOOT ──────────────────────────────────
function bootApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');

  // Sidebar user info
  const u = state.user;
  document.getElementById('sidebar-name').textContent = u.name || u.email;
  document.getElementById('sidebar-role').textContent = u.role;
  document.getElementById('sidebar-avatar').textContent = (u.name || u.email)[0].toUpperCase();

  // Show admin-only nav items
  if (u.role === 'admin' || u.role === 'manager') {
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = '');
  }

  startClock();
  connectSocket();
  navigate('dashboard');
}

// ── CLOCK ─────────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    document.getElementById('topbar-time').textContent =
      now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  tick();
  setInterval(tick, 1000);
}

// ── ROUTER ────────────────────────────────
const PAGE_META = {
  'dashboard': { title: 'Dashboard', breadcrumb: 'Home / Dashboard' },
  'live-map':  { title: 'Live Map',  breadcrumb: 'Fleet / Live Map' },
  'trips':     { title: 'Trips',     breadcrumb: 'Fleet / Trip History' },
  'users':     { title: 'Users',     breadcrumb: 'Admin / Users' },
  'vehicles':  { title: 'Vehicles',  breadcrumb: 'Fleet / Vehicles' },
};

function navigate(page) {
  if (state.currentPage === page) return;
  state.currentPage = page;

  // Update nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  // Update header
  const meta = PAGE_META[page] || { title: page, breadcrumb: `Home / ${page}` };
  document.getElementById('page-title').textContent = meta.title;
  document.getElementById('breadcrumb').textContent = meta.breadcrumb;

  // Show page
  document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
  document.getElementById(`page-${page}`).classList.remove('hidden');

  // Load page data
  switch (page) {
    case 'dashboard': loadDashboard(); break;
    case 'live-map':  initMap(); loadLiveDrivers(); break;
    case 'trips':     loadTrips(); break;
    case 'users':     loadUsers(); break;
    case 'vehicles':  loadVehicles(); break;
  }
}

// ── SOCKET.IO ─────────────────────────────
function connectSocket() {
  if (!window.io) return;
  state.socket = window.io({ auth: { token: state.token } });

  state.socket.on('connect', () => {
    const dot = document.querySelector('#conn-status .status-dot');
    const label = document.querySelector('#conn-status .status-label');
    dot.className = 'status-dot online';
    label.textContent = 'Live';
  });

  state.socket.on('disconnect', () => {
    const dot = document.querySelector('#conn-status .status-dot');
    const label = document.querySelector('#conn-status .status-label');
    dot.className = 'status-dot offline';
    label.textContent = 'Offline';
  });

  state.socket.on('location', (payload) => {
    updateLiveDriver(payload);
    if (state.currentPage === 'live-map') refreshMapMarker(payload);
    updateLiveBadge();
  });
}

// ── DASHBOARD ─────────────────────────────
async function loadDashboard() {
  try {
    const [liveData, tripsData, usersData, vehiclesData] = await Promise.allSettled([
      apiFetch('/tracking/live'),
      apiFetch('/trips?limit=5'),
      apiFetch('/users'),
      apiFetch('/vehicles'),
    ]);

    const live = liveData.status === 'fulfilled' ? liveData.value : { drivers: [] };
    const trips = tripsData.status === 'fulfilled' ? tripsData.value : { trips: [], total: 0 };
    const users = usersData.status === 'fulfilled' ? usersData.value : { users: [] };
    const vehicles = vehiclesData.status === 'fulfilled' ? vehiclesData.value : { vehicles: [] };

    // Stats
    const activeCount = (live.drivers || []).length;
    const driverCount = (users.users || []).filter(u => u.role === 'user').length;
    document.getElementById('stat-active').textContent = activeCount;
    document.getElementById('stat-drivers').textContent = driverCount;
    document.getElementById('stat-vehicles').textContent = (vehicles.vehicles || []).length;
    document.getElementById('stat-trips').textContent = trips.total || 0;

    // Live drivers list
    const driversEl = document.getElementById('live-drivers-list');
    const liveDrivers = live.drivers || [];
    state.liveDrivers = liveDrivers;
    updateLiveBadge();

    if (liveDrivers.length === 0) {
      driversEl.innerHTML = `<div class="empty-state"><i class="fas fa-satellite"></i><p>No active drivers</p></div>`;
    } else {
      driversEl.innerHTML = liveDrivers.map(d => driverItemHTML(d)).join('');
    }

    // Recent trips
    const tripsEl = document.getElementById('recent-trips-list');
    const recentTrips = trips.trips || [];
    if (recentTrips.length === 0) {
      tripsEl.innerHTML = `<div class="empty-state"><i class="fas fa-route"></i><p>No recent trips</p></div>`;
    } else {
      tripsEl.innerHTML = recentTrips.map(t => tripItemHTML(t)).join('');
    }
  } catch (err) {
    showToast('Failed to load dashboard: ' + err.message, 'error');
  }
}

function driverItemHTML(d) {
  const speed = d.lastLocation?.speedKmh != null ? `${Math.round(d.lastLocation.speedKmh)} km/h` : '—';
  const loc = d.lastLocation ? `${d.lastLocation.lat?.toFixed(4)}, ${d.lastLocation.lon?.toFixed(4)}` : 'Unknown';
  return `<div class="driver-item">
    <div class="driver-dot"></div>
    <div class="driver-info">
      <div class="driver-name">${esc(d.driverName || 'Driver')}</div>
      <div class="driver-meta">${esc(loc)}</div>
    </div>
    <div class="driver-speed">${speed}</div>
  </div>`;
}

function tripItemHTML(t) {
  const dist = t.distanceMeters ? `${(t.distanceMeters / 1000).toFixed(1)} km` : '0 km';
  const when = t.startedAt ? timeAgo(new Date(t.startedAt)) : '—';
  return `<div class="trip-item">
    <div class="trip-icon ${t.status}"><i class="fas fa-route"></i></div>
    <div class="trip-info">
      <div class="trip-title">Trip #${esc(t._id?.slice(-6) || '——')}</div>
      <div class="trip-meta">${esc(t.driverName || 'Unknown')} · ${when}</div>
    </div>
    <div class="trip-dist">${dist}</div>
  </div>`;
}

function updateLiveDriver(payload) {
  // Update or add to live drivers list
  const idx = state.liveDrivers.findIndex(d => String(d.driverId) === String(payload.driverId));
  if (idx >= 0) {
    state.liveDrivers[idx] = { ...state.liveDrivers[idx], lastLocation: payload };
  } else {
    state.liveDrivers.push({ driverId: payload.driverId, driverName: payload.driverName || 'Driver', lastLocation: payload });
  }

  if (state.currentPage === 'dashboard') {
    document.getElementById('stat-active').textContent = state.liveDrivers.length;
    const el = document.getElementById('live-drivers-list');
    if (el) el.innerHTML = state.liveDrivers.map(d => driverItemHTML(d)).join('');
  }
}

function updateLiveBadge() {
  const badge = document.getElementById('live-count-badge');
  const mapCount = document.getElementById('map-driver-count');
  const count = state.liveDrivers.length;
  if (badge) badge.textContent = count;
  if (mapCount) mapCount.textContent = `${count} active`;
}

// ── LIVE MAP ──────────────────────────────
function initMap() {
  if (state.map) return; // already initialized

  const map = L.map('map', { zoomControl: false }).setView([20, 0], 2);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  state.mapLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);

  state.map = map;
}

async function loadLiveDrivers() {
  try {
    const data = await apiFetch('/tracking/live');
    const drivers = data.drivers || [];
    state.liveDrivers = drivers;
    updateLiveBadge();

    const listEl = document.getElementById('map-driver-list');
    if (drivers.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><i class="fas fa-satellite"></i><p>No active drivers</p></div>`;
      return;
    }

    listEl.innerHTML = drivers.map(d => mapDriverItemHTML(d)).join('');

    // Add markers
    drivers.forEach(d => {
      if (d.lastLocation?.lat && d.lastLocation?.lon) {
        refreshMapMarker({ ...d.lastLocation, driverId: d.driverId, driverName: d.driverName });
      }
    });

    fitAllMarkers();
  } catch (err) {
    showToast('Failed to load live data: ' + err.message, 'error');
  }
}

function mapDriverItemHTML(d) {
  const speed = d.lastLocation?.speedKmh != null ? `${Math.round(d.lastLocation.speedKmh)} km/h` : '—';
  const heading = d.lastLocation?.heading != null ? `${Math.round(d.lastLocation.heading)}°` : '';
  return `<div class="driver-item" onclick="panToDriver('${d.driverId}')">
    <div class="driver-dot"></div>
    <div class="driver-info">
      <div class="driver-name">${esc(d.driverName || 'Driver')}</div>
      <div class="driver-meta">Speed: ${speed} ${heading ? `· Heading: ${heading}` : ''}</div>
    </div>
  </div>`;
}

function refreshMapMarker(payload) {
  if (!state.map || !payload.lat || !payload.lon) return;
  const id = String(payload.driverId);
  const latlng = [payload.lat, payload.lon];

  if (state.markers.has(id)) {
    state.markers.get(id).setLatLng(latlng);
  } else {
    const icon = L.divIcon({
      className: '',
      html: `<div class="fleet-marker active"><div class="fleet-marker-icon"><i class="fas fa-truck"></i></div></div>`,
      iconSize: [36, 36],
      iconAnchor: [18, 36],
      popupAnchor: [0, -40],
    });
    const marker = L.marker(latlng, { icon }).addTo(state.map);
    marker.bindPopup(`<b>${esc(payload.driverName || 'Driver')}</b><br>Speed: ${payload.speedKmh != null ? Math.round(payload.speedKmh) + ' km/h' : '—'}`);
    state.markers.set(id, marker);
  }

  // Update popup content
  const m = state.markers.get(id);
  m.setPopupContent(`<b>${esc(payload.driverName || 'Driver')}</b><br>Speed: ${payload.speedKmh != null ? Math.round(payload.speedKmh) + ' km/h' : '—'}<br>${latlng[0].toFixed(5)}, ${latlng[1].toFixed(5)}`);
}

function panToDriver(driverId) {
  const marker = state.markers.get(String(driverId));
  if (marker && state.map) {
    state.map.setView(marker.getLatLng(), 14, { animate: true });
    marker.openPopup();
  }
}

function fitAllMarkers() {
  if (!state.map || state.markers.size === 0) return;
  const group = L.featureGroup([...state.markers.values()]);
  state.map.fitBounds(group.getBounds().pad(0.2));
}

let darkTiles = false;
function toggleMapStyle() {
  if (!state.map || !state.mapLayer) return;
  state.map.removeLayer(state.mapLayer);
  darkTiles = !darkTiles;
  const url = darkTiles
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  state.mapLayer = L.tileLayer(url, { maxZoom: 19 }).addTo(state.map);
}

// ── TRIPS ─────────────────────────────────
async function loadTrips(page = 1) {
  state.tripsPage = page;
  const status = document.getElementById('trips-status-filter').value;
  const limit = 15;

  try {
    const qs = new URLSearchParams({ limit, page, ...(status && { status }) });
    const data = await apiFetch(`/trips?${qs}`);
    const trips = data.trips || [];
    state.tripsTotal = data.total || 0;

    const tbody = document.getElementById('trips-tbody');
    if (trips.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="table-loading"><i class="fas fa-route"></i> No trips found</td></tr>`;
    } else {
      tbody.innerHTML = trips.map(t => tripRowHTML(t)).join('');
    }

    renderPagination('trips-pagination', state.tripsTotal, limit, page, loadTrips);
  } catch (err) {
    showToast('Failed to load trips: ' + err.message, 'error');
  }
}

function tripRowHTML(t) {
  const dist = t.distanceMeters ? `${(t.distanceMeters / 1000).toFixed(2)} km` : '—';
  const maxSpd = t.maxSpeedKmh ? `${Math.round(t.maxSpeedKmh)} km/h` : '—';
  const started = t.startedAt ? new Date(t.startedAt).toLocaleString() : '—';
  return `<tr>
    <td class="text-mono">${esc(t._id?.slice(-8) || '—')}</td>
    <td>${esc(t.driverName || '—')}</td>
    <td><span class="status-badge ${t.status}">${t.status}</span></td>
    <td>${dist}</td>
    <td>${maxSpd}</td>
    <td>${t.pointCount || 0}</td>
    <td class="text-muted">${started}</td>
    <td>
      <div class="action-btns">
        <button class="btn-table primary" title="View on map" onclick="viewTripOnMap('${t._id}')"><i class="fas fa-map"></i></button>
      </div>
    </td>
  </tr>`;
}

async function viewTripOnMap(tripId) {
  try {
    const data = await apiFetch(`/trips/${tripId}?points=true`);
    const points = data.points || [];
    navigate('live-map');
    setTimeout(() => {
      if (!state.map) return;
      // Clear existing trip layers
      state.map.eachLayer(l => { if (l._tripLayer) state.map.removeLayer(l); });
      if (points.length < 2) { showToast('Not enough points to draw route.', 'info'); return; }
      const latlngs = points.map(p => [p.lat, p.lon]);
      const poly = L.polyline(latlngs, { color: '#3b82f6', weight: 3, opacity: 0.8 });
      poly._tripLayer = true;
      poly.addTo(state.map);
      state.map.fitBounds(poly.getBounds().pad(0.1));
      showToast(`Showing ${points.length} points for trip`, 'info');
    }, 300);
  } catch (err) {
    showToast('Failed to load trip: ' + err.message, 'error');
  }
}

// ── USERS ─────────────────────────────────
async function loadUsers() {
  const role = document.getElementById('users-role-filter').value;
  try {
    const qs = role ? `?role=${role}` : '';
    const data = await apiFetch(`/users${qs}`);
    const users = data.users || [];
    const tbody = document.getElementById('users-tbody');
    if (users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="table-loading"><i class="fas fa-users"></i> No users found</td></tr>`;
    } else {
      tbody.innerHTML = users.map(u => userRowHTML(u)).join('');
    }
  } catch (err) {
    showToast('Failed to load users: ' + err.message, 'error');
  }
}

function userRowHTML(u) {
  const lastLogin = u.lastLoginAt ? timeAgo(new Date(u.lastLoginAt)) : 'Never';
  const active = u.active ? 'online' : 'offline';
  return `<tr>
    <td>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="user-avatar" style="width:28px;height:28px;font-size:11px;flex-shrink:0">${(u.name || u.email)[0].toUpperCase()}</div>
        <span>${esc(u.name || '—')}</span>
      </div>
    </td>
    <td class="text-muted">${esc(u.email)}</td>
    <td class="text-muted">${esc(u.phone || '—')}</td>
    <td><span class="status-badge ${u.role}">${u.role}</span></td>
    <td><span class="status-badge ${active}">${u.active ? 'Active' : 'Inactive'}</span></td>
    <td class="text-muted">${lastLogin}</td>
    <td>
      <div class="action-btns">
        <button class="btn-table primary" onclick="openUserModal('${u._id}')" title="Edit"><i class="fas fa-pen"></i></button>
        <button class="btn-table danger" onclick="deleteUser('${u._id}','${esc(u.name||u.email)}')" title="Delete"><i class="fas fa-trash"></i></button>
      </div>
    </td>
  </tr>`;
}

async function openUserModal(id) {
  document.getElementById('user-modal-title').textContent = id ? 'Edit User' : 'Add User';
  document.getElementById('user-id').value = id || '';
  document.getElementById('user-name').value = '';
  document.getElementById('user-email').value = '';
  document.getElementById('user-phone').value = '';
  document.getElementById('user-role').value = 'user';
  document.getElementById('user-password').value = '';
  document.getElementById('user-form-error').classList.add('hidden');

  const pwdGroup = document.getElementById('user-password-group');
  const pwdInput = document.getElementById('user-password');
  if (id) {
    pwdGroup.style.display = 'none';
    pwdInput.removeAttribute('required');
    try {
      const data = await apiFetch(`/users/${id}`);
      const u = data.user || data;
      document.getElementById('user-name').value = u.name || '';
      document.getElementById('user-email').value = u.email || '';
      document.getElementById('user-phone').value = u.phone || '';
      document.getElementById('user-role').value = u.role || 'user';
    } catch (err) {
      showToast('Failed to load user: ' + err.message, 'error');
    }
  } else {
    pwdGroup.style.display = 'block';
    pwdInput.setAttribute('required', 'required');
  }

  document.getElementById('user-modal').classList.remove('hidden');
}

async function handleUserSave(e) {
  e.preventDefault();
  const id = document.getElementById('user-id').value;
  const errEl = document.getElementById('user-form-error');
  errEl.classList.add('hidden');

  const body = {
    name: document.getElementById('user-name').value.trim(),
    email: document.getElementById('user-email').value.trim(),
    phone: document.getElementById('user-phone').value.trim() || undefined,
    role: document.getElementById('user-role').value,
  };
  if (!id) body.password = document.getElementById('user-password').value;

  try {
    if (id) {
      await apiFetch(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      showToast('User updated successfully', 'success');
    } else {
      await apiFetch('/users', { method: 'POST', body: JSON.stringify(body) });
      showToast('User created successfully', 'success');
    }
    closeModal('user-modal');
    loadUsers();
  } catch (err) {
    errEl.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${esc(err.message)}`;
    errEl.classList.remove('hidden');
  }
}

function deleteUser(id, name) {
  showConfirm(`Delete user "${name}"? This action cannot be undone.`, async () => {
    try {
      await apiFetch(`/users/${id}`, { method: 'DELETE' });
      showToast('User deleted', 'success');
      loadUsers();
    } catch (err) {
      showToast('Failed to delete: ' + err.message, 'error');
    }
  });
}

// ── VEHICLES ──────────────────────────────
async function loadVehicles() {
  try {
    const data = await apiFetch('/vehicles');
    const vehicles = data.vehicles || [];
    const tbody = document.getElementById('vehicles-tbody');
    if (vehicles.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="table-loading"><i class="fas fa-truck"></i> No vehicles found</td></tr>`;
    } else {
      tbody.innerHTML = vehicles.map(v => vehicleRowHTML(v)).join('');
    }
  } catch (err) {
    showToast('Failed to load vehicles: ' + err.message, 'error');
  }
}

function vehicleRowHTML(v) {
  const active = v.active ? 'online' : 'offline';
  return `<tr>
    <td class="text-mono" style="font-weight:600">${esc(v.plateNumber)}</td>
    <td>${esc(v.model || '—')}</td>
    <td class="text-muted">${esc(v.assignedDriverId?.name || v.assignedDriverId || '—')}</td>
    <td><span class="status-badge ${active}">${v.active ? 'Active' : 'Inactive'}</span></td>
    <td>
      <div class="action-btns">
        <button class="btn-table primary" onclick="openVehicleModal('${v._id}')" title="Edit"><i class="fas fa-pen"></i></button>
        <button class="btn-table danger" onclick="deleteVehicle('${v._id}','${esc(v.plateNumber)}')" title="Delete"><i class="fas fa-trash"></i></button>
      </div>
    </td>
  </tr>`;
}

async function openVehicleModal(id) {
  document.getElementById('vehicle-modal-title').textContent = id ? 'Edit Vehicle' : 'Add Vehicle';
  document.getElementById('vehicle-id').value = id || '';
  document.getElementById('vehicle-plate').value = '';
  document.getElementById('vehicle-model').value = '';
  document.getElementById('vehicle-form-error').classList.add('hidden');

  if (id) {
    try {
      const data = await apiFetch(`/vehicles/${id}`);
      const v = data.vehicle || data;
      document.getElementById('vehicle-plate').value = v.plateNumber || '';
      document.getElementById('vehicle-model').value = v.model || '';
    } catch (err) {
      showToast('Failed to load vehicle: ' + err.message, 'error');
    }
  }

  document.getElementById('vehicle-modal').classList.remove('hidden');
}

async function handleVehicleSave(e) {
  e.preventDefault();
  const id = document.getElementById('vehicle-id').value;
  const errEl = document.getElementById('vehicle-form-error');
  errEl.classList.add('hidden');

  const body = {
    plateNumber: document.getElementById('vehicle-plate').value.trim(),
    model: document.getElementById('vehicle-model').value.trim(),
  };

  try {
    if (id) {
      await apiFetch(`/vehicles/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      showToast('Vehicle updated', 'success');
    } else {
      await apiFetch('/vehicles', { method: 'POST', body: JSON.stringify(body) });
      showToast('Vehicle created', 'success');
    }
    closeModal('vehicle-modal');
    loadVehicles();
  } catch (err) {
    errEl.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${esc(err.message)}`;
    errEl.classList.remove('hidden');
  }
}

function deleteVehicle(id, plate) {
  showConfirm(`Delete vehicle "${plate}"?`, async () => {
    try {
      await apiFetch(`/vehicles/${id}`, { method: 'DELETE' });
      showToast('Vehicle deleted', 'success');
      loadVehicles();
    } catch (err) {
      showToast('Failed to delete: ' + err.message, 'error');
    }
  });
}

// ── MODALS ────────────────────────────────
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function showConfirm(message, onConfirm) {
  document.getElementById('confirm-message').textContent = message;
  const btn = document.getElementById('confirm-ok-btn');
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);
  fresh.addEventListener('click', () => {
    closeModal('confirm-modal');
    onConfirm();
  });
  document.getElementById('confirm-modal').classList.remove('hidden');
}

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });
});

// ── PAGINATION ────────────────────────────
function renderPagination(containerId, total, limit, currentPage, loadFn) {
  const container = document.getElementById(containerId);
  const totalPages = Math.ceil(total / limit);
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  let html = '';
  if (currentPage > 1) html += `<button class="page-btn" onclick="${loadFn.name}(${currentPage-1})"><i class="fas fa-chevron-left"></i></button>`;
  for (let p = Math.max(1, currentPage - 2); p <= Math.min(totalPages, currentPage + 2); p++) {
    html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" onclick="${loadFn.name}(${p})">${p}</button>`;
  }
  if (currentPage < totalPages) html += `<button class="page-btn" onclick="${loadFn.name}(${currentPage+1})"><i class="fas fa-chevron-right"></i></button>`;
  container.innerHTML = html;
}

// ── TOAST ─────────────────────────────────
function showToast(message, type = 'info') {
  const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<i class="fas ${icons[type]} toast-icon"></i><span>${esc(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 3500);
}

// ── SIDEBAR TOGGLE ────────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
  // Refit map if visible
  if (state.map) setTimeout(() => state.map.invalidateSize(), 250);
}

// ── UTILITIES ─────────────────────────────
function esc(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(date) {
  const secs = Math.floor((Date.now() - date) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs/60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs/3600)}h ago`;
  return `${Math.floor(secs/86400)}d ago`;
}

// ── INIT ──────────────────────────────────
document.getElementById('login-form').addEventListener('submit', handleLogin);
document.getElementById('user-form').addEventListener('submit', handleUserSave);
document.getElementById('vehicle-form').addEventListener('submit', handleVehicleSave);

// Restore session
const savedToken = localStorage.getItem('jsan_token');
const savedUser = localStorage.getItem('jsan_user');
if (savedToken && savedUser) {
  try {
    state.token = savedToken;
    state.user = JSON.parse(savedUser);
    bootApp();
  } catch {
    localStorage.clear();
  }
}
