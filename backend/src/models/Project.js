const mongoose = require('mongoose');

/**
 * A project is the tenancy boundary managers and team leads operate inside. Admins created
 * projects here rather than everyone typing a free-text label, so "which project is this
 * driver on" is an actual lookup instead of a string that drifts (typos, casing, duplicates).
 */
const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    code: { type: String, trim: true, default: null },
    country: { type: String, trim: true, default: null },
    active: { type: Boolean, default: true },

    // Which mobile app tabs are enabled for this project's drivers.
    enabledModules: {
      type: [String],
      default: ['dashboard', 'map'],
    },

    /**
     * Whether the driver may sign themselves out of the mobile app.
     *
     * Deliberately a boolean of its own rather than another member of `enabledModules`, even
     * though the admin UI presents them side by side. `enabledModules` is a list where presence
     * means enabled, and every project row already in the database literally holds
     * ['dashboard', 'map'] — so shipping 'logout' as a list member would silently remove the
     * button from every existing project the moment this deployed, and would need a data
     * migration to put back. A boolean defaulting to true keeps today's behaviour for every
     * project that has never been asked the question.
     *
     * NOTE for readers: because auth.controller reads this with .lean(), which does NOT apply
     * Mongoose defaults, it must be interpreted as `!== false` rather than truthiness — a
     * document saved before this field existed returns undefined, and undefined means "show it".
     */
    showLogout: { type: Boolean, default: true },

    /**
     * How long a vehicle may sit still before the handset ends the trip, in minutes.
     *
     * Null means "use the app's own default" (TrackingService.TRIP_END_NO_MOVE_MS, 10 min), and
     * that is what every project predating this field reads as — the same `.lean()` trap
     * documented on showLogout above applies, so readers must test `typeof x === 'number'`
     * rather than `x || DEFAULT`, or a project that deliberately set 3 would be indistinguishable
     * from one that never set anything.
     *
     * Per project because the right answer is the work, not the software: a survey crew that
     * parks at every site wants the trip closed three minutes after they stop, while a delivery
     * round crawling through signals wants the long buffer that keeps one drive as one trip.
     * Bounds are enforced in the controller AND clamped again on the device, so a bad value
     * cannot strand a handset in a state where trips never end.
     */
    tripEndAfterMinutes: { type: Number, default: null, min: 2, max: 30 },

    // Which dedup universe this project's coverage belongs to. Projects sharing a scope share one
    // history: a road first driven under Project A is not new road again under Project B. That is
    // the whole point — the customer is not billed twice because the street sat on a boundary
    // between two of our internal projects.
    //
    // Null means "use env.UKM_DEFAULT_COVERAGE_SCOPE", which puts every project in one universe.
    // That is the intended default, not a placeholder: separating scopes is the exception, and it
    // has to be a deliberate act because it CREATES billable duplicate coverage by definition.
    coverageScopeId: { type: String, trim: true, default: null },

    // Optional reset handle inside a scope. A new cycle ("2027 refresh") starts uniqueness from
    // scratch without touching the previous cycle's ledger, so last year's numbers stay
    // reproducible while this year's crew is paid for driving the same streets again. Null means
    // one continuous cycle, which is the current business rule: previous months and years count
    // as history.
    coverageCycleId: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Project', projectSchema);
