const { ObjectId } = require('mongodb');
const asyncHandler = require('../utils/asyncHandler');
const Project = require('../models/Project');
const User = require('../models/User');
const { getSsdsCollections } = require('../config/ssdsDb');
const { isS3Configured, uploadToS3, getFromS3 } = require('../config/s3');

function getISTDate() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Build a Mongo filter fragment that scopes SSDS queries by project.
 *   admin       -> no filter (sees everything, including unassigned)
 *   manager/tl  -> only records whose projectId is in their projectIds
 *
 * An optional `projectId` query-param lets admins narrow to a single project,
 * and lets managers pick one of their own projects.
 */
function projectFilter(req) {
  const isAdmin = req.user.role === 'admin';
  const userProjectIds = (req.user.projectIds || []).map(String);
  const requested = req.query.projectId || null;

  if (isAdmin) {
    if (requested === 'unassigned') return { projectId: { $exists: false } };
    if (requested) return { projectId: requested };
    return {}; // admin sees all
  }

  // Manager / team_lead: restrict to own projects
  if (!userProjectIds.length) return { projectId: '__none__' }; // no projects → no data
  if (requested && userProjectIds.includes(requested)) return { projectId: requested };
  return { projectId: { $in: userProjectIds } };
}

// ── SSDS Portal ──
// Driver data comes from the User model (same as the Drivers tab).
// SSD-specific fields (SSD Number, SSD Status) are stored in the `drivers` SSDS collection,
// linked by userId. This avoids duplicating driver data.

exports.getSsds = asyncHandler(async (req, res) => {
  const { drivers: ssdCol } = getSsdsCollections();

  // Build user query scoped by project
  const isAdmin = req.user.role === 'admin';
  const userProjectIds = (req.user.projectIds || []).map(String);
  const requestedProject = req.query.projectId || null;

  const userQuery = { role: 'user' };
  if (!isAdmin) {
    if (!userProjectIds.length) return res.json({ data: [], total_drivers: 0, total_ssds: 0 });
    if (requestedProject && userProjectIds.includes(requestedProject)) {
      userQuery.projectIds = new ObjectId(requestedProject);
    } else {
      userQuery.projectIds = { $in: userProjectIds.map(id => new ObjectId(id)) };
    }
  } else if (requestedProject && requestedProject !== 'unassigned') {
    userQuery.projectIds = new ObjectId(requestedProject);
  } else if (requestedProject === 'unassigned') {
    userQuery.projectIds = { $size: 0 };
  }

  const users = await User.find(userQuery)
    .populate('vehicleId', 'plateNumber vid model')
    .populate('mobileDeviceId', 'label phoneModel')
    .populate('teamLeadId', 'name')
    .populate('projectIds', 'name code country')
    .lean();

  // Get all SSD records grouped by userId
  const ssdRecords = await ssdCol.find().toArray();
  const ssdsByUserId = {};
  ssdRecords.forEach(s => {
    if (s.userId) {
      if (!ssdsByUserId[s.userId]) ssdsByUserId[s.userId] = [];
      ssdsByUserId[s.userId].push(s);
    }
  });

  const data = [];
  const userIdSet = new Set();
  users.forEach(u => {
    const uid = u._id.toString();
    userIdSet.add(uid);
    const userSsds = ssdsByUserId[uid] || [{}]; // at least one row per driver (empty if no SSD)
    const driverFields = {
      name: u.name,
      email: u.email,
      driverId: u.driverId,
      project: u.project,
      projectIds: (u.projectIds || []).map(p => typeof p === 'object' ? { _id: p._id.toString(), name: p.name } : p),
      vehicle: u.vehicleId ? { plateNumber: u.vehicleId.plateNumber, vid: u.vehicleId.vid, model: u.vehicleId.model } : null,
      mobile: u.mobileDeviceId ? { label: u.mobileDeviceId.label, phoneModel: u.mobileDeviceId.phoneModel } : null,
      scope: u.scope,
      region: u.region,
      country: u.country,
      drivingLocation: u.drivingLocation,
      driverMode: u.driverMode,
      teamLead: u.teamLeadId ? (typeof u.teamLeadId === 'object' ? u.teamLeadId.name : null) : null,
      poc: u.poc,
      contact: u.contact,
      personalMail: u.personalMail,
      driverAddress: u.driverAddress,
      ctsMail: u.ctsMail,
      driverStatus: u.driverStatus,
      joiningDate: u.joiningDate,
      exitDate: u.exitDate,
      pricePerHour: u.pricePerHour,
      perDiem: u.perDiem,
      currency: u.currency,
      language: u.language,
      timezone: u.timezone,
      active: u.active,
    };
    userSsds.forEach(ssd => {
      data.push({
        _id: uid,
        ssdRecordId: ssd._id ? ssd._id.toString() : null,
        ...driverFields,
        ssdNumber: ssd['SSD Number'] || '',
        ssdStatus: ssd['SSD Status'] || '',
        ssdComments: ssd.comments || '',
        ssdImageUrl: ssd.ssdImageUrl || ssd.ssdImagePath || '',
        lastUpdated: ssd['Last Updated'] || '',
        createdAt: ssd.createdAt || '',
      });
    });
  });

  res.json({
    data,
    total_drivers: userIdSet.size,
    total_ssds: data.filter(d => d.ssdNumber).length,
  });
});

exports.getSsdsHistory = asyncHandler(async (req, res) => {
  const { driverHistory } = getSsdsCollections();
  const { startDate, endDate } = req.query;
  const query = { ...projectFilter(req) };
  if (startDate || endDate) {
    query.updatedDate = {};
    if (startDate) query.updatedDate.$gte = startDate;
    if (endDate) query.updatedDate.$lte = endDate;
  }
  const history = await driverHistory.find(query).sort({ updatedAt: -1 }).limit(500).toArray();
  res.json({ history: history.map((h) => ({ ...h, _id: h._id.toString() })) });
});

exports.exportSsds = asyncHandler(async (req, res) => {
  const XLSX = require('xlsx');
  // Re-use getSsds logic by calling it internally (fake res to capture json)
  const captured = {};
  const fakeRes = { json: (d) => { captured.data = d; } };
  await exports.getSsds({ ...req }, fakeRes);
  const rows = (captured.data?.data || []).map(d => ({
    'Driver': d.name || '',
    'Email': d.email || '',
    'Country': d.country || '',
    'VID': d.vehicle?.vid || '',
    'SSD': d.ssdNumber || '',
    'Status': d.ssdStatus || '',
    'Date': d.createdAt ? new Date(d.createdAt).toISOString().split('T')[0] : '',
    'Last Updated': d.lastUpdated || '',
    'Comments': d.ssdComments || '',
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'SSDS');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const today = getISTDate().replace(/-/g, '');
  res.setHeader('Content-Disposition', `attachment; filename=ssd_data_${today}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// ── Timesheets ──

exports.getTimesheets = asyncHandler(async (req, res) => {
  const { timesheets: tsCol } = getSsdsCollections();
  const { startDate, endDate, status, country } = req.query;
  const pFilter = projectFilter(req);

  const query = { Actions: { $not: /^\s*finalized\s*$/i }, ...pFilter };
  if (status) query.Status = status;
  if (country) query.Country = country;

  let results = await tsCol.find(query).sort({ _sheetRow: 1, _id: 1 }).toArray();

  if (startDate || endDate) {
    results = results.filter((t) => {
      const updateDate = t['Last Updated'] ? String(t['Last Updated']).split(' ')[0] : '';
      if (startDate && updateDate < startDate) return false;
      if (endDate && updateDate > endDate) return false;
      return true;
    });
  }

  // Fix CommentsHistory attribution
  results.forEach((ts) => {
    if (ts.CommentsHistory && ts.CommentsHistory.length > 0 && ts['Driver Name']) {
      if (ts.CommentsHistory[0].by === 'Admin') ts.CommentsHistory[0].by = ts['Driver Name'];
    }
  });

  // Load project names
  const projectIds = [...new Set(results.map((t) => t.projectId).filter(Boolean))];
  const projects = projectIds.length
    ? await Project.find({ _id: { $in: projectIds } }).select('name').lean()
    : [];
  const projectMap = {};
  projects.forEach((p) => { projectMap[p._id.toString()] = p.name; });

  res.json({
    timesheets: results.map((t) => ({
      ...t,
      _id: t._id.toString(),
      projectName: t.projectId ? (projectMap[t.projectId] || null) : null,
    })),
  });
});

exports.exportTimesheets = asyncHandler(async (req, res) => {
  const XLSX = require('xlsx');
  const { timesheets: tsCol } = getSsdsCollections();
  const { startDate, endDate } = req.query;
  const pFilter = projectFilter(req);

  const query = { Actions: { $not: /^\s*finalized\s*$/i }, ...pFilter };
  let results = await tsCol.find(query).sort({ _sheetRow: 1, _id: 1 }).toArray();
  if (startDate || endDate) {
    results = results.filter((t) => {
      const d = t['Last Updated'] ? String(t['Last Updated']).split(' ')[0] : '';
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    });
  }

  const exportData = results.map((t) => ({
    'Driver Name': t['Driver Name'] || '', Date: t.Date || '', 'Mail ID': t['Mail ID'] || '',
    Country: t.Country || '', 'Actual Hours': t['Actual Hours'] || '', Status: t.Status || '',
    Comments: t.Comments || '', 'Last Updated': t['Last Updated'] || '',
  }));
  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Timesheets');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename=timesheets_${getISTDate().replace(/-/g, '')}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// ── Daily Reports ──

exports.getDailyReports = asyncHandler(async (req, res) => {
  const { dailyReports, driverMaps } = getSsdsCollections();
  const pFilter = projectFilter(req);
  const reports = await dailyReports.find(pFilter).sort({ submittedAt: -1 }).limit(200).toArray();
  const mapAssignments = await driverMaps.find(pFilter).toArray();

  // Load project names
  const projectIds = [...new Set(reports.map((r) => r.projectId).filter(Boolean))];
  const projects = projectIds.length
    ? await Project.find({ _id: { $in: projectIds } }).select('name').lean()
    : [];
  const projectMap = {};
  projects.forEach((p) => { projectMap[p._id.toString()] = p.name; });

  res.json({
    reports: reports.map((r) => ({
      ...r,
      _id: r._id.toString(),
      projectName: r.projectId ? (projectMap[r.projectId] || null) : null,
    })),
    mapAssignments: mapAssignments.map((m) => ({ ...m, _id: m._id.toString() })),
    total_reports: reports.length,
  });
});

exports.exportDailyReports = asyncHandler(async (req, res) => {
  const XLSX = require('xlsx');
  const { dailyReports } = getSsdsCollections();
  const { startDate, endDate } = req.query;
  const pFilter = projectFilter(req);
  const query = { ...pFilter };
  if (startDate || endDate) {
    query.submittedAt = {};
    if (startDate) query.submittedAt.$gte = new Date(startDate);
    if (endDate) query.submittedAt.$lte = new Date(endDate + 'T23:59:59.999Z');
  }
  const reports = await dailyReports.find(query).sort({ submittedAt: -1 }).toArray();
  const exportData = reports.map((r) => ({
    'Driver Name': r.driverName || '', Email: r.driverEmail || '', VID: r.vid || '',
    'Report Type': r.reportType || '', Map: r.map || '', 'KMs Done': r.kmsDone || '',
    Status: r.status || '', Notes: r.notes || '',
    'Submitted At': r.submittedAt ? new Date(r.submittedAt).toISOString() : '',
  }));
  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'DailyReports');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename=daily_reports_${getISTDate().replace(/-/g, '')}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// ── Create/Update SSD record for a driver ──
// POST /api/ssds/ssds — body: { userId, ssdNumber, ssdStatus }
// Links an SSD record to an existing user (driver).

exports.createDriver = asyncHandler(async (req, res) => {
  const { drivers: ssdCol } = getSsdsCollections();
  const { userId, ssdNumber, ssdStatus, comments } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (!ssdNumber) return res.status(400).json({ error: 'SSD Number is required' });

  const driver = await User.findById(userId);
  if (!driver || driver.role !== 'user') return res.status(404).json({ error: 'Driver not found' });

  // Check if same SSD number already exists for this driver
  const existing = await ssdCol.findOne({ userId: userId, 'SSD Number': ssdNumber });
  if (existing) return res.status(400).json({ error: 'This driver already has an SSD record with this number.' });

  const doc = {
    userId: userId,
    'SSD Number': ssdNumber || '',
    'SSD Status': ssdStatus || '',
    comments: comments || '',
    'Last Updated': getISTDate(),
    createdAt: new Date(),
    createdBy: req.user._id.toString(),
  };

  // Store image if uploaded
  if (req.file) {
    if (isS3Configured() && req.file.buffer) {
      const s3Key = await uploadToS3(req.file.buffer, req.file.originalname, userId);
      doc.ssdImageUrl = '/api/ssds/image/' + encodeURIComponent(s3Key);
    } else if (req.file.filename) {
      doc.ssdImageUrl = '/uploads/ssd/' + req.file.filename;
    }
  }

  const result = await ssdCol.insertOne(doc);
  res.status(201).json({ _id: result.insertedId.toString(), ...doc });
});

// ── Update SSD record ──
// PATCH /api/ssds/ssds/:id — updates SSD Number & Status
// :id can be a ssdRecordId (ObjectId) or userId string

exports.updateDriver = asyncHandler(async (req, res) => {
  const { drivers: ssdCol } = getSsdsCollections();
  const id = req.params.id;

  const { ssdNumber, ssdStatus, comments } = req.body;
  const updates = {};
  if (ssdNumber !== undefined) updates['SSD Number'] = ssdNumber;
  if (ssdStatus !== undefined) updates['SSD Status'] = ssdStatus;
  if (comments !== undefined) updates.comments = comments;
  updates['Last Updated'] = getISTDate();

  // Try matching by record _id first, fallback to userId
  let filter;
  try { filter = { _id: new ObjectId(id) }; } catch { filter = { userId: id }; }

  // Check if record exists; if matching by _id and not found, try userId
  let existing = await ssdCol.findOne(filter);
  if (!existing && filter._id) {
    filter = { userId: id };
    existing = await ssdCol.findOne(filter);
  }

  if (existing) {
    await ssdCol.updateOne({ _id: existing._id }, { $set: updates });
  } else {
    // Upsert: create new if no record found
    await ssdCol.insertOne({
      userId: id,
      ...updates,
      createdAt: new Date(),
      createdBy: req.user._id.toString(),
    });
  }
  res.json({ ok: true });
});

// ── Delete SSD record ──
// DELETE /api/ssds/ssds/:id — removes a specific SSD record
// :id can be a ssdRecordId (ObjectId) or userId string

exports.deleteDriver = asyncHandler(async (req, res) => {
  const { drivers: ssdCol } = getSsdsCollections();
  const id = req.params.id;

  // Try matching by record _id first, fallback to userId
  let result;
  try {
    result = await ssdCol.deleteOne({ _id: new ObjectId(id) });
  } catch {
    result = { deletedCount: 0 };
  }
  if (!result.deletedCount) {
    result = await ssdCol.deleteOne({ userId: id });
  }
  if (!result.deletedCount) return res.status(404).json({ error: 'No SSD record found' });
  res.json({ ok: true });
});

// ── Create Timesheet ──
// POST /api/ssds/timesheets

exports.createTimesheet = asyncHandler(async (req, res) => {
  const { timesheets } = getSsdsCollections();
  const b = req.body;
  if (!b['Driver Name']) return res.status(400).json({ error: 'Driver Name is required' });

  const projectId = resolveProjectIdForCreate(req);
  if (!projectId) return res.status(400).json({ error: 'A project is required.' });

  const doc = {
    'Driver Name': b['Driver Name'],
    'Date': b['Date'] || getISTDate(),
    'Mail ID': b['Mail ID'] || '',
    'Country': b['Country'] || '',
    'Actual Hours': b['Actual Hours'] || '',
    'Status': b['Status'] || 'Pending',
    'Comments': b['Comments'] || '',
    'Last Updated': new Date().toISOString().replace('T', ' ').slice(0, 19),
    Actions: '',
    projectId,
    createdAt: new Date(),
    createdBy: req.user._id.toString(),
  };
  const result = await timesheets.insertOne(doc);
  res.status(201).json({ _id: result.insertedId.toString(), ...doc });
});

// ── Update Timesheet ──

exports.updateTimesheet = asyncHandler(async (req, res) => {
  const { timesheets } = getSsdsCollections();
  let oid;
  try { oid = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'Invalid id' }); }

  const existing = await timesheets.findOne({ _id: oid });
  if (!existing) return res.status(404).json({ error: 'Timesheet not found' });
  if (!canAccessRecord(req, existing)) return res.status(403).json({ error: 'Forbidden' });

  const b = req.body;
  const updates = {};
  const fields = ['Driver Name', 'Date', 'Mail ID', 'Country', 'Actual Hours', 'Status', 'Comments'];
  fields.forEach(f => { if (b[f] !== undefined) updates[f] = b[f]; });
  if (b.projectId !== undefined) {
    if (b.projectId && !canAssignProject(req, b.projectId)) return res.status(403).json({ error: 'Cannot assign that project' });
    if (b.projectId) updates.projectId = b.projectId; else updates.projectId = null;
  }
  updates['Last Updated'] = new Date().toISOString().replace('T', ' ').slice(0, 19);

  await timesheets.updateOne({ _id: oid }, { $set: updates });
  res.json({ ok: true });
});

// ── Delete Timesheet ──

exports.deleteTimesheet = asyncHandler(async (req, res) => {
  const { timesheets } = getSsdsCollections();
  let oid;
  try { oid = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'Invalid id' }); }

  const existing = await timesheets.findOne({ _id: oid });
  if (!existing) return res.status(404).json({ error: 'Timesheet not found' });
  if (!canAccessRecord(req, existing)) return res.status(403).json({ error: 'Forbidden' });

  await timesheets.deleteOne({ _id: oid });
  res.json({ ok: true });
});

// ── Create Daily Report ──
// POST /api/ssds/daily-reports

exports.createDailyReport = asyncHandler(async (req, res) => {
  const { dailyReports } = getSsdsCollections();
  const b = req.body;
  if (!b.driverName) return res.status(400).json({ error: 'Driver name is required' });

  const projectId = resolveProjectIdForCreate(req);
  if (!projectId) return res.status(400).json({ error: 'A project is required.' });

  const doc = {
    driverName: b.driverName,
    driverEmail: b.driverEmail || '',
    vid: b.vid || '',
    reportType: b.reportType || 'BOD',
    map: b.map || '',
    kmsDone: b.kmsDone || '',
    status: b.status || 'Pending',
    notes: b.notes || '',
    submittedAt: new Date(),
    projectId,
    createdBy: req.user._id.toString(),
  };
  const result = await dailyReports.insertOne(doc);
  res.status(201).json({ _id: result.insertedId.toString(), ...doc });
});

// ── Update Daily Report ──

exports.updateDailyReport = asyncHandler(async (req, res) => {
  const { dailyReports } = getSsdsCollections();
  let oid;
  try { oid = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'Invalid id' }); }

  const existing = await dailyReports.findOne({ _id: oid });
  if (!existing) return res.status(404).json({ error: 'Report not found' });
  if (!canAccessRecord(req, existing)) return res.status(403).json({ error: 'Forbidden' });

  const b = req.body;
  const updates = {};
  const fields = ['driverName', 'driverEmail', 'vid', 'reportType', 'map', 'kmsDone', 'status', 'notes'];
  fields.forEach(f => { if (b[f] !== undefined) updates[f] = b[f]; });
  if (b.projectId !== undefined) {
    if (b.projectId && !canAssignProject(req, b.projectId)) return res.status(403).json({ error: 'Cannot assign that project' });
    if (b.projectId) updates.projectId = b.projectId; else updates.projectId = null;
  }

  await dailyReports.updateOne({ _id: oid }, { $set: updates });
  res.json({ ok: true });
});

// ── Delete Daily Report ──

exports.deleteDailyReport = asyncHandler(async (req, res) => {
  const { dailyReports } = getSsdsCollections();
  let oid;
  try { oid = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'Invalid id' }); }

  const existing = await dailyReports.findOne({ _id: oid });
  if (!existing) return res.status(404).json({ error: 'Report not found' });
  if (!canAccessRecord(req, existing)) return res.status(403).json({ error: 'Forbidden' });

  await dailyReports.deleteOne({ _id: oid });
  res.json({ ok: true });
});

// ── Helpers ──

/** Pick the projectId for a new record: explicit body field > creator's first project. */
function resolveProjectIdForCreate(req) {
  const b = req.body;
  const userProjectIds = (req.user.projectIds || []).map(String);

  if (b.projectId) {
    if (req.user.role === 'admin') return b.projectId;
    if (userProjectIds.includes(b.projectId)) return b.projectId;
    return userProjectIds[0] || null;
  }
  if (req.user.role === 'admin') return null; // admin must pick explicitly
  return userProjectIds[0] || null;
}

/** Whether the requester can see/edit this record based on its projectId. */
function canAccessRecord(req, record) {
  if (req.user.role === 'admin') return true;
  if (!record.projectId) return false; // unassigned records: admin only
  const own = (req.user.projectIds || []).map(String);
  return own.includes(record.projectId);
}

/** Whether the requester can assign this projectId. */
function canAssignProject(req, projectId) {
  if (req.user.role === 'admin') return true;
  const own = (req.user.projectIds || []).map(String);
  return own.includes(projectId);
}

// ── Assign project to SSDS records ──
// PATCH /api/ssds/assign-project
// Body: { collection: 'drivers'|'timesheets'|'daily_reports'|'driver_maps'|'driver_history',
//         ids: [id1, id2, ...], projectId: '<projectId>' | null }
// Admin can assign any project. Manager can assign only their own projects.

const ASSIGNABLE_COLLECTIONS = ['drivers', 'timesheets', 'daily_reports', 'driver_maps', 'driver_history'];

exports.assignProject = asyncHandler(async (req, res) => {
  const { collection, ids, projectId } = req.body;
  if (!collection || !ASSIGNABLE_COLLECTIONS.includes(collection)) {
    return res.status(400).json({ error: `Invalid collection. Must be one of: ${ASSIGNABLE_COLLECTIONS.join(', ')}` });
  }
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }

  // Validate projectId
  if (projectId) {
    const project = await Project.findById(projectId);
    if (!project || !project.active) return res.status(400).json({ error: 'Project not found or inactive' });

    // Manager can only assign their own projects
    if (req.user.role !== 'admin') {
      const own = (req.user.projectIds || []).map(String);
      if (!own.includes(projectId)) return res.status(403).json({ error: 'You can only assign your own projects' });
    }
  }

  const cols = getSsdsCollections();
  const col = cols[collection === 'driver_history' ? 'driverHistory' : collection === 'daily_reports' ? 'dailyReports' : collection === 'driver_maps' ? 'driverMaps' : collection];
  const objectIds = ids.map((id) => {
    try { return new ObjectId(id); } catch { return null; }
  }).filter(Boolean);

  const update = projectId
    ? { $set: { projectId: projectId } }
    : { $unset: { projectId: '' } };

  const result = await col.updateMany({ _id: { $in: objectIds } }, update);
  res.json({ modified: result.modifiedCount });
});

// ══════════════════════════════════════════════════════════
// ══ DRIVER PORTAL — scoped by logged-in driver's email ══
// ══════════════════════════════════════════════════════════

// POST /api/ssds/my/ssds — driver creates a new SSD record (with optional image upload)
exports.createMySsds = asyncHandler(async (req, res) => {
  const { drivers: ssdCol } = getSsdsCollections();
  const userId = req.user._id.toString();
  const { ssdNumber, ssdStatus, comments } = req.body;

  if (!ssdNumber || !ssdNumber.trim()) return res.status(400).json({ error: 'SSD Number is required' });

  // Check if same SSD number already exists for this driver
  const existing = await ssdCol.findOne({ userId, 'SSD Number': ssdNumber.trim() });
  if (existing) return res.status(400).json({ error: 'You already have an SSD record with this number.' });

  const doc = {
    userId,
    'SSD Number': ssdNumber.trim(),
    'SSD Status': ssdStatus || '',
    comments: comments || '',
    'Last Updated': getISTDate(),
    createdAt: new Date(),
    createdBy: userId,
    createdByDriver: true,
  };

  // Store image: S3 key in production, local path in dev
  if (req.file) {
    if (isS3Configured() && req.file.buffer) {
      const s3Key = await uploadToS3(req.file.buffer, req.file.originalname, userId);
      doc.ssdImageUrl = '/api/ssds/image/' + encodeURIComponent(s3Key);
    } else if (req.file.filename) {
      doc.ssdImageUrl = '/uploads/ssd/' + req.file.filename;
    }
  }

  const result = await ssdCol.insertOne(doc);
  res.status(201).json({ _id: result.insertedId.toString(), ...doc });
});

// PATCH /api/ssds/my/ssds/:id — driver updates a specific SSD record's status & comments
exports.updateMySsds = asyncHandler(async (req, res) => {
  const { drivers: ssdCol } = getSsdsCollections();
  const userId = req.user._id.toString();
  const { ssdStatus, comments } = req.body;

  // Support both /my/ssds/:id and legacy /my/ssds (updates first record)
  let filter;
  if (req.params.id) {
    let oid;
    try { oid = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'Invalid id' }); }
    filter = { _id: oid, userId };
  } else {
    filter = { userId };
  }

  const updates = {};
  if (ssdStatus !== undefined) updates['SSD Status'] = ssdStatus;
  if (comments !== undefined) updates.comments = comments;
  updates['Last Updated'] = getISTDate();

  const result = await ssdCol.updateOne(filter, { $set: updates });
  if (!result.matchedCount) return res.status(404).json({ error: 'No SSD record found for your account' });
  res.json({ ok: true });
});

// GET /api/ssds/my/ssds — driver sees all their SSD records
exports.myDriverSsds = asyncHandler(async (req, res) => {
  const { drivers: ssdCol } = getSsdsCollections();
  const userId = req.user._id.toString();
  const ssdRecords = await ssdCol.find({ userId }).sort({ createdAt: -1 }).toArray();
  const u = req.user;

  const driverInfo = {
    name: u.name, email: u.email, driverId: u.driverId,
    country: u.country, project: u.project,
    scope: u.scope, region: u.region, drivingLocation: u.drivingLocation,
  };

  if (!ssdRecords.length) {
    return res.json({ driver: driverInfo, records: [] });
  }

  res.json({
    driver: driverInfo,
    records: ssdRecords.map(ssd => ({
      _id: ssd._id.toString(),
      ssdNumber: ssd['SSD Number'] || '',
      ssdStatus: ssd['SSD Status'] || '',
      ssdComments: ssd.comments || '',
      ssdImageUrl: ssd.ssdImageUrl || ssd.ssdImagePath || '',
      lastUpdated: ssd['Last Updated'] || '',
      createdAt: ssd.createdAt || '',
    })),
  });
});

// GET /api/ssds/my/timesheets — driver sees only their own timesheets
exports.myDriverTimesheets = asyncHandler(async (req, res) => {
  const { timesheets } = getSsdsCollections();
  const email = req.user.email;
  const { startDate, endDate } = req.query;

  let results = await timesheets.find({
    'Mail ID': { $regex: new RegExp(`^${escapeRegex(email)}$`, 'i') },
    Actions: { $not: /^\s*finalized\s*$/i },
  }).sort({ _id: -1 }).toArray();

  if (startDate || endDate) {
    results = results.filter(t => {
      const d = t['Last Updated'] ? String(t['Last Updated']).split(' ')[0] : '';
      if (startDate && d < startDate) return false;
      if (endDate && d > endDate) return false;
      return true;
    });
  }
  res.json({ timesheets: results.map(t => ({ ...t, _id: t._id.toString() })) });
});

// GET /api/ssds/my/daily-reports — driver sees only their own reports
exports.myDriverDailyReports = asyncHandler(async (req, res) => {
  const { dailyReports } = getSsdsCollections();
  const email = req.user.email;
  const reports = await dailyReports.find({
    driverEmail: { $regex: new RegExp(`^${escapeRegex(email)}$`, 'i') },
  }).sort({ submittedAt: -1 }).limit(100).toArray();
  res.json({ reports: reports.map(r => ({ ...r, _id: r._id.toString() })) });
});

// ── COR (Chain of Responsibility) ──
// Stores COR declarations per driver in a 'cor_declarations' collection.

// GET /api/ssds/my/cor — driver's own COR declarations
exports.myCor = asyncHandler(async (req, res) => {
  const { cor } = getSsdsCollections();
  const declarations = await cor.find({ driverEmail: req.user.email })
    .sort({ createdAt: -1 }).limit(100).toArray();
  res.json({ declarations: declarations.map(d => ({ ...d, _id: d._id.toString() })) });
});

// POST /api/ssds/my/cor — driver submits a COR declaration
exports.createCor = asyncHandler(async (req, res) => {
  const { cor } = getSsdsCollections();
  const b = req.body;
  if (!b.type) return res.status(400).json({ error: 'Declaration type is required' });

  const userProjectIds = (req.user.projectIds || []).map(String);
  const doc = {
    driverEmail: req.user.email,
    driverName: req.user.name,
    driverId: req.user._id.toString(),
    type: b.type, // 'fitness', 'pre_trip', 'fatigue', 'load', 'speed', 'general'
    date: b.date || getISTDate(),
    status: b.status || 'compliant',
    vehiclePlate: b.vehiclePlate || '',
    workStartTime: b.workStartTime || '',
    workEndTime: b.workEndTime || '',
    restHours: b.restHours || '',
    totalDrivingHours: b.totalDrivingHours || '',
    checklist: b.checklist || {}, // flexible key/value for different COR types
    notes: b.notes || '',
    projectId: userProjectIds[0] || null,
    createdAt: new Date(),
  };
  const result = await cor.insertOne(doc);
  res.status(201).json({ _id: result.insertedId.toString(), ...doc });
});

// GET /api/ssds/cor — admin/manager views all COR declarations (project-scoped)
exports.getAllCor = asyncHandler(async (req, res) => {
  const { cor } = getSsdsCollections();
  const pFilter = projectFilter(req);
  const { startDate, endDate, type } = req.query;
  const query = { ...pFilter };
  if (type) query.type = type;
  if (startDate || endDate) {
    query.date = {};
    if (startDate) query.date.$gte = startDate;
    if (endDate) query.date.$lte = endDate;
  }
  const declarations = await cor.find(query).sort({ createdAt: -1 }).limit(500).toArray();

  // Load project names
  const projectIds = [...new Set(declarations.map(d => d.projectId).filter(Boolean))];
  const projects = projectIds.length
    ? await Project.find({ _id: { $in: projectIds } }).select('name').lean()
    : [];
  const projectMap = {};
  projects.forEach(p => { projectMap[p._id.toString()] = p.name; });

  res.json({
    declarations: declarations.map(d => ({
      ...d,
      _id: d._id.toString(),
      projectName: d.projectId ? (projectMap[d.projectId] || null) : null,
    })),
  });
});

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Image proxy: streams S3 images through the API ──
// GET /api/ssds/image/:key — serves image from S3 without needing public bucket
exports.getImage = asyncHandler(async (req, res) => {
  if (!isS3Configured()) return res.status(404).json({ error: 'S3 not configured' });

  const key = decodeURIComponent(req.params.key);
  try {
    const { body, contentType } = await getFromS3(key);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    body.pipe(res);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'Image not found' });
    }
    throw err;
  }
});
