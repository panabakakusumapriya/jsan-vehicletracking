const User = require('../models/User');

// Returns a Mongo filter fragment (keyed on `driverId`) limiting a query to the
// drivers the requester is allowed to see:
//   admin   -> all drivers ({})
//   manager -> only drivers whose managerId is this manager
//   user    -> only themselves
async function accessibleDriverFilter(requester) {
  if (requester.role === 'admin') return {};
  if (requester.role === 'manager') {
    const drivers = await User.find({ managerId: requester._id, role: 'user' }).select('_id');
    return { driverId: { $in: drivers.map((d) => d._id) } };
  }
  return { driverId: requester._id };
}

// Whether `requester` may act on the driver document `driver`.
function canManageDriver(requester, driver) {
  if (requester.role === 'admin') return true;
  if (requester.role === 'manager') {
    return driver.managerId && driver.managerId.toString() === requester._id.toString();
  }
  return requester._id.toString() === driver._id.toString();
}

module.exports = { accessibleDriverFilter, canManageDriver };
