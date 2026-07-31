const User = require('../models/User');

// Returns a Mongo filter fragment (keyed on `driverId`) limiting a query to the
// drivers the requester is allowed to see:
//   admin   -> all drivers ({})
//   manager -> only drivers whose managerId is this manager
//   user    -> only themselves
async function accessibleDriverFilter(requester) {
  if (requester.role === 'admin') return {};
  if (requester.role === 'manager') {
    // Manager sees all drivers assigned to them (including those delegated to team leads)
    const drivers = await User.find({ managerId: requester._id, role: 'user' }).select('_id');
    return { driverId: { $in: drivers.map((d) => d._id) } };
  }
  if (requester.role === 'team_lead') {
    // Team lead sees only drivers specifically assigned to them
    const drivers = await User.find({ teamLeadId: requester._id, role: 'user' }).select('_id');
    return { driverId: { $in: drivers.map((d) => d._id) } };
  }
  return { driverId: requester._id };
}

// Whether `requester` may act on the driver document `driver`.
function canManageDriver(requester, driver) {
  if (requester.role === 'admin') return true;
  if (requester.role === 'manager') {
    // Manager can edit their own drivers
    if (driver.managerId && driver.managerId.toString() === requester._id.toString()) return true;
    // Manager can edit other managers/team_leads (Users tab)
    if (driver.role === 'manager' || driver.role === 'team_lead') return true;
    return false;
  }
  if (requester.role === 'team_lead') {
    // Team lead can only edit drivers assigned to them via teamLeadId
    if (driver.teamLeadId && driver.teamLeadId.toString() === requester._id.toString()) return true;
    // Team leads can also edit other team_leads/managers (Users tab)
    if (driver.role === 'manager' || driver.role === 'team_lead') return true;
    return false;
  }
  return requester._id.toString() === driver._id.toString();
}

module.exports = { accessibleDriverFilter, canManageDriver };
