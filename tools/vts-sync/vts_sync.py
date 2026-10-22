"""
VTS -> Atlas ops sync.

A small desktop window for bringing what drivers still record on the old VTS app into Atlas ops
(project PRJ-025-HE-DRIVE-AUSGNZ), straight from the VTS database:

  Scan            reads both databases and lists what VTS has that Atlas does not —
                  sessions (driver, day, raw fixes, cleaned route, and what an import would do with
                  each) and markers (per driver and day, by colour).
  Import ...      runs the backend's own importers, the same ones used for every earlier sync:
                    backend/src/seed/importVtsSessions.js --from-db   raw GPS + VTS's cleaned route
                    backend/src/seed/importVtsMarkers.js              markers, same colours
                  Their output streams into the Log tab, ending with the batch id and its undo command.

The scan is read-only on both sides. The VTS database is only ever read; Atlas is written only by
the importers, which skip whatever is already in (a re-run imports nothing twice). The Atlas
connection is taken from backend/.env; the VTS connection string is typed in, and kept in
%APPDATA%\\JSAN\\vts-sync.json only if "Remember" is ticked — never in the repository.

Run:  .venv\\Scripts\\pythonw.exe vts_sync.py      (see README.md for setup)
      .venv\\Scripts\\python.exe vts_sync.py --scan (print the scan, no window)
"""
from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from bson import ObjectId
from pymongo import MongoClient

REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"
VTS_PROJECT = ObjectId("6a3233e935b68ccdc47a9785")  # "projaustralia" on VTS
TEST_EMAILS = {"autest@vts.com", "projaus@gmail.com"}  # VTS test logins: never real driving
DEFAULT_ZONE = "Australia/Melbourne"
CONFIG = Path(os.environ.get("APPDATA", str(Path.home()))) / "JSAN" / "vts-sync.json"

READY = "Ready to import"
NEW_DRIVER = "Ready — new driver, account will be created"
NO_ACCOUNT = "Skipped — driver has no Atlas account"
DAY_HAS_DATA = "Kept — Atlas already has this driver's trips that day"
REPLACEABLE = "Replace with VTS — VTS has more km (tick 'Replace Atlas days')"
# The day-replace rule, as in backend/src/seed/replaceDaysWithVts.js.
REPLACE_MARGIN = 0.10
REPLACE_MIN_GAIN_KM = 3.0
ACTIVE = "Waiting — still recording on VTS"
EMPTY = "Skipped — under 2 GPS fixes and no cleaned route"
TEST = "Skipped — VTS test login"
COLOURS = ("red", "yellow", "blue", "green")


# --------------------------------------------------------------------------------------------
# Connections
# --------------------------------------------------------------------------------------------

def atlas_uri() -> str:
    """MONGODB_URI from backend/.env — the database the backend and its importers use."""
    env = BACKEND / ".env"
    if not env.exists():
        raise RuntimeError(f"{env} not found")
    for line in env.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*MONGODB_URI\s*=\s*(.+)\s*$", line)
        if m:
            return m.group(1).strip().strip('"').strip("'")
    raise RuntimeError("MONGODB_URI is not set in backend/.env")


def host_of(uri: str) -> str:
    """The host part of a connection string, never the credentials."""
    return re.sub(r"^mongodb(\+srv)?://([^@/]*@)?", "", uri).split("/")[0]


def load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(cfg: dict) -> None:
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def connect(uri: str):
    client = MongoClient(uri, readPreference="secondaryPreferred", serverSelectionTimeoutMS=20000)
    db = client.get_default_database()
    db.command("ping")
    return client, db


# --------------------------------------------------------------------------------------------
# Scan (read-only)
# --------------------------------------------------------------------------------------------

def local_day(when, zone: str) -> str:
    if when is None:
        return "?"
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when.astimezone(ZoneInfo(zone)).strftime("%Y-%m-%d")


def scan(vts_uri: str, create_accounts: bool, say=print) -> dict:
    """What VTS has that Atlas does not, with what an import would do with each session.

    Mirrors the rules of backend/src/seed/importVtsSessions.js so the list matches what Import
    will actually do; the importer itself remains the authority when it runs.
    """
    say("Connecting to VTS...")
    vts_client, vts = connect(vts_uri)
    say("Connecting to Atlas...")
    atlas_client, atlas = connect(atlas_uri())
    try:
        vts_users = list(vts.users.find({"project": VTS_PROJECT}, {"name": 1, "email": 1}))
        by_vts_id = {u["_id"]: u for u in vts_users}
        say(f"VTS: {len(vts_users)} projaustralia drivers. Reading sessions...")
        sessions = list(vts.sessions.aggregate([
            {"$match": {"driver": {"$in": list(by_vts_id)}}},
            {"$project": {
                "driver": 1, "startTime": 1, "endTime": 1, "isActive": 1, "totalLocations": 1,
                "cleanedDistance": 1, "licensePlate": 1,
                "cleanedRouteCount": {"$size": {"$ifNull": ["$cleanedRoute", []]}},
            }},
        ]))

        say("Atlas: reading what is already imported...")
        imported = set(atlas.trips.distinct("importSourceId", {"importSourceId": {"$regex": "^vts:"}}))
        atlas_users = {
            str(u.get("email", "")).lower(): u
            for u in atlas.users.find({"role": "user"}, {"name": 1, "email": 1, "timezone": 1})
        }

        # The days each Atlas driver already has real (non-VTS) driving on, in their zone.
        zones: dict = {}
        days: dict = {}

        def zone_of(user) -> str:
            uid = user["_id"]
            if uid not in zones:
                last = atlas.trips.find_one({"driverId": uid, "timezone": {"$ne": None}}, {"timezone": 1}, sort=[("startedAt", -1)])
                zones[uid] = user.get("timezone") or (last or {}).get("timezone") or DEFAULT_ZONE
            return zones[uid]

        def days_of(user) -> dict:
            """day -> km this driver recorded on Atlas itself that day (matched route km, else raw)."""
            uid = user["_id"]
            if uid not in days:
                z = zone_of(user)
                per: dict = defaultdict(float)
                for t in atlas.trips.find(
                    {"driverId": uid, "parkedJitter": {"$ne": True}, "distanceMeters": {"$gt": 0},
                     "importBatchId": {"$not": re.compile("^vts-")}},
                    {"startedAt": 1, "timezone": 1, "cleanedDistanceMeters": 1, "distanceMeters": 1},
                ):
                    per[local_day(t["startedAt"], t.get("timezone") or z)] += (t.get("cleanedDistanceMeters") or t.get("distanceMeters") or 0) / 1000
                days[uid] = per
            return days[uid]

        # VTS km per driver-day: every session of that driver that day (cleaned km), imported or not.
        # A day where VTS never measured any session (no cleanedDistance) reads "not measured", not 0.
        vts_day_km: dict = defaultdict(float)
        vts_day_measured: set = set()
        for s in sessions:
            vu = by_vts_id.get(s["driver"], {})
            u = atlas_users.get(str(vu.get("email", "")).lower())
            key = (s["driver"], local_day(s.get("startTime"), zone_of(u) if u else DEFAULT_ZONE))
            if s.get("cleanedDistance") is not None:
                vts_day_measured.add(key)
                vts_day_km[key] += (s.get("cleanedDistance") or 0) / 1000

        rows = []
        already = 0
        for s in sorted(sessions, key=lambda x: x.get("startTime") or datetime.min):
            if f"vts:{s['_id']}" in imported:
                already += 1
                continue
            vu = by_vts_id.get(s["driver"], {})
            email = str(vu.get("email", "")).lower()
            user = atlas_users.get(email)
            zone = zone_of(user) if user else DEFAULT_ZONE
            day = local_day(s.get("startTime"), zone)
            if s.get("isActive"):
                status = ACTIVE
            elif email in TEST_EMAILS:
                status = TEST
            elif (s.get("totalLocations") or 0) < 2 and (s.get("cleanedRouteCount") or 0) < 2:
                status = EMPTY
            elif not user:
                status = NEW_DRIVER if create_accounts else NO_ACCOUNT
            elif day in days_of(user):
                status = DAY_HAS_DATA
            else:
                status = READY
            atlas_km = round(days_of(user).get(day, 0.0), 1) if user else None
            vts_km = round(vts_day_km.get((s["driver"], day), 0.0), 1) if (s["driver"], day) in vts_day_measured else None
            if status == DAY_HAS_DATA and atlas_km is not None and vts_km is not None \
                    and vts_km > atlas_km * (1 + REPLACE_MARGIN) and vts_km - atlas_km > REPLACE_MIN_GAIN_KM:
                status = REPLACEABLE
            rows.append({
                "day": day,
                "atlas_km": atlas_km,
                "vts_km": vts_km,
                "diff": None if atlas_km is None or vts_km is None else round(vts_km - atlas_km, 1),
                "driver": vu.get("name") or email or str(s["driver"]),
                "session": str(s["_id"]),
                "raw": int(s.get("totalLocations") or 0),
                "cleaned": int(s.get("cleanedRouteCount") or 0),
                "km": round((s.get("cleanedDistance") or 0) / 1000, 1),
                "plate": s.get("licensePlate") or "",
                "status": status,
            })

        say("Reading markers...")
        have = set(atlas.markers.distinct("clientId", {"clientId": {"$regex": "^vts:"}}))
        groups: dict = defaultdict(Counter)
        marker_status: dict = {}
        missing_markers = 0
        for m in vts.custommarkers.find({"driver": {"$in": list(by_vts_id)}}, {"driver": 1, "color": 1, "timestamp": 1}):
            if f"vts:{m['_id']}" in have:
                continue
            vu = by_vts_id.get(m["driver"], {})
            email = str(vu.get("email", "")).lower()
            if email in TEST_EMAILS:
                continue
            missing_markers += 1
            user = atlas_users.get(email)
            key = (local_day(m.get("timestamp"), zone_of(user) if user else DEFAULT_ZONE), vu.get("name") or email)
            colour = str(m.get("color") or "red").lower()
            groups[key][colour if colour in COLOURS else "red"] += 1
            if key not in marker_status:
                marker_status[key] = READY if user else ("Waiting — import this driver's sessions first (creates the account)" if create_accounts else NO_ACCOUNT)
        markers = [
            {"day": k[0], "driver": k[1], **{c: groups[k][c] for c in COLOURS}, "total": sum(groups[k].values()), "status": marker_status[k]}
            for k in sorted(groups)
        ]

        summary = Counter(r["status"] for r in rows)
        say(f"Done: {len(rows)} sessions not in Atlas ({already} already imported), {missing_markers} markers not in Atlas.")
        return {"sessions": rows, "already": already, "summary": summary, "markers": markers, "missing_markers": missing_markers}
    finally:
        vts_client.close()
        atlas_client.close()


# --------------------------------------------------------------------------------------------
# Window
# --------------------------------------------------------------------------------------------

def run_window() -> None:
    import tkinter as tk
    from tkinter import messagebox, ttk

    cfg = load_config()
    root = tk.Tk()
    root.title("VTS → Atlas ops sync")
    root.geometry("1180x720")
    root.minsize(900, 560)

    events: "queue.Queue[tuple]" = queue.Queue()
    busy = tk.BooleanVar(value=False)
    proc_holder: dict = {"proc": None}

    # --- connection ------------------------------------------------------------------------
    top = ttk.Frame(root, padding=10)
    top.pack(fill="x")
    ttk.Label(top, text="VTS database").grid(row=0, column=0, sticky="w")
    vts_var = tk.StringVar(value=cfg.get("vts_uri", os.environ.get("VTS_MONGODB_URI", "")))
    vts_entry = ttk.Entry(top, textvariable=vts_var, show="•", width=78)
    vts_entry.grid(row=0, column=1, sticky="we", padx=6)
    show_var = tk.BooleanVar(value=False)
    ttk.Checkbutton(top, text="Show", variable=show_var,
                    command=lambda: vts_entry.configure(show="" if show_var.get() else "•")).grid(row=0, column=2)
    remember_var = tk.BooleanVar(value=bool(cfg.get("vts_uri")))
    ttk.Checkbutton(top, text="Remember on this PC", variable=remember_var).grid(row=0, column=3, padx=6)
    try:
        atlas_label = f"Atlas ops database: {host_of(atlas_uri())}  (from backend/.env)"
    except Exception as e:  # noqa: BLE001
        atlas_label = f"Atlas ops database: not found — {e}"
    ttk.Label(top, text=atlas_label, foreground="#555").grid(row=1, column=1, sticky="w", padx=6, pady=(4, 0))
    top.columnconfigure(1, weight=1)

    # --- actions ---------------------------------------------------------------------------
    bar = ttk.Frame(root, padding=(10, 0, 10, 6))
    bar.pack(fill="x")
    create_var = tk.BooleanVar(value=True)
    dry_var = tk.BooleanVar(value=False)
    replace_var = tk.BooleanVar(value=False)
    b_scan = ttk.Button(bar, text="Scan for missing data")
    b_sessions = ttk.Button(bar, text="Import sessions")
    b_markers = ttk.Button(bar, text="Import markers")
    b_all = ttk.Button(bar, text="Import everything")
    b_stop = ttk.Button(bar, text="Stop")
    for i, b in enumerate((b_scan, b_sessions, b_markers, b_all, b_stop)):
        b.grid(row=0, column=i, padx=(0, 6))
    ttk.Checkbutton(bar, text="Create accounts for new VTS drivers", variable=create_var).grid(row=0, column=5, padx=8)
    ttk.Checkbutton(bar, text="Dry run (write nothing)", variable=dry_var).grid(row=0, column=6)
    ttk.Checkbutton(
        bar, variable=replace_var,
        text=f"Replace Atlas days where VTS has more km (over {int(REPLACE_MARGIN * 100)}% and {REPLACE_MIN_GAIN_KM:g} km) with VTS raw + cleaned",
    ).grid(row=1, column=0, columnspan=7, sticky="w", pady=(6, 0))
    status_var = tk.StringVar(value="Paste the VTS database connection string, then Scan.")
    ttk.Label(root, textvariable=status_var, padding=(10, 0, 10, 6), foreground="#0050a9").pack(fill="x")

    # --- tabs ------------------------------------------------------------------------------
    tabs = ttk.Notebook(root)
    tabs.pack(fill="both", expand=True, padx=10, pady=(0, 10))

    def table(parent, cols):
        frame = ttk.Frame(parent)
        tree = ttk.Treeview(frame, columns=[c for c, _, _ in cols], show="headings")
        for c, title, width in cols:
            tree.heading(c, text=title)
            tree.column(c, width=width, anchor="w" if c in ("driver", "status", "session", "plate") else "e" if c in ("km", "atlas_km", "vts_km", "diff") else "center")
        sb = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=sb.set)
        tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        return frame, tree

    s_frame, s_tree = table(tabs, [
        ("day", "Date", 90), ("driver", "Driver", 230), ("raw", "Raw GPS fixes", 100), ("cleaned", "Cleaned points", 105),
        ("km", "Session km", 80), ("atlas_km", "Atlas km (day)", 100), ("vts_km", "VTS km (day)", 95), ("diff", "VTS − Atlas", 85),
        ("plate", "Plate", 80), ("status", "What import does", 320), ("session", "VTS session", 180),
    ])
    m_frame, m_tree = table(tabs, [
        ("day", "Date", 90), ("driver", "Driver", 260), ("red", "Red", 60), ("yellow", "Yellow", 60), ("blue", "Blue", 60),
        ("green", "Green", 60), ("total", "Total", 60), ("status", "What import does", 380),
    ])
    log_frame = ttk.Frame(tabs)
    log_text = tk.Text(log_frame, wrap="none", font=("Consolas", 9))
    log_sb = ttk.Scrollbar(log_frame, orient="vertical", command=log_text.yview)
    log_text.configure(yscrollcommand=log_sb.set)
    log_text.pack(side="left", fill="both", expand=True)
    log_sb.pack(side="right", fill="y")
    tabs.add(s_frame, text="Sessions")
    tabs.add(m_frame, text="Markers")
    tabs.add(log_frame, text="Log")

    def log(line: str) -> None:
        log_text.insert("end", line.rstrip("\n") + "\n")
        log_text.see("end")

    # --- workers ---------------------------------------------------------------------------
    def vts_uri_or_warn() -> str | None:
        uri = vts_var.get().strip()
        if not uri.startswith("mongodb"):
            messagebox.showwarning("VTS database", "Paste the VTS database connection string (mongodb://…) first.")
            return None
        if remember_var.get():
            save_config({**load_config(), "vts_uri": uri})
        elif CONFIG.exists():
            save_config({k: v for k, v in load_config().items() if k != "vts_uri"})
        return uri

    def set_busy(on: bool) -> None:
        busy.set(on)
        for b in (b_scan, b_sessions, b_markers, b_all):
            b.state(["disabled"] if on else ["!disabled"])
        b_stop.state(["!disabled"] if on else ["disabled"])

    def start_scan() -> None:
        uri = vts_uri_or_warn()
        if not uri or busy.get():
            return
        set_busy(True)
        status_var.set("Scanning...")
        create = create_var.get()

        def work():
            try:
                result = scan(uri, create, say=lambda m: events.put(("status", m)))
                events.put(("scan", result))
            except Exception as e:  # noqa: BLE001
                events.put(("error", f"Scan failed: {e}"))
            events.put(("idle", None))

        threading.Thread(target=work, daemon=True).start()

    def run_steps(steps: list) -> None:
        """Run importer commands one after another, streaming their output, then scan again."""
        uri = vts_uri_or_warn()
        if not uri or busy.get():
            return
        node = shutil.which("node")
        if not node:
            messagebox.showerror("Node.js", "Node.js (node) was not found on PATH — the importers need it.")
            return
        set_busy(True)
        tabs.select(log_frame)
        env = {**os.environ, "VTS_MONGODB_URI": uri}

        def work():
            ctx: dict = {}
            for title, script, args in steps:
                if callable(args):
                    args = args(ctx)
                    if args is None:
                        events.put(("log", f"\n=== {title}: nothing to do ==="))
                        continue
                events.put(("log", f"\n=== {title} ({datetime.now():%H:%M:%S}) ==="))
                cmd = [node, script, *args]
                try:
                    proc = subprocess.Popen(
                        cmd, cwd=str(BACKEND), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        text=True, encoding="utf-8", errors="replace", bufsize=1,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                except Exception as e:  # noqa: BLE001
                    events.put(("log", f"Could not start: {e}"))
                    break
                proc_holder["proc"] = proc
                for line in proc.stdout:
                    if "MongoDB" in line and ("connected" in line or "disconnected" in line):
                        continue
                    m = re.search(r"as batch (vtsday-[\w-]+)", line)
                    if m:
                        ctx["vtsday"] = m.group(1)
                    events.put(("log", line))
                code = proc.wait()
                proc_holder["proc"] = None
                events.put(("log", f"=== {title}: {'finished' if code == 0 else f'stopped (exit {code})'} ==="))
                if code != 0:
                    break
            events.put(("rescan", None))

        threading.Thread(target=work, daemon=True).start()

    def session_step():
        args = ["src/seed/importVtsSessions.js", ["--from-db", "--concurrency=4"]]
        if create_var.get():
            args[1].append("--create-missing-drivers")
        if not dry_var.get():
            args[1].append("--apply")
        return ("Sessions: raw GPS + cleaned route", *args)

    def replace_steps() -> list:
        """Archive the Atlas days VTS has more of (restorable); the session import then fills them."""
        return [
            ("Replace: archive Atlas days where VTS has more km", "src/seed/replaceDaysWithVts.js",
             ["--from-db", f"--margin={REPLACE_MARGIN}", f"--min-gain-km={REPLACE_MIN_GAIN_KM}"] + ([] if dry_var.get() else ["--apply"])),
        ]

    def settle_step():
        return ("Replace: re-settle coverage around the replaced days", "src/seed/replaceDaysWithVts.js",
                lambda ctx: None if dry_var.get() or "vtsday" not in ctx else [f"--settle={ctx['vtsday']}", "--apply"])

    def sessions_chain() -> list:
        if not replace_var.get():
            return [session_step()]
        return [*replace_steps(), session_step(), settle_step()]

    def marker_step():
        return ("Markers", "src/seed/importVtsMarkers.js", [] if dry_var.get() else ["--apply"])

    def confirm(what: str) -> bool:
        if dry_var.get():
            return True
        extra = ("\n\nReplaced days: that day's Atlas trips are archived (not deleted) and can be restored with "
                 "the undo command in the log.") if replace_var.get() else ""
        return messagebox.askyesno("Import into Atlas ops", f"Import {what} into Atlas ops now?\n\nEverything is written under one batch id, shown at the end of the log with its undo command.{extra}")

    b_scan.configure(command=start_scan)
    b_sessions.configure(command=lambda: confirm("the missing sessions" + (", replacing the Atlas days where VTS has more km" if replace_var.get() else "")) and run_steps(sessions_chain()))
    b_markers.configure(command=lambda: confirm("the missing markers") and run_steps([marker_step()]))
    b_all.configure(command=lambda: confirm("the missing sessions" + (" (replacing the Atlas days where VTS has more km)" if replace_var.get() else "") + ", then markers") and run_steps([*sessions_chain(), marker_step()]))

    def stop():
        p = proc_holder.get("proc")
        if p and p.poll() is None:
            p.terminate()
            log("Stopping … (whatever finished stays in; a re-run continues where it left off)")

    b_stop.configure(command=stop)
    b_stop.state(["disabled"])

    # --- event pump ------------------------------------------------------------------------
    def show(result: dict) -> None:
        s_tree.delete(*s_tree.get_children())
        order = {READY: 0, NEW_DRIVER: 1, REPLACEABLE: 2, ACTIVE: 3, DAY_HAS_DATA: 4}
        for r in sorted(result["sessions"], key=lambda r: (order.get(r["status"], 9), r["day"], r["driver"])):
            fmt = lambda v: "—" if v is None else f"{v:,.1f}"
            diff = "—" if r["diff"] is None else f"{r['diff']:+,.1f}"
            tag = "vtsmore" if (r["diff"] or 0) > max(3, 0.1 * (r["atlas_km"] or 0)) else ""
            s_tree.insert("", "end", values=[r["day"], r["driver"], r["raw"], r["cleaned"], r["km"], fmt(r["atlas_km"]), fmt(r["vts_km"]), diff, r["plate"], r["status"], r["session"]], tags=(tag,))
        s_tree.tag_configure("vtsmore", background="#fff4e5")
        m_tree.delete(*m_tree.get_children())
        for r in result["markers"]:
            m_tree.insert("", "end", values=[r["day"], r["driver"], r["red"], r["yellow"], r["blue"], r["green"], r["total"], r["status"]])
        to_import = result["summary"].get(READY, 0) + result["summary"].get(NEW_DRIVER, 0)
        replaceable = result["summary"].get(REPLACEABLE, 0)
        ready_markers = sum(r["total"] for r in result["markers"] if r["status"] == READY)
        status_var.set(
            f"Sessions: {to_import} to import · {replaceable} could replace a fuller-on-VTS day · {len(result['sessions']) - to_import - replaceable} not imported (see reasons) · {result['already']} already in Atlas"
            f"      Markers: {result['missing_markers']} not in Atlas ({ready_markers} ready)"
        )
        tabs.select(s_frame)

    def pump():
        try:
            while True:
                kind, payload = events.get_nowait()
                if kind == "status":
                    status_var.set(payload)
                    log(payload)
                elif kind == "log":
                    log(payload)
                elif kind == "scan":
                    show(payload)
                elif kind == "error":
                    status_var.set(payload)
                    log(payload)
                    messagebox.showerror("VTS sync", payload)
                elif kind == "idle":
                    set_busy(False)
                elif kind == "rescan":
                    set_busy(False)
                    start_scan()
        except queue.Empty:
            pass
        root.after(150, pump)

    pump()
    if vts_var.get().strip():
        root.after(300, start_scan)
    root.mainloop()


def main() -> None:
    if "--scan" in sys.argv:
        uri = os.environ.get("VTS_MONGODB_URI") or load_config().get("vts_uri")
        if not uri:
            sys.exit("Set VTS_MONGODB_URI (or save it from the window) first.")
        r = scan(uri, create_accounts=True)
        for k, v in sorted(r["summary"].items(), key=lambda kv: -kv[1]):
            print(f"  {v:5}  {k}")
        print(f"  {r['already']:5}  already in Atlas")
        for row in r["sessions"]:
            if row["status"] in (DAY_HAS_DATA, REPLACEABLE):
                f = lambda v, sign="": "      —" if v is None else format(v, sign + "7.1f")
                print(f"    kept {row['day']}  {row['driver'][:26]:26}  Atlas {f(row['atlas_km'])} km   VTS {f(row['vts_km'])} km   diff {f(row['diff'], '+')}")
        for row in r["sessions"]:
            if row["status"] in (READY, NEW_DRIVER):
                print(f"    {row['day']}  {row['driver'][:28]:28}  raw {row['raw']:6}  cleaned {row['cleaned']:6}  {row['km']:7} km  {row['session']}")
        print(f"Markers not in Atlas: {r['missing_markers']}")
        for m in r["markers"][:40]:
            print(f"    {m['day']}  {m['driver'][:28]:28}  {m['total']:4}  {m['status']}")
        return
    run_window()


if __name__ == "__main__":
    main()
