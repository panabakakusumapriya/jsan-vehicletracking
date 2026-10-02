package expo.modules.vehicletracker

/**
 * Decides when an idle phone has really DEPARTED, and so when a trip may start.
 *
 * Why it exists
 * -------------
 * Field case (trip 6abe7d98, hyd-test2, 2026-10-01): a driver logged in and never moved, and a
 * trip started. The phone's GPS position was jumping 31-38 m around a desk while reporting 4-12 m
 * accuracy. The old gates measured tens of metres (20 / 30 / 100 m) from a watch anchor, so the
 * noise itself was big enough to pass them — and every witness that was meant to hold them shut
 * can be fooled by the same noise:
 *
 *  - "the accelerometer sees nothing walking" is true of a phone lying on a desk;
 *  - MotionClassifier's "covering ground with no gait under it" rule reads a wandering fix on a
 *    still phone as a creeping VEHICLE, because its ground speed is computed from those fixes;
 *  - a position jump comes with its own speed spike (one fix read 24.7 km/h on that desk).
 *
 * So no witness is trusted to say "this small movement is real". Distance is.
 *
 * The rule
 * --------
 * The phone rests at an ANCHOR: where the last trip ended, or where the service first saw it —
 * settled on the median of the first SETTLE_FIXES fixes when those form a cluster, so one bad
 * fix cannot put it in the wrong place. Around it is a circle of START_RADIUS_M. Nothing that happens inside the circle
 * can start a trip, whatever the speed readings, the sensors or Play Services say. That is the
 * hard guarantee: GPS error that stays within 150 m of the anchor is excluded by construction,
 * not by a judgement that could be wrong.
 *
 * A trip starts only when all of this holds:
 *
 *  1. EXIT. EXIT_CONFIRM_FIXES good fixes in a row are outside the circle, spanning at least
 *     EXIT_CONFIRM_MS, each within MAX_STEP_MPS of the one before. One or two wild fixes — the
 *     usual multipath outlier — are not an exit, and neither are three that land in three
 *     different places: a vehicle's fixes form a path it could have driven.
 *
 *  2. CORROBORATION — the exit looks like travel, not like the position being relocated:
 *       - DOPPLER: MOVING_STREAK_MIN consecutive fixes whose own speed reading is MOVING_KMH or
 *         more. A jump brings one spike; driving brings an unbroken run.
 *       - PROGRESS: the position stepped outward, RING_PROGRESS_MIN new-furthest fixes inside
 *         the ring between DEPART_RADIUS_M and the circle (or PROGRESS_MIN overall), each within
 *         PROGRESS_STALL_MS of the last and without falling back for longer than
 *         FALLBACK_GRACE_MS. A jump from the middle to outside has no fixes in between; wander
 *         that drifts out over an hour is not a run; a crawl interrupted by one bad fix still is.
 *     A handset that reports a speed and reports it as zero CONTRADICTS a fast exit, so the fast
 *     gate takes progress in place of Doppler only on handsets that report no speed at all. A
 *     crawl has no Doppler to show (receivers read zero below ~2-3 km/h), so the slow and
 *     vehicle gates accept either.
 *
 *  3. A GATE — the same three questions as before, now asked only after 1 and 2. Speed is
 *     measured from the last fix AT REST to here: a baseline of 100 m or more, because over the
 *     few seconds of the exit itself GPS noise alone reads as 10 km/h and let walkers through.
 *       FAST     averaged FAST_MIN_KMH since leaving rest, and nothing says "running on foot".
 *       SLOW     a crawl of SLOW_MIN_KMH with a live vehicle verdict and no recent foot verdict.
 *       VEHICLE  the sensors say vehicle and the phone is moving at all — 1 km/h of creep counts.
 *
 * Nothing driven is lost to the radius: the service keeps a pre-start buffer and flushes the
 * departure into the trip, so the recorded route still begins where the vehicle did, not 150 m
 * later — and WHEN it did: routeOrigin() names the last fix the phone was seen standing at,
 * which opens the route and dates the trip.
 *
 * When the exit is not a trip
 * ---------------------------
 * A driver walking to the vehicle also leaves the circle. No gate passes on foot, so after
 * EXIT_PENDING_MS outside the anchor simply moves to where the phone is now (REANCHOR) and the
 * circle follows the walker. The same thing heals a position that relocated and stayed.
 *
 * This class is pure — no Android, no clock, no storage — so __sim__/start-gate.mjs can mirror it
 * line for line and __sim__/start-gate.sim.mjs can drive it through thousands of simulated
 * hours. Change one, change the other, run the sim.
 */
internal class StartGate {

    companion object {
        /** Nothing inside this distance of the rest anchor can start a trip. */
        const val START_RADIUS_M = 150.0
        /** Within this of the anchor the phone is "at rest": departure bookkeeping starts over. */
        const val DEPART_RADIUS_M = 50.0

        /** A new anchor is re-centred on the median of its first fixes... */
        const val SETTLE_FIXES = 5
        /**
         * ...but only if this many of them sit within DEPART_RADIUS_M of that median — a phone
         * at rest. Fixes strung out along a road are a vehicle already under way (the service
         * restarted mid-drive): the median would be a point down the road, and the route would
         * then begin there instead of where the first fix was.
         */
        const val SETTLE_QUORUM = 3

        /** Consecutive good fixes outside the circle, over at least this long, make an exit. */
        const val EXIT_CONFIRM_FIXES = 3
        const val EXIT_CONFIRM_MS = 3_000L
        /** Outside this long with no gate passing: not a trip. The anchor moves here. */
        const val EXIT_PENDING_MS = 120_000L
        /**
         * The confirming fixes must be reachable from one another: 70 m/s is 252 km/h. Wild
         * fixes are thrown in unrelated directions, hundreds of metres apart seconds apart;
         * simulation found three in a row, each with a speed spike, starting a trip on a parked
         * phone once in 9 000 hours. A step no vehicle could make restarts the count.
         */
        const val MAX_STEP_MPS = 70.0

        /** A fix this much further out than any before it is a step of outward progress. */
        const val PROGRESS_STEP_M = 15.0
        /** Falling back this far from the furthest point voids the progress so far (wander)... */
        const val PROGRESS_RETREAT_M = 30.0
        /**
         * ...but only once it has lasted this long. A real crawl's fixes jump too, and a single
         * fix thrown 40 m back used to wipe the run: the trip then started a whole circle later,
         * with the first 200 m of road missing. A blip is over in seconds; wander is not.
         */
        const val FALLBACK_GRACE_MS = 90_000L
        /**
         * So does this long without a further step. Five minutes, not three: one fix thrown 40 m
         * AHEAD of a 1 km/h creep sets a "furthest" the vehicle itself needs over three minutes
         * to pass, and at three the run was voided — the trip then started a circle late.
         */
        const val PROGRESS_STALL_MS = 300_000L
        const val RING_PROGRESS_MIN = 3
        const val PROGRESS_MIN = 6

        /** The receiver's own speed reading at or above this is a "moving" fix. */
        const val MOVING_KMH = 5.0
        /**
         * This many moving fixes IN A ROW corroborate an exit. Four, because phantom speed
         * readings on a parked phone come singly or with a jump; a relocating position plus two
         * stray spikes made three often enough to show up in simulation.
         */
        const val MOVING_STREAK_MIN = 4
        /** ...and keep doing so for this long, so a stop at the first junction does not undo it. */
        const val DOPPLER_OK_HOLD_MS = 30_000L

        const val FAST_MIN_KMH = 10.0
        const val FAST_CERTAIN_KMH = 20.0
        const val SLOW_MIN_KMH = 2.0
        const val VEHICLE_MIN_KMH = 0.8
        const val VEHICLE_MAX_ACCURACY_M = 25.0

        /**
         * routeOrigin: where a trip's route begins, and with it the trip's start time.
         *
         * The last fix seen within CORE_RADIUS_M of the anchor is the vehicle standing where it
         * rested — unless it then lingered between there and DEPART_RADIUS_M for longer than
         * CORE_ORIGIN_MAX_GAP_MS (an anchor off-centre from where the phone really sits), in
         * which case the last fix AT REST is the better origin: fresher, at the cost of up to
         * 50 m of a very slow creep. Chosen by time, never by scanning the buffer for a shape:
         * an earlier rule took "the last buffered fix near the anchor", which after a still
         * half-hour could be a jitter fix from the start of it — and the trip then began 30 min
         * before the vehicle moved.
         */
        const val CORE_RADIUS_M = 20.0
        const val CORE_ORIGIN_MAX_GAP_MS = 180_000L
        /**
         * An origin fix is written into the route only if the next route point follows within
         * this long. Otherwise it is a position from before a silence (hours in a garage with
         * no usable fix) and would date the trip to before the silence.
         */
        const val ORIGIN_MAX_GAP_MS = 90_000L
        /**
         * A long stay somewhere ELSE inside the circle — walked 80 m to the vehicle and sat in
         * it — moves the origin there: RING_DWELL_MS within RING_STAY_RADIUS_M of one spot,
         * forgiving up to RING_STAY_MISSES - 1 stray fixes in a row. The anchor itself does not
         * move (re-centring it on wherever the position lingers was tried in simulation, and
         * more than doubled phantom starts under heavy GPS error).
         */
        const val RING_STAY_RADIUS_M = 30.0
        const val RING_STAY_MISSES = 3
        const val RING_DWELL_MS = 300_000L
    }

    /** Where and when a trip's route begins. Not a route point itself unless [isRoutePoint]. */
    class Origin(
        val lat: Double,
        val lon: Double,
        val elapsedMs: Long,
        val timeMs: Long,
        val isRoutePoint: Boolean,
    )

    enum class Decision { NONE, START_FAST, START_SLOW, START_VEHICLE, REANCHOR }

    /** False until the first fix (or a trip end) gives the phone somewhere to rest. */
    var hasAnchor: Boolean = false
        private set
    /** True while the phone is confirmed outside the circle and no gate has passed yet. */
    var exitConfirmed: Boolean = false
        private set
    /** True when the last fix showed outward progress or sat outside: sample GPS fast. */
    var wantsFastGps: Boolean = false
        private set
    /** Distance of the last fix from the anchor, metres. */
    var lastDistM: Double = 0.0
        private set

    /**
     * The last fix seen AT REST (within DEPART_RADIUS_M of the anchor): where it was, when on the
     * elapsed clock, and its wall-clock time. Exit speed is measured from it, and the route may
     * begin at it — see routeOrigin().
     */
    private var restLat = 0.0
    private var restLon = 0.0
    private var restElapsedMs = 0L
    private var restTimeMs = 0L

    /** The last fix seen within CORE_RADIUS_M of the anchor. */
    private var coreLat = 0.0
    private var coreLon = 0.0
    private var coreElapsedMs = 0L
    private var coreTimeMs = 0L

    /** The spot in the ring the phone is staying at, and the last fix of a long stay there. */
    private var hasStay = false
    private var stayLat = 0.0
    private var stayLon = 0.0
    private var staySinceMs = 0L
    private var stayMisses = 0
    private var hasRingRest = false
    private var ringRestLat = 0.0
    private var ringRestLon = 0.0
    private var ringRestElapsedMs = 0L
    private var ringRestTimeMs = 0L

    private var anchorLat = 0.0
    private var anchorLon = 0.0

    /** The first fixes after a new anchor, for its median. settleCount 0 = settled. */
    private val settleLat = DoubleArray(SETTLE_FIXES)
    private val settleLon = DoubleArray(SETTLE_FIXES)
    private var settleCount = 0

    private var outsideCount = 0
    private var firstOutsideMs = 0L
    /** The previous fix outside the circle — see MAX_STEP_MPS. */
    private var lastOutsideLat = 0.0
    private var lastOutsideLon = 0.0
    private var lastOutsideMs = 0L

    /** Furthest the phone has been from the anchor in the current outward run. */
    private var maxDistM = 0.0
    private var progressFixes = 0
    private var ringProgress = 0
    private var lastProgressMs = 0L
    /** When the current run started falling back, 0 if it is not — see FALLBACK_GRACE_MS. */
    private var fallbackSinceMs = 0L

    /** A property of the handset, not of one departure: it reports a speed at all. */
    private var dopplerEverSeen = false
    private var movingStreak = 0
    private var dopplerOkUntilMs = 0L

    /** Forget the anchor — a trip is running, or the service is starting cold. */
    fun clear() {
        hasAnchor = false
        exitConfirmed = false
        wantsFastGps = false
        lastDistM = 0.0
        settleCount = 0
        outsideCount = 0
        firstOutsideMs = 0L
        maxDistM = 0.0
        progressFixes = 0
        ringProgress = 0
        lastProgressMs = 0L
        fallbackSinceMs = 0L
        movingStreak = 0
        dopplerOkUntilMs = 0L
        hasStay = false
        stayMisses = 0
        hasRingRest = false
    }

    /** The phone rests HERE now: a trip just ended here, or this is the first fix, or a re-anchor. */
    fun anchorAt(lat: Double, lon: Double, now: Long, timeMs: Long) {
        clear()
        hasAnchor = true
        anchorLat = lat
        anchorLon = lon
        restLat = lat
        restLon = lon
        restElapsedMs = now
        restTimeMs = timeMs
        coreLat = lat
        coreLon = lon
        coreElapsedMs = now
        coreTimeMs = timeMs
        settleLat[0] = lat
        settleLon[0] = lon
        settleCount = 1
    }

    /**
     * Where the route of a trip starting NOW begins — see CORE_RADIUS_M. Buffered fixes later
     * than the origin are the departure; the origin itself opens the route when it immediately
     * precedes them.
     *
     * @param bufferElapsedMs the pre-start buffer's fix times (elapsed clock), oldest first.
     */
    fun routeOrigin(bufferElapsedMs: LongArray, now: Long): Origin {
        fun fresh(originMs: Long): Boolean {
            var next = now
            for (t in bufferElapsedMs) if (t > originMs && t < now) { next = t; break }
            return originMs < now && next - originMs <= ORIGIN_MAX_GAP_MS
        }
        if (hasRingRest) {
            return Origin(ringRestLat, ringRestLon, ringRestElapsedMs, ringRestTimeMs, fresh(ringRestElapsedMs))
        }
        if (restElapsedMs - coreElapsedMs <= CORE_ORIGIN_MAX_GAP_MS && fresh(coreElapsedMs)) {
            return Origin(coreLat, coreLon, coreElapsedMs, coreTimeMs, true)
        }
        return Origin(restLat, restLon, restElapsedMs, restTimeMs, fresh(restElapsedMs))
    }

    /**
     * One good idle fix (the caller has already dropped fixes too inaccurate to judge by).
     *
     * @param timeMs     the fix's wall-clock time, kept only to timestamp the rest fix.
     * @param dopplerKmh the receiver's own speed reading, null when it reports none — never a
     *        speed derived from positions, which would move with the very jumps this guards against.
     * @param recentKmh  how fast the phone is moving right now by any measure (vehicle gate only).
     */
    fun onFix(
        now: Long,
        timeMs: Long,
        lat: Double,
        lon: Double,
        accuracyM: Double,
        dopplerKmh: Double?,
        recentKmh: Double,
        vehicleConfirmed: Boolean,
        activitySaysVehicle: Boolean,
        footRecently: Boolean,
        gaitUsable: Boolean,
        runningOnFoot: Boolean,
    ): Decision {
        wantsFastGps = false
        if (!hasAnchor) {
            anchorAt(lat, lon, now, timeMs)
            tallyDoppler(now, dopplerKmh)
            return Decision.NONE
        }

        // ── Settle: a new anchor is one fix, and one fix can be wrong ───────
        // Re-centre on the median of the first SETTLE_FIXES. A phone at rest lands in the
        // middle of its own jitter; a bad first fix is outvoted; a vehicle already under way
        // has no cluster to settle on and keeps the first fix (see SETTLE_QUORUM).
        var justSettled = false
        if (settleCount > 0) {
            settleLat[settleCount] = lat
            settleLon[settleCount] = lon
            settleCount++
            if (settleCount == SETTLE_FIXES) {
                val midLat = median(settleLat)
                val midLon = median(settleLon)
                var near = 0
                for (i in 0 until SETTLE_FIXES) {
                    if (haversine(midLat, midLon, settleLat[i], settleLon[i]) < DEPART_RADIUS_M) near++
                }
                settleCount = 0
                if (near >= SETTLE_QUORUM) {
                    anchorLat = midLat
                    anchorLon = midLon
                    justSettled = true
                }
            }
        }

        val d = haversine(anchorLat, anchorLon, lat, lon)
        lastDistM = d
        if (justSettled) {
            // Everything measured from the provisional anchor starts over from the settled one.
            outsideCount = 0
            firstOutsideMs = 0L
            exitConfirmed = false
            maxDistM = d
            progressFixes = 0
            ringProgress = 0
        }

        tallyDoppler(now, dopplerKmh)

        // ── A run that suddenly falls back: a blip, or over? ────────────────
        // Held as it stands for FALLBACK_GRACE_MS — this fix counts neither for nor against it.
        val fellBack = progressFixes > 0 && d < START_RADIUS_M &&
            (d < DEPART_RADIUS_M || d <= maxDistM - PROGRESS_RETREAT_M)
        if (fellBack) {
            if (fallbackSinceMs == 0L) fallbackSinceMs = now
            if (now - fallbackSinceMs <= FALLBACK_GRACE_MS) {
                outsideCount = 0
                firstOutsideMs = 0L
                exitConfirmed = false
                return Decision.NONE
            }
        }
        fallbackSinceMs = 0L

        // ── At rest: any departure in progress is over ──────────────────────
        if (d < DEPART_RADIUS_M) {
            restLat = lat
            restLon = lon
            restElapsedMs = now
            restTimeMs = timeMs
            if (d < CORE_RADIUS_M) {
                coreLat = lat
                coreLon = lon
                coreElapsedMs = now
                coreTimeMs = timeMs
            }
            hasStay = false
            stayMisses = 0
            hasRingRest = false
            outsideCount = 0
            firstOutsideMs = 0L
            exitConfirmed = false
            maxDistM = d
            progressFixes = 0
            ringProgress = 0
            return Decision.NONE
        }

        // ── Outward progress: stepping away, or wandering? ──────────────────
        if (progressFixes > 0 && now - lastProgressMs > PROGRESS_STALL_MS) {
            maxDistM = d
            progressFixes = 0
            ringProgress = 0
        }
        if (d <= maxDistM - PROGRESS_RETREAT_M) {
            maxDistM = d
            progressFixes = 0
            ringProgress = 0
        } else if (d >= maxDistM + PROGRESS_STEP_M) {
            maxDistM = d
            progressFixes++
            if (d < START_RADIUS_M) ringProgress++
            lastProgressMs = now
            wantsFastGps = true
        }

        // ── In the ring: left the rest spot, still inside the circle ────────
        if (d < START_RADIUS_M) {
            outsideCount = 0
            firstOutsideMs = 0L
            exitConfirmed = false
            // A long stay in one spot of the ring (walked to the vehicle, sat in it): the route
            // of whatever leaves next begins at the end of that stay. The anchor does not move.
            if (hasStay && haversine(stayLat, stayLon, lat, lon) <= RING_STAY_RADIUS_M) {
                stayMisses = 0
                if (now - staySinceMs >= RING_DWELL_MS) {
                    hasRingRest = true
                    ringRestLat = lat
                    ringRestLon = lon
                    ringRestElapsedMs = now
                    ringRestTimeMs = timeMs
                }
            } else if (!hasStay || ++stayMisses >= RING_STAY_MISSES) {
                // Several fixes in a row away from the spot: it has moved on (one stray fix has not).
                hasStay = true
                stayLat = lat
                stayLon = lon
                staySinceMs = now
                stayMisses = 0
            }
            return Decision.NONE
        }

        // ── Outside the circle ──────────────────────────────────────────────
        wantsFastGps = true
        if (outsideCount > 0) {
            val stepSec = ((now - lastOutsideMs) / 1000.0).coerceAtLeast(1.0)
            if (haversine(lastOutsideLat, lastOutsideLon, lat, lon) / stepSec > MAX_STEP_MPS) {
                outsideCount = 0
                exitConfirmed = false
            }
        }
        if (outsideCount == 0) firstOutsideMs = now
        outsideCount++
        lastOutsideLat = lat
        lastOutsideLon = lon
        lastOutsideMs = now
        if (outsideCount < EXIT_CONFIRM_FIXES || now - firstOutsideMs < EXIT_CONFIRM_MS) {
            return Decision.NONE
        }
        exitConfirmed = true

        // Speed since the phone was last at rest: a baseline of 100 m or more.
        val legSec = ((now - restElapsedMs) / 1000.0).coerceAtLeast(0.1)
        val legKmh = (haversine(restLat, restLon, lat, lon) / legSec) * 3.6

        val dopplerOk = now <= dopplerOkUntilMs
        val progressOk = ringProgress >= RING_PROGRESS_MIN || progressFixes >= PROGRESS_MIN
        val fastCorroborated = dopplerOk || (!dopplerEverSeen && progressOk)
        val crawlCorroborated = dopplerOk || progressOk

        val fast = legKmh >= FAST_MIN_KMH && fastCorroborated &&
            (vehicleConfirmed || legKmh >= FAST_CERTAIN_KMH || (gaitUsable && !runningOnFoot))
        val slow = legKmh >= SLOW_MIN_KMH && crawlCorroborated && !footRecently &&
            (vehicleConfirmed || activitySaysVehicle)
        val vehicle = vehicleConfirmed && crawlCorroborated &&
            accuracyM <= VEHICLE_MAX_ACCURACY_M && recentKmh >= VEHICLE_MIN_KMH

        if (fast) return Decision.START_FAST
        if (slow) return Decision.START_SLOW
        if (vehicle) return Decision.START_VEHICLE

        // Outside, sustained, and still not a trip: a walk, or the position relocating. The
        // circle moves to where the phone is and the question starts again from here.
        if (now - firstOutsideMs >= EXIT_PENDING_MS) {
            anchorAt(lat, lon, now, timeMs)
            return Decision.REANCHOR
        }
        return Decision.NONE
    }

    private fun tallyDoppler(now: Long, dopplerKmh: Double?) {
        if (dopplerKmh == null) return
        dopplerEverSeen = true
        if (dopplerKmh >= MOVING_KMH) {
            movingStreak++
            if (movingStreak >= MOVING_STREAK_MIN) dopplerOkUntilMs = now + DOPPLER_OK_HOLD_MS
        } else {
            movingStreak = 0
        }
    }

    private fun median(values: DoubleArray): Double {
        val sorted = values.sortedArray()
        return sorted[sorted.size / 2]
    }

    private fun haversine(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val r = 6371000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val sLat = Math.sin(dLat / 2)
        val sLon = Math.sin(dLon / 2)
        val a = sLat * sLat +
            Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * sLon * sLon
        return 2 * r * Math.asin(Math.sqrt(a).coerceAtMost(1.0))
    }
}
