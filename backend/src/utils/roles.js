/**
 * The admin tier. 'superadmin' is an admin who may also create and manage other admins; in every
 * other respect the two are the same, so a permission check that says "admin" means both.
 *
 * Use isAdmin() rather than comparing role strings: the one comparison that must NOT treat them
 * alike — who may create or change an admin account — is in user.controller.js, and is explicit.
 */
const ADMIN_ROLES = ['superadmin', 'admin'];

const isAdmin = (user) => Boolean(user && ADMIN_ROLES.includes(user.role));
const isSuperadmin = (user) => Boolean(user && user.role === 'superadmin');

module.exports = { ADMIN_ROLES, isAdmin, isSuperadmin };
