const User = require('../models/User');

// Drivers visible to a manager/team_lead: those explicitly linked to them (managerId /
// teamLeadId) PLUS everyone on any of their assigned projects. Project assignment alone must
// be enough — accounts are created "runs project X" without anyone then walking every driver
// to point its managerId/teamLeadId link back, and before this OR existed such a login saw an
// empty fleet despite the project being right there on their user document.
function linkedOrOnProjects(requester, linkField) {
  const or = [{ [linkField]: requester._id }];
  if (requester.projectIds && requester.projectIds.length) {
    or.push({ projectIds: { $in: requester.projectIds } });
  }
  return { role: 'user', $or: or };
}

// Returns a Mongo filter fragment (keyed on `driverId`) limiting a query to the
// drivers the requester is allowed to see:
//   admin     -> all drivers ({})
//   manager   -> drivers linked via managerId, or on any of the manager's projects
//   team_lead -> drivers linked via teamLeadId, or on any of the team lead's projects
//   user      -> only themselves
async function accessibleDriverFilter(requester) {
  if (requester.role === 'admin') return {};
  if (requester.role === 'manager' || requester.role === 'team_lead') {
    const linkField = requester.role === 'manager' ? 'managerId' : 'teamLeadId';
    const drivers = await User.find(linkedOrOnProjects(requester, linkField)).select('_id');
    return { driverId: { $in: drivers.map((d) => d._id) } };
  }
  return { driverId: requester._id };
}

// Whether the two accounts share at least one project. Compared as strings: either side can
// hold ObjectIds or populated {_id} docs depending on how the document was loaded.
function sharesProject(requester, driver) {
  const own = new Set((requester.projectIds || []).map((p) => String(p._id ?? p)));
  return (driver.projectIds || []).some((p) => own.has(String(p._id ?? p)));
}

// Whether `requester` may act on the driver document `driver`. Mirrors the visibility rule
// above: what a manager/team lead can see on their screens, they can also edit.
function canManageDriver(requester, driver) {
  if (requester.role === 'admin') return true;
  if (requester.role === 'manager') {
    if (driver.managerId && driver.managerId.toString() === requester._id.toString()) return true;
    if (driver.role === 'user' && sharesProject(requester, driver)) return true;
    // Manager can edit other managers/team_leads (Users tab)
    if (driver.role === 'manager' || driver.role === 'team_lead') return true;
    return false;
  }
  if (requester.role === 'team_lead') {
    if (driver.teamLeadId && driver.teamLeadId.toString() === requester._id.toString()) return true;
    if (driver.role === 'user' && sharesProject(requester, driver)) return true;
    // Team leads can also edit other team_leads/managers (Users tab)
    if (driver.role === 'manager' || driver.role === 'team_lead') return true;
    return false;
  }
  return requester._id.toString() === driver._id.toString();
}

module.exports = { accessibleDriverFilter, canManageDriver, linkedOrOnProjects };
