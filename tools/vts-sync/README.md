# VTS → Atlas ops sync

A desktop window that finds what drivers recorded on the old VTS app but Atlas ops (PRJ-025-HE-DRIVE-AUSGNZ) does not have yet, and imports it, straight from the VTS database.

- **Scan for missing data**: reads both databases (read-only) and lists:
  - **Sessions:** driver, date, raw GPS fixes, cleaned (snapped) points and km, and what an import will do with each one: import it, create the driver's account first, keep the day because Atlas already has that driver's trips, or wait because the session is still recording.
  - **Markers:** per driver and day, by colour.
- **Import sessions**: `backend/src/seed/importVtsSessions.js --from-db`. Raw GPS **and** VTS's cleaned route when VTS has both; the cleaned route alone when VTS no longer holds the raw fixes. Each trip goes through the normal pipeline (km, UKM, road coverage).
- **Import markers**: `backend/src/seed/importVtsMarkers.js`. Same colours (red, yellow, blue, green), each marker linked to its driver and trip.
- Everything written carries one batch id. The end of the Log tab shows it with its undo command. A re-run never imports anything twice.

## Setup (once per PC)

    powershell -ExecutionPolicy Bypass -File setup.ps1

You also need Node.js on PATH, and `backend/.env` with the Atlas `MONGODB_URI` (the backend's own setup).

## Use

Double-click the **VTS to Atlas Sync** shortcut, or run `.venv\Scripts\pythonw.exe vts_sync.py`.

Paste the VTS database connection string the first time. Tick "Remember on this PC" to keep it in `%APPDATA%\JSAN\vts-sync.json`; it is never stored in the repository. Then click Scan, then Import.

Without a window: `VTS_MONGODB_URI=… .venv\Scripts\python.exe vts_sync.py --scan`
