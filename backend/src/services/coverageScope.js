const Project = require('../models/Project');
const env = require('../config/env');

/**
 * Resolving a trip's coverage scope — the dedup universe its roads are compared against.
 *
 * The rule is deliberately boring: a project's own coverageScopeId if it has one, otherwise
 * env.UKM_DEFAULT_COVERAGE_SCOPE. Which means that out of the box every project, and every trip
 * with no project at all, lands in ONE scope and deduplicates against everything else.
 *
 * That default is the requirement, not a shortcut. The business rule being implemented is
 * literally "Driver 201 must not receive new credit under Project B for a road Driver 101 already
 * covered under Project A". Splitting scopes is what CREATES duplicate billable coverage, so it
 * has to be an explicit act on a specific project, never an accident of a project row being
 * created before the field existed.
 *
 * A trip with no projectId still gets the default scope rather than being quarantined. The
 * alternative — leaving those trips out of the ledger — would leave the roads they covered
 * unclaimed, so the next driver over the same street would be paid for coverage the fleet already
 * has. Under-claiming a driver is a payroll dispute; over-claiming a customer is an invoice
 * dispute, and the second one is worse.
 */

// Projects are a handful of rows that change roughly never, and this is asked once per trip during
// a scope replay of thousands of trips. Cached for the life of the process; the rebuild job and
// the map-match worker are both short-lived enough that a stale entry cannot outlive a deploy.
let cache = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

async function projectScopes() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const projects = await Project.find({}).select('_id coverageScopeId coverageCycleId').lean();
  cache = new Map(
    projects.map((p) => [
      String(p._id),
      {
        coverageScopeId: p.coverageScopeId || env.UKM_DEFAULT_COVERAGE_SCOPE,
        coverageCycleId: p.coverageCycleId || '',
      },
    ])
  );
  cachedAt = Date.now();
  return cache;
}

/** Drop the memo — called by tests and by the project update endpoint after a scope changes. */
function clearScopeCache() {
  cache = null;
  cachedAt = 0;
}

/** The scope/cycle a trip on `projectId` belongs to. projectId may be null. */
async function scopeForProject(projectId) {
  const fallback = { coverageScopeId: env.UKM_DEFAULT_COVERAGE_SCOPE, coverageCycleId: '' };
  if (!projectId) return fallback;
  const map = await projectScopes();
  return map.get(String(projectId)) || fallback;
}

/**
 * The scope a trip belongs to, preferring what was STAMPED on the trip.
 *
 * A stamped scope is history and outranks the project's current setting — that is the entire
 * reason the field is copied onto the trip rather than joined at read time. Only trips recorded
 * before the field existed fall through to their project's scope, and that is a migration, not a
 * lookup: services/../seed/backfillGlobalUkm.js writes the resolved value onto them so the
 * fallback stops being needed.
 */
async function scopeForTrip(trip) {
  if (trip.coverageScopeId) {
    return { coverageScopeId: trip.coverageScopeId, coverageCycleId: trip.coverageCycleId || '' };
  }
  return scopeForProject(trip.projectId);
}

module.exports = { scopeForProject, scopeForTrip, clearScopeCache };
