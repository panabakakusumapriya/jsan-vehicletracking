package expo.modules.vehicletracker

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Answers one question: is this phone RIDING IN A VEHICLE, or being CARRIED ON FOOT?
 *
 * Why it exists
 * -------------
 * The trip-start gate used road speed as a stand-in for "this is a vehicle": 30 m at an average
 * of 10 km/h (TRIP_START_MIN_SPEED_KMH). That proxy is wrong in exactly the case this fleet
 * drives in. A survey crawl, a queue at a gate, a site road, a jam — none of them average
 * 10 km/h over any 30 m stretch, so the trip did not start until traffic freed up, and every
 * metre before that was billable driving thrown away. The slow gate added later (100 m at
 * 2 km/h) helped, but it is still speed-shaped: below 2 km/h it can never open, and it is held
 * shut for ten minutes by FOOT_VETO_MS — which fires on essentially every drive, because the
 * driver walks to the vehicle immediately before getting in.
 *
 * The fix is to stop inferring the vehicle from the speed and to measure it directly. Once the
 * phone is KNOWN to be in a vehicle, a trip can start on almost any movement at all — 1 km/h of
 * creep is a trip if you are sitting in a car, and is nothing if you are on your feet.
 *
 * How it decides
 * --------------
 * Six independent witnesses, none trusted alone, integrated over several seconds:
 *
 *  1. Accelerometer cadence. Walking is a metronome: 1.1-2.4 steps/s, running 2.4-3.6, each step
 *     a sharp impact. The classifier counts rising crossings of the acceleration magnitude and
 *     measures their SPACING. Road vibration also shakes the phone, sometimes harder than
 *     walking does, but it does not keep time — so the spacing test, not the amplitude, is what
 *     separates them (GAIT_MAX_INTERVAL_CV).
 *  2. Accelerometer amplitude. A footfall carries far more energy than a suspension; below
 *     GAIT_MIN_STD there is no gait to speak of.
 *  3. Gyroscope. A phone in a pocket or a hand swings through whole radians per second while
 *     walking. A phone in a cradle, a cupholder, or a seated passenger's pocket barely rotates
 *     between turns. Weak evidence on its own, so it only ever nudges.
 *  4. GPS speed. Nobody sustains SPEED_CERTAIN_VEHICLE_KMH on foot. This is the one witness that
 *     can decide on its own.
 *  5. Play Services activity recognition (IN_VEHICLE / ON_BICYCLE / ON_FOOT / WALKING / RUNNING)
 *     WITH ITS CONFIDENCE, sampled continuously rather than only on transitions. Google's model
 *     is good but slow, and often silent during a slow crawl, so it votes rather than rules.
 *  6. Translation without gait. The load-bearing rule for this fleet's actual problem: the phone
 *     is covering real ground, and there is no gait under it. A human cannot move over the
 *     ground without a gait; a passenger can. This is what recognises a 1 km/h creep that both
 *     every speed threshold and Google's own model read as "parked".
 *
 * Each evaluation adds evidence to a running score capped at SCORE_CAP, so a verdict needs
 * several consistent seconds and one contrary spike cannot flip it — the "context over time"
 * that keeps a pothole from ending a trip and a bus-stop shuffle from starting one.
 *
 * Threading: every sensor callback and every feed from the service arrives on the main looper
 * (the service registers its location callback there too), so no synchronisation is needed.
 * Cost: the accelerometer at SAMPLE_PERIOD_US is roughly two orders of magnitude cheaper than
 * the GPS this service already holds open, and it is only registered while the service runs.
 */
class MotionClassifier(private val ctx: Context) : SensorEventListener {

    enum class Verdict { UNKNOWN, VEHICLE, FOOT }
    enum class Gait { NONE, WALK, RUN }

    companion object {
        /** 25 Hz. Gait tops out near 3.6 Hz, so this leaves ~7 samples per step to time. */
        private const val SAMPLE_PERIOD_US = 40_000

        /** Analysis window. Long enough to hold ~6-20 steps, short enough to react in seconds. */
        private const val WINDOW_MS = 6_000L
        private const val MAX_SAMPLES = 200
        private const val MAX_PEAKS = 64

        /** How often the witnesses are polled and the score updated. */
        private const val EVAL_INTERVAL_MS = 1_000L

        /**
         * Sensor batching latency, in microseconds.
         *
         * Without it the sensor hub hands over every sample the instant it is taken, so a 25 Hz
         * accelerometer wakes the application processor 25 times a second, forever, and keeps the
         * SoC out of its deep idle states. For a service that now never stops, that is an all-day
         * battery cost paid mostly while parked. With a latency the hub buffers into its own
         * low-power FIFO and wakes the AP once per window instead — the same samples, two orders
         * of magnitude fewer wakeups.
         *
         * The price is that a verdict can be up to one window old, which is why only the dormant
         * watch takes the long one. Devices without a hardware FIFO ignore the hint and deliver
         * as before, so this is an optimisation and never a dependency.
         */
        private const val BATCH_LATENCY_ACTIVE_US = 1_000_000
        private const val BATCH_LATENCY_DORMANT_US = 5_000_000

        // ── Gait signature ────────────────────────────────────────────────────
        /**
         * Cutoff of the two-pole low-pass the gait detector runs on, in Hz.
         *
         * Without it the detector is worse than useless in a vehicle. Counting threshold
         * crossings on the raw signal ALIASES: PEAK_REFRACTORY_MS caps detection at ~4.5 Hz, so
         * a 12 Hz vibration does not read as 12 Hz, it reads as an evenly-spaced 3-4 Hz train —
         * squarely in the gait band, with a LOW interval CV because the refractory itself
         * imposed the spacing. A swept simulation of road vibration (see
         * __sim__/motion-classifier.sim.mjs) classified 29 of 42 surfaces as a gait before this
         * filter, some of them as RUN.
         *
         * Walking lives at 1-2.5 Hz and running at 2.4-3.6, so nothing above ~3.5 Hz is evidence
         * of a gait and all of it is evidence of a road. At this cutoff a two-pole filter keeps
         * ~79% of a walking fundamental and ~19% of a 7 Hz vibration.
         */
        private const val LOWPASS_HZ = 3.5

        /**
         * Below this there is no gait, whatever else is true (m/s^2) — measured on the
         * LOW-PASSED signal, so it is a bar on gait-band energy specifically, not on how much
         * the phone is being shaken in total.
         */
        private const val GAIT_MIN_STD = 0.45f
        /** Violent shaking is not locomotion — a phone rattling loose in a door bin. */
        private const val GAIT_MAX_STD = 9.0f
        /**
         * How much of the phone's total vibration energy has to live in the gait band for it to
         * be a gait at all. Walking puts most of its energy under LOWPASS_HZ; a road surface
         * puts most of it above. The amplitude bar alone cannot make this distinction — a rough
         * enough road clears any absolute threshold — but the RATIO can.
         *
         * Set at the loose end of what still works, because the two error directions are not
         * symmetric. Missing a gait is what lets a walk look like a ride and start a false trip;
         * over-detecting one only closes the vehicle gate and falls back to the speed gates,
         * which is exactly today's behaviour. A swept simulation puts road vibration under this
         * bar in all but the cases whose energy genuinely sits in the gait band (a 1.9 Hz
         * suspension bounce), and those come out as WALK, which vetoes nothing.
         */
        private const val GAIT_BAND_RATIO_MIN = 0.35f
        private const val GAIT_MIN_STEPS = 5
        private const val WALK_MIN_HZ = 1.1
        private const val GAIT_MAX_HZ = 3.6
        /** Above this cadence it is a run, not a walk — the only gait that can fake 10 km/h. */
        private const val RUN_MIN_HZ = 2.4
        /**
         * ...and only with a footfall's worth of gait-band energy behind it. RUN is the one
         * verdict that can veto the fast gate, so it is the one that must not be reachable by
         * accident. Cadence on its own can be reached by accident (see LOWPASS_HZ); sustained
         * low-frequency amplitude cannot — a suspension does not deliver this much energy below
         * 3.5 Hz, and a running phone in a pocket delivers more. Below this bar a fast cadence
         * is classified WALK instead, which by design vetoes nothing.
         */
        private const val RUN_MIN_STD = 1.3f
        /**
         * Coefficient of variation of the step intervals. THE discriminator: human gait holds
         * its period to well inside 40%, road vibration does not hold one at all.
         */
        private const val GAIT_MAX_INTERVAL_CV = 0.40
        /** No two footfalls are 220 ms apart — anything faster is one impact ringing. */
        private const val PEAK_REFRACTORY_MS = 220L

        // ── Speed evidence ────────────────────────────────────────────────────
        /** No one walks or runs this fast for six seconds. Decides on its own. */
        private const val SPEED_CERTAIN_VEHICLE_KMH = 20.0
        /** Fast enough that only a sprint could match it. */
        private const val SPEED_LIKELY_VEHICLE_KMH = 12.0
        /** Slower than this is indistinguishable from a fix wandering in place. */
        private const val CREEP_MIN_KMH = 0.7
        /** Fixes kept for the sustained-speed percentile: ~16 s at the moving GPS cadence. */
        private const val SPEED_WINDOW_MAX = 8

        // ── Gyroscope ─────────────────────────────────────────────────────────
        /** rad/s. A carried phone lives far above this; a seated one far below. */
        private const val GYRO_QUIET_RPS = 0.25
        /**
         * Sustained rotation at this rate is a phone being carried, not one riding in a vehicle.
         *
         * This is the backstop for the single failure that actually costs data integrity: a gait
         * gentle enough that the accelerometer misses it (a slow amble, phone loose in a bag)
         * would otherwise satisfy "moving with no gait under it" and open the vehicle gate on a
         * pedestrian. A walking phone swings through most of a radian per second and a cradled
         * one does not, so the gyroscope catches what the cadence test drops. Costs at worst a
         * delayed trip start while a driver is handling their phone — the speed gates are
         * untouched by it.
         */
        private const val GYRO_CARRIED_RPS = 0.6

        // ── Activity recognition ──────────────────────────────────────────────
        private const val AR_MIN_CONFIDENCE = 50
        /** A verdict older than this describes a previous situation, not this one. */
        private const val AR_FRESH_MS = 90_000L

        // ── Score integration ─────────────────────────────────────────────────
        private const val SCORE_CAP = 12.0
        /** Evidence needed to commit to a verdict — with the weights below, ~2-3 s. */
        private const val ENTER_SCORE = 6.0
        /** A committed verdict survives down to here, so one contrary second cannot flip it. */
        private const val HOLD_SCORE = 2.0
        /** With no witness saying anything, confidence bleeds away rather than persisting. */
        private const val SCORE_DECAY = 0.85
    }

    // ── Sensor plumbing ───────────────────────────────────────────────────────
    private var sensors: SensorManager? = null
    private var accel: Sensor? = null
    private var gyro: Sensor? = null
    private var running = false
    private var batchLatencyUs = BATCH_LATENCY_ACTIVE_US

    // ── Accelerometer ring buffers (primitive: 25 allocations/s over a shift is not free) ──
    /** Raw magnitude — total vibration, the denominator of the band ratio. */
    private val magBuf = FloatArray(MAX_SAMPLES)
    /** Low-passed magnitude — gait-band energy, and the only signal peaks are counted on. */
    private val lowBuf = FloatArray(MAX_SAMPLES)
    private val timeBuf = LongArray(MAX_SAMPLES)
    private var bufHead = 0
    private var bufCount = 0

    // Two-pole low-pass state, advanced sample by sample as they arrive.
    private var lp1 = 0f
    private var lp2 = 0f
    private var lastSampleMs = 0L

    private val peakTimes = LongArray(MAX_PEAKS)

    /** Exponential mean of |angular velocity|, in rad/s. */
    private var gyroRms = 0.0
    private var sawGyro = false

    // ── Speed history ─────────────────────────────────────────────────────────
    private val speedWindow = ArrayDeque<Double>()

    // ── Verdict state ─────────────────────────────────────────────────────────
    private var score = 0.0
    private var verdict = Verdict.UNKNOWN
    private var gait = Gait.NONE
    private var accelStd = 0f
    private var cadenceHz = 0.0
    private var lastEvalMs = 0L

    // ── Public API ────────────────────────────────────────────────────────────

    fun start() {
        if (running) return
        try {
            val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
            sensors = sm
            accel = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
            gyro = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
            registerAll(sm)
            running = accel != null || gyro != null
        } catch (_: Exception) {
            running = false
        }
    }

    private fun registerAll(sm: SensorManager) {
        accel?.let { sm.registerListener(this, it, SAMPLE_PERIOD_US, batchLatencyUs) }
        gyro?.let { sm.registerListener(this, it, SAMPLE_PERIOD_US, batchLatencyUs) }
    }

    /**
     * Trade a few seconds of verdict latency for battery while only a dormant watch is needed.
     *
     * Nothing is switched off. A parked phone still has to be able to notice it is being driven
     * away, and the 1 km/h departure this class exists to catch is invisible to every other
     * sensor — turning the accelerometer off would trade the whole feature for the saving.
     * Buffering it deeper keeps the capability and drops the wakeups.
     */
    fun setLowPower(lowPower: Boolean) {
        val wanted = if (lowPower) BATCH_LATENCY_DORMANT_US else BATCH_LATENCY_ACTIVE_US
        if (wanted == batchLatencyUs) return
        batchLatencyUs = wanted
        if (!running) return
        val sm = sensors ?: return
        try {
            sm.unregisterListener(this)
            registerAll(sm)
        } catch (_: Exception) {}
    }

    fun stop() {
        try { sensors?.unregisterListener(this) } catch (_: Exception) {}
        running = false
        bufCount = 0
        bufHead = 0
        lastSampleMs = 0L
        speedWindow.clear()
        score = 0.0
        verdict = Verdict.UNKNOWN
        gait = Gait.NONE
        sawGyro = false
        gyroRms = 0.0
    }

    /**
     * Feed every GPS fix.
     *
     * @param fixSpeedKmh    the fix's own (Doppler) speed.
     * @param groundSpeedKmh speed derived from displacement over a LONG baseline — the distance
     *        from the trip-start watch anchor, or from the last recorded point. Passed separately
     *        because Doppler collapses to zero at a crawl (the exact regime this class exists to
     *        recognise), while displacement measured over tens of seconds stays honest. The
     *        larger of the two is used: under-reporting is the failure mode here, not over-.
     */
    fun onGpsFix(fixSpeedKmh: Double, groundSpeedKmh: Double?) {
        val effective = maxOf(fixSpeedKmh, groundSpeedKmh ?: 0.0)
        speedWindow.addLast(if (effective.isFinite() && effective >= 0) effective else 0.0)
        while (speedWindow.size > SPEED_WINDOW_MAX) speedWindow.removeFirst()
    }

    /** Everything below is evaluated lazily, so the service drives the cadence. */
    fun verdict(now: Long): Verdict {
        maybeEvaluate(now)
        return verdict
    }

    fun gait(now: Long): Gait {
        maybeEvaluate(now)
        return gait
    }

    /** True only when the fused evidence says "in a vehicle" — the new trip-start gate's key. */
    fun isVehicle(now: Long): Boolean = verdict(now) == Verdict.VEHICLE

    /**
     * A RUN is the only gait that can average TRIP_START_MIN_SPEED_KMH over the fast gate's
     * 30 m, so it is the only one allowed to veto that gate. A "walk" verdict at 10 km/h is by
     * definition a misclassification, and must not be able to cost a trip.
     *
     * The veto keys on the GAIT, not on a committed FOOT verdict, and is lifted only by a
     * positive VEHICLE one. Requiring FOOT left a hole: the score is a sum, so a single piece of
     * contrary evidence worth as much as the gait — a stale or plainly wrong IN_VEHICLE call
     * from Play Services is exactly that, at +3 against the gait's -3 — cancels out to no
     * evidence at all, the verdict decays to UNKNOWN, and the veto quietly stops applying while
     * the accelerometer is still watching someone run. A runner would then start a trip. Treating
     * "seeing a running gait and not being sure it is a vehicle" as reason enough to hold the
     * gate shut closes that, and costs nothing when the phone really is in a vehicle, because
     * road speed makes the verdict VEHICLE well before the fast gate is in reach.
     */
    fun isRunningOnFoot(now: Long): Boolean =
        gait(now) == Gait.RUN && verdict(now) != Verdict.VEHICLE

    /**
     * Whether the current window is capable of ruling a running gait in or out.
     *
     * The gates ask this before believing a NEGATIVE, because "no gait detected" means two
     * completely different things. With a live accelerometer it is evidence: nothing is walking,
     * so a phone covering ground is riding. With an absent or stalled one it is silence, and
     * treating silence as evidence is how a pedestrian starts a trip — hence the freshness check
     * on the newest sample rather than a bare count.
     */
    fun hasUsableGaitWindow(now: Long): Boolean {
        maybeEvaluate(now)
        if (accel == null) return false
        val newest = if (bufCount > 0) timeBuf[(bufHead - 1 + MAX_SAMPLES) % MAX_SAMPLES] else 0L
        // The tolerance must cover the batching latency in force, or a dormant watch would
        // declare its own deliberately-buffered sensor stale on every single call.
        val tolerance = EVAL_INTERVAL_MS * 2 + batchLatencyUs / 1000L
        return bufCount >= GAIT_MIN_STEPS * 2 && newest > 0L && now - newest <= tolerance
    }

    /** Short human-readable state for the foreground notification — field debugging. */
    fun describe(now: Long): String {
        maybeEvaluate(now)
        return when (verdict) {
            Verdict.VEHICLE -> "in vehicle"
            Verdict.FOOT -> if (gait == Gait.RUN) "running" else "on foot"
            Verdict.UNKNOWN -> "motion unknown"
        }
    }

    // ── SensorEventListener ───────────────────────────────────────────────────

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    override fun onSensorChanged(event: SensorEvent?) {
        val e = event ?: return
        when (e.sensor?.type) {
            Sensor.TYPE_ACCELEROMETER -> {
                val x = e.values[0]; val y = e.values[1]; val z = e.values[2]
                // Magnitude, gravity included. The window's own mean is subtracted during
                // analysis, which removes gravity without needing to know which way is down —
                // and works the same whether the phone lies flat on a seat or stands in a cradle.
                val t = sampleTimeMs(e)
                push(sqrt(x * x + y * y + z * z), t)
                // Self-paced evaluation. Without this the score would only advance when the
                // service happened to ask — every 10 s at the idle GPS cadence — and a verdict
                // that needs a few consistent seconds would instead need half a minute.
                maybeEvaluate(t)
            }
            Sensor.TYPE_GYROSCOPE -> {
                val x = e.values[0].toDouble()
                val y = e.values[1].toDouble()
                val z = e.values[2].toDouble()
                val mag = sqrt(x * x + y * y + z * z)
                gyroRms = if (!sawGyro) mag else gyroRms * 0.97 + mag * 0.03
                sawGyro = true
            }
        }
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    /**
     * Stores the raw magnitude and its low-passed counterpart.
     *
     * The filter coefficient is derived from the ACTUAL gap between samples rather than assuming
     * SAMPLE_PERIOD_US: Android treats a requested sensor rate as a hint, delivery is batched on
     * many devices, and a cutoff that silently moves with the handset would make the gait band
     * device-specific. The gap is clamped so one long stall cannot hand the filter a coefficient
     * of 1 (which would pass the raw signal straight through, aliasing and all).
     */
    /**
     * When this sample was actually TAKEN, on elapsedRealtime's scale.
     *
     * Batching is what forces this. A buffered burst arrives all at once, so stamping samples on
     * ARRIVAL would collapse a second of gait onto a single instant and destroy the cadence and
     * interval-regularity measurements that the whole classification rests on.
     *
     * SensorEvent.timestamp is documented as elapsedRealtimeNanos, but a number of vendor HALs
     * report wall-clock nanoseconds instead - which would put every sample tens of years in the
     * future. Rather than trust it, it is used only when it lands near the current elapsed time;
     * otherwise arrival time is close enough and always sane.
     */
    private fun sampleTimeMs(e: SensorEvent): Long {
        val nowMs = SystemClock.elapsedRealtime()
        val sensorMs = e.timestamp / 1_000_000L
        return if (sensorMs > 0L && abs(nowMs - sensorMs) < 60_000L) sensorMs else nowMs
    }
    private fun push(mag: Float, t: Long) {
        if (lastSampleMs == 0L) {
            lp1 = mag
            lp2 = mag
        } else {
            val dt = (t - lastSampleMs).coerceIn(1L, 200L) / 1000.0
            val rc = 1.0 / (2.0 * Math.PI * LOWPASS_HZ)
            val alpha = (dt / (rc + dt)).toFloat()
            lp1 += alpha * (mag - lp1)
            lp2 += alpha * (lp1 - lp2)
        }
        lastSampleMs = t

        magBuf[bufHead] = mag
        lowBuf[bufHead] = lp2
        timeBuf[bufHead] = t
        bufHead = (bufHead + 1) % MAX_SAMPLES
        if (bufCount < MAX_SAMPLES) bufCount++
    }

    private fun maybeEvaluate(now: Long) {
        if (now - lastEvalMs < EVAL_INTERVAL_MS) return
        lastEvalMs = now
        evaluate(now)
    }

    private fun evaluate(now: Long) {
        analyseAccelerometer(now)

        val speed = sustainedSpeedKmh()
        val haveAccel = bufCount >= GAIT_MIN_STEPS * 2
        var evidence = 0.0

        // 1. Speed nobody reaches on foot. Strong enough to carry a verdict alone.
        if (speed >= SPEED_CERTAIN_VEHICLE_KMH) {
            evidence += 4.0
        } else if (speed >= SPEED_LIKELY_VEHICLE_KMH && gait != Gait.RUN) {
            evidence += 2.0
        }

        // 2. A gait under the phone. Walking and running weigh the same here: neither is driving.
        if (gait != Gait.NONE) evidence -= 3.0

        // 3. Ground covered with no gait beneath it — the slow-driving rule. A person cannot
        //    translate over the ground without a gait, so movement plus no gait is a ride. This
        //    is what starts a trip at 1 km/h, where both the speed thresholds and Google's model
        //    report "parked".
        if (haveAccel && gait == Gait.NONE && speed >= CREEP_MIN_KMH && accelStd <= GAIT_MAX_STD) {
            evidence += 2.0
        }

        // 4. Google's on-device model, with its confidence, when it has spoken recently.
        val arAge = System.currentTimeMillis() - TrackingConfig.activityConfidenceAt(ctx)
        if (arAge in 0..AR_FRESH_MS) {
            if (TrackingConfig.activityVehicleConfidence(ctx) >= AR_MIN_CONFIDENCE) evidence += 3.0
            if (TrackingConfig.activityFootConfidence(ctx) >= AR_MIN_CONFIDENCE) evidence -= 3.0
        }

        // 5. Gyroscope, both ways. Ground covered with the phone held steady is a ride;
        //    sustained rotation is a phone being carried, whatever the cadence test concluded.
        if (sawGyro && gait == Gait.NONE && speed >= CREEP_MIN_KMH && gyroRms < GYRO_QUIET_RPS) {
            evidence += 1.0
        }
        if (sawGyro && gyroRms >= GYRO_CARRIED_RPS) evidence -= 2.0

        score = if (evidence == 0.0) score * SCORE_DECAY else score + evidence
        score = score.coerceIn(-SCORE_CAP, SCORE_CAP)

        verdict = when {
            score >= ENTER_SCORE -> Verdict.VEHICLE
            score <= -ENTER_SCORE -> Verdict.FOOT
            verdict == Verdict.VEHICLE && score >= HOLD_SCORE -> Verdict.VEHICLE
            verdict == Verdict.FOOT && score <= -HOLD_SCORE -> Verdict.FOOT
            else -> Verdict.UNKNOWN
        }
    }

    /**
     * Sweeps the window for mean, deviation, and rising-edge peak times.
     *
     * Everything about the GAIT runs on the low-passed signal (see LOWPASS_HZ); the raw signal
     * is kept only to measure how much of the total vibration lives in the gait band. Peaks are
     * counted against a threshold scaled to the window's own energy, so the same code finds
     * footfalls whether the phone is loose in a jacket or gripped in a hand.
     */
    private fun analyseAccelerometer(now: Long) {
        if (bufCount == 0) { gait = Gait.NONE; accelStd = 0f; cadenceHz = 0.0; return }

        val start = (bufHead - bufCount + MAX_SAMPLES) % MAX_SAMPLES
        var sum = 0.0
        var rawSum = 0.0
        var n = 0
        var oldest = Long.MAX_VALUE
        var newest = 0L
        for (k in 0 until bufCount) {
            val i = (start + k) % MAX_SAMPLES
            if (now - timeBuf[i] > WINDOW_MS) continue
            sum += lowBuf[i]; rawSum += magBuf[i]; n++
            if (timeBuf[i] < oldest) oldest = timeBuf[i]
            if (timeBuf[i] > newest) newest = timeBuf[i]
        }
        if (n < GAIT_MIN_STEPS * 2) { gait = Gait.NONE; accelStd = 0f; cadenceHz = 0.0; return }

        val mean = sum / n
        val rawMean = rawSum / n
        var sq = 0.0
        var rawSq = 0.0
        for (k in 0 until bufCount) {
            val i = (start + k) % MAX_SAMPLES
            if (now - timeBuf[i] > WINDOW_MS) continue
            val d = lowBuf[i] - mean
            sq += d * d
            val rd = magBuf[i] - rawMean
            rawSq += rd * rd
        }
        val std = sqrt(sq / n).toFloat()
        val rawStd = sqrt(rawSq / n).toFloat()
        accelStd = std
        // Share of the shaking that is slow enough to be a footfall. A road puts its energy
        // above the cutoff, a gait below it.
        val bandRatio = if (rawStd > 0.01f) std / rawStd else 0f

        val threshold = maxOf(0.45f, std * 0.5f)
        var peaks = 0
        var above = false
        var lastPeak = 0L
        for (k in 0 until bufCount) {
            val i = (start + k) % MAX_SAMPLES
            if (now - timeBuf[i] > WINDOW_MS) continue
            val d = lowBuf[i] - mean
            if (!above && d > threshold) {
                above = true
                val t = timeBuf[i]
                if (t - lastPeak >= PEAK_REFRACTORY_MS && peaks < MAX_PEAKS) {
                    peakTimes[peaks] = t
                    peaks++
                    lastPeak = t
                }
            } else if (above && d < 0f) {
                above = false
            }
        }

        val spanSec = ((newest - oldest).coerceAtLeast(1L)) / 1000.0
        cadenceHz = peaks / spanSec

        // Spacing regularity — the test that road vibration fails and a human gait passes.
        var cv = Double.MAX_VALUE
        if (peaks >= GAIT_MIN_STEPS) {
            var intervalSum = 0.0
            for (p in 1 until peaks) intervalSum += (peakTimes[p] - peakTimes[p - 1]).toDouble()
            val intervalMean = intervalSum / (peaks - 1)
            if (intervalMean > 0) {
                var intervalSq = 0.0
                for (p in 1 until peaks) {
                    val d = (peakTimes[p] - peakTimes[p - 1]) - intervalMean
                    intervalSq += d * d
                }
                cv = sqrt(intervalSq / (peaks - 1)) / intervalMean
            }
        }

        gait = if (
            peaks >= GAIT_MIN_STEPS &&
            std >= GAIT_MIN_STD && std <= GAIT_MAX_STD &&
            bandRatio >= GAIT_BAND_RATIO_MIN &&
            cadenceHz >= WALK_MIN_HZ && cadenceHz <= GAIT_MAX_HZ &&
            cv <= GAIT_MAX_INTERVAL_CV
        ) {
            if (cadenceHz >= RUN_MIN_HZ && std >= RUN_MIN_STD) Gait.RUN else Gait.WALK
        } else {
            Gait.NONE
        }
    }

    /**
     * A low percentile rather than a mean: one multipath spike must not read as "moving", but a
     * steady crawl must survive. 40th percentile over the last SPEED_WINDOW_MAX fixes.
     */
    private fun sustainedSpeedKmh(): Double {
        if (speedWindow.isEmpty()) return 0.0
        val sorted = speedWindow.sorted()
        return sorted[(sorted.size * 4) / 10]
    }
}
