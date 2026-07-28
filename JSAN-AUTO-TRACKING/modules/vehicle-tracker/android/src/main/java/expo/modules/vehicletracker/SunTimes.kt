package expo.modules.vehicletracker

import java.util.Calendar
import java.util.TimeZone
import kotlin.math.*

/**
 * Calculates sunrise and sunset times for a given latitude, longitude, and date.
 * Uses the NOAA solar calculator algorithm — accurate to ~1 minute.
 *
 * No external dependencies needed.
 */
object SunTimes {

    data class DaylightWindow(
        /** Sunrise hour in local time (e.g. 6.25 = 6:15 AM) */
        val sunriseHour: Double,
        /** Sunset hour in local time (e.g. 18.75 = 6:45 PM) */
        val sunsetHour: Double,
        /** Timezone ID used for the calculation */
        val timezoneId: String,
    ) {
        /** True if the given epoch millis falls between sunrise and sunset. */
        fun isDaylight(epochMs: Long): Boolean {
            val cal = Calendar.getInstance(TimeZone.getTimeZone(timezoneId))
            cal.timeInMillis = epochMs
            val hour = cal.get(Calendar.HOUR_OF_DAY) + cal.get(Calendar.MINUTE) / 60.0
            return hour >= sunriseHour && hour <= sunsetHour
        }

        fun sunriseFormatted(): String = formatHour(sunriseHour)
        fun sunsetFormatted(): String = formatHour(sunsetHour)

        private fun formatHour(h: Double): String {
            val hrs = h.toInt()
            val mins = ((h - hrs) * 60).roundToInt()
            return "%02d:%02d".format(hrs, mins)
        }
    }

    /**
     * Calculate today's sunrise and sunset for the given location.
     *
     * @param lat      Latitude in degrees (positive = N)
     * @param lon      Longitude in degrees (positive = E)
     * @param tzId     IANA timezone ID (e.g. "Asia/Kolkata")
     * @param epochMs  The date to calculate for (defaults to now)
     * @return DaylightWindow, or null for polar regions with no sunrise/sunset
     */
    fun today(lat: Double, lon: Double, tzId: String, epochMs: Long = System.currentTimeMillis()): DaylightWindow? {
        val tz = TimeZone.getTimeZone(tzId)
        val cal = Calendar.getInstance(tz)
        cal.timeInMillis = epochMs

        val dayOfYear = cal.get(Calendar.DAY_OF_YEAR)
        val year = cal.get(Calendar.YEAR)

        // Fractional year in radians
        val gamma = 2.0 * PI / 365.0 * (dayOfYear - 1)

        // Equation of time (minutes)
        val eqTime = 229.18 * (0.000075 +
                0.001868 * cos(gamma) -
                0.032077 * sin(gamma) -
                0.014615 * cos(2 * gamma) -
                0.04089 * sin(2 * gamma))

        // Solar declination (radians)
        val decl = 0.006918 -
                0.399912 * cos(gamma) +
                0.070257 * sin(gamma) -
                0.006758 * cos(2 * gamma) +
                0.000907 * sin(2 * gamma) -
                0.002697 * cos(3 * gamma) +
                0.00148 * sin(3 * gamma)

        val latRad = Math.toRadians(lat)

        // Hour angle for sunrise/sunset (solar zenith = 90.833 degrees for atmospheric refraction)
        val zenith = Math.toRadians(90.833)
        val cosHA = (cos(zenith) / (cos(latRad) * cos(decl))) - tan(latRad) * tan(decl)

        // Polar day/night — no sunrise or sunset
        if (cosHA < -1.0 || cosHA > 1.0) return null

        val ha = acos(cosHA) // in radians
        val haDeg = Math.toDegrees(ha)

        // UTC offset in minutes
        val offsetMin = tz.getOffset(epochMs) / 60000.0

        // Sunrise and sunset in local hours
        val solarNoon = (720.0 - 4.0 * lon - eqTime + offsetMin) / 60.0
        val sunrise = solarNoon - haDeg / 15.0
        val sunset = solarNoon + haDeg / 15.0

        return DaylightWindow(
            sunriseHour = sunrise.coerceIn(0.0, 24.0),
            sunsetHour = sunset.coerceIn(0.0, 24.0),
            timezoneId = tzId,
        )
    }

    /**
     * Detect the IANA timezone ID. Prefers the user-configured timezone (set via
     * the timezone setup screen + LocationIQ reverse geocoding), falls back to
     * the device's default timezone.
     */
    fun detectTimezone(lat: Double, lon: Double, ctx: android.content.Context? = null): String {
        // 1. Prefer timezone stored in TrackingConfig (set by the app's timezone-setup screen)
        if (ctx != null) {
            val stored = TrackingConfig.timezoneId(ctx)
            if (!stored.isNullOrBlank()) return stored
        }
        // 2. Fall back to device timezone (set by carrier/GPS)
        return TimeZone.getDefault().id
    }
}
