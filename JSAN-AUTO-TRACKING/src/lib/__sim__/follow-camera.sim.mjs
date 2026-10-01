/**
 * Deterministic drives through the follow-mode rules (src/lib/followCamera.ts) — the logic that
 * decides whether the driver map moves with the vehicle.
 *
 * Imports the REAL module (Node 24 strips the types), so a case passing here passes against the
 * code the driver gets. Each scenario is a scripted drive: GPS fixes on a clock, and the driver's
 * hand on the map at chosen moments. Distances are authored in metres and converted to degrees
 * at Melbourne's latitude.
 *
 * Run: node src/lib/__sim__/follow-camera.sim.mjs
 */

import {
  createFollow, onFix, onGesture, isDriving, startFollowing, suspendForFraming, FOLLOW_RESUME_MS,
} from '../followCamera.ts';

const LAT0 = -38.03;
const LON0 = 145.25;
const M_LAT = 1 / 110_574;
const M_LON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
/** A point `east` / `north` metres from the origin. */
const at = (east, north = 0) => ({ lon: LON0 + east * M_LON, lat: LAT0 + north * M_LAT });

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS ✅' : 'FAIL ❌'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
}

/** Drive east at `kmh` for `seconds`, a fix every `everyS` s. Returns the camera actions. */
function drive(s, { from = 0, kmh = 40, seconds = 20, everyS = 2, t0 = 0, speedReported = true, accuracy = 8, placing = false }) {
  const actions = [];
  const ms = kmh / 3.6;
  let t = t0;
  let x = from;
  for (let i = 0; i <= seconds / everyS; i++) {
    const p = at(x);
    actions.push({ t, ...onFix(s, { ...p, speedKmh: speedReported ? kmh : 0, accuracy }, t, placing) });
    t += everyS * 1000;
    x += ms * everyS;
  }
  return { actions, t, x };
}

/** Parked: fixes wobbling a few metres around `x`, speed ~0. */
function park(s, { x = 0, seconds = 30, everyS = 5, t0 = 0, wobble = 4, accuracy = 10, spikeAt = -1 }) {
  const actions = [];
  let t = t0;
  for (let i = 0; i <= seconds / everyS; i++) {
    const p = at(x + (i % 2 ? wobble : -wobble), i % 3 ? wobble : -wobble);
    const kmh = i === spikeAt ? 12 : 0.4;
    actions.push({ t, ...onFix(s, { ...p, speedKmh: kmh, accuracy }, t, false) });
    t += everyS * 1000;
  }
  return { actions, t };
}

const kinds = (actions) => actions.map((a) => a.kind);
const count = (actions, kind) => actions.filter((a) => a.kind === kind).length;

// 1 ─ Following from the start: every fix of a drive moves the camera.
{
  const s = createFollow();
  const { actions } = drive(s, { kmh: 40, seconds: 60, everyS: 2 });
  check('following by default, every fix of a 40 km/h drive pans the camera',
    count(actions, 'pan') === actions.length, `${count(actions, 'pan')}/${actions.length} pans`);
  const last = actions[actions.length - 1];
  check('the camera ends where the car is', Math.abs(last.center[0] - at(40 / 3.6 * 60).lon) < 1e-9);
}

// 2 ─ A fix that did not move (traffic light) does not nudge the camera.
{
  const s = createFollow();
  onFix(s, { ...at(0), speedKmh: 30 }, 0, false);
  const same = onFix(s, { ...at(2), speedKmh: 0 }, 2000, false);
  check('a fix ~2 m from the last pan does not move the camera', same.kind === 'none');
}

// 3 ─ A pinch keeps following: the centre stays on the car.
{
  const s = createFollow();
  drive(s, { seconds: 10 });
  onGesture(s, s.lastPan, 11_000);
  check('a pinch (centre unmoved) does not suspend following', s.following === true);
  const next = onFix(s, { ...at(200), speedKmh: 40 }, 12_000, false);
  check('and the next fix still pans', next.kind === 'pan');
}

// 4 ─ The reported bug: a drag while driving used to stop following for good.
{
  const s = createFollow();
  const d1 = drive(s, { seconds: 10 });
  onGesture(s, [s.lastPan[0] + 0.01, s.lastPan[1]], d1.t);            // dragged ~800 m away
  check('a real drag suspends following', s.following === false);
  const during = drive(s, { from: d1.x, seconds: 8, t0: d1.t + 1000 });
  check('for the next 8 s the camera stays where the driver put it', count(during.actions, 'pan') + count(during.actions, 'resume') === 0,
    kinds(during.actions).join(','));
  const after = drive(s, { from: during.x, seconds: 10, t0: during.t });
  const firstResume = after.actions.find((a) => a.kind === 'resume');
  check(`once ${FOLLOW_RESUME_MS / 1000} s pass untouched, the camera takes the car back by itself`,
    Boolean(firstResume) && firstResume.t - d1.t >= FOLLOW_RESUME_MS && firstResume.t - d1.t <= FOLLOW_RESUME_MS + 2000,
    firstResume ? `resumed ${(firstResume.t - d1.t) / 1000} s after the drag` : 'never resumed');
  check('and keeps panning after that', after.actions.slice(after.actions.indexOf(firstResume) + 1).every((a) => a.kind === 'pan'));
}

// 5 ─ A driver still handling the map is not overridden.
{
  const s = createFollow();
  const d1 = drive(s, { seconds: 6 });
  let t = d1.t;
  let x = d1.x;
  let resumed = false;
  for (let i = 0; i < 10; i++) {
    onGesture(s, [s.lastPan ? s.lastPan[0] + 0.01 : LON0 + 0.01, LAT0], t);   // touching every 4 s
    const r = drive(s, { from: x, seconds: 4, everyS: 2, t0: t + 500 });
    if (r.actions.some((a) => a.kind !== 'none')) resumed = true;
    t = r.t; x = r.x;
  }
  check('touching the map every 4 s keeps the camera theirs for 40 s of driving', !resumed);
}

// 6 ─ Parked and looking around: never snaps back.
{
  const s = createFollow();
  park(s, { seconds: 10 });
  onGesture(s, [LON0 + 0.02, LAT0], 11_000);
  const p = park(s, { seconds: 120, t0: 12_000 });
  check('parked after a drag, two minutes of GPS wobble never take the camera back',
    count(p.actions, 'resume') + count(p.actions, 'pan') === 0);
}

// 7 ─ One speed spike while parked is not driving.
{
  const s = createFollow();
  onGesture(s, [LON0 + 0.02, LAT0], 0);
  s.following = false;
  const p = park(s, { seconds: 60, t0: 20_000, spikeAt: 4 });
  check('a single 12 km/h spike on a parked phone does not resume following', count(p.actions, 'resume') === 0);
}

// 8 ─ Handsets that report no speed at all still follow (position witness).
{
  const s = createFollow();
  suspendForFraming(s);
  const d = drive(s, { kmh: 45, seconds: 20, speedReported: false });
  const firstResume = d.actions.findIndex((a) => a.kind === 'resume');
  check('with speed always 0, a 45 km/h drive is still seen as driving and the camera follows',
    firstResume >= 0 && firstResume <= 2, `resumed at fix #${firstResume}`);
}

// 9 ─ Opened at the depot: the area is shown, and driving off hands the camera to the car at once.
{
  const s = createFollow();
  park(s, { seconds: 10 });
  suspendForFraming(s);
  const p = park(s, { seconds: 60, t0: 15_000 });
  check('framed on the area while parked, the frame holds', count(p.actions, 'resume') + count(p.actions, 'pan') === 0);
  const d = drive(s, { kmh: 30, seconds: 10, t0: p.t });
  const i = d.actions.findIndex((a) => a.kind === 'resume');
  check('driving off from the frame takes the car back without the 10 s wait', i >= 0 && d.actions[i].t - p.t <= 4000,
    i >= 0 ? `${(d.actions[i].t - p.t) / 1000} s after setting off` : 'never');
}

// 10 ─ Bad accuracy jitter is not travel.
{
  const s = createFollow();
  suspendForFraming(s);
  let resumed = 0;
  for (let i = 0; i < 20; i++) {
    const p = at(i % 2 ? 35 : -35);                                     // 70 m swings, 50 m accuracy
    if (onFix(s, { ...p, speedKmh: 0, accuracy: 50 }, i * 3000, false).kind === 'resume') resumed += 1;
  }
  check('70 m swings from a 50 m-accuracy fix are not read as driving', resumed === 0);
}

// 11 ─ Placing a marker holds the camera still, and following carries on after.
{
  const s = createFollow();
  drive(s, { seconds: 4 });
  const held = drive(s, { from: 100, seconds: 10, t0: 10_000, placing: true });
  check('while a marker is being placed the camera never moves', count(held.actions, 'none') === held.actions.length);
  startFollowing(s, s.lastPan);
  const after = drive(s, { from: held.x, seconds: 4, t0: held.t });
  check('after the drop, the camera follows again', count(after.actions, 'pan') >= 2);
}

// 12 ─ isDriving, for opening the tab mid-drive.
{
  const s = createFollow();
  const d = drive(s, { seconds: 10 });
  check('isDriving is true during a drive', isDriving(s, d.t - 1000));
  check('and goes false once fixes stop for 15 s+', !isDriving(s, d.t + 16_000));
  const p = createFollow();
  park(p, { seconds: 30 });
  check('a parked vehicle is not driving', !isDriving(p, 31_000));
}

// 13 ─ A fix after a long GPS gap does not count as instant travel.
{
  const s = createFollow();
  suspendForFraming(s);
  onFix(s, { ...at(0), speedKmh: 0 }, 0, false);
  const r1 = onFix(s, { ...at(500), speedKmh: 0 }, 60_000, false);   // a minute later, 500 m on
  check('a jump after a 60 s gap is not read as a moving fix', s.streak === 0 && r1.kind === 'none');
}

// 14 ─ Junk fixes are ignored.
{
  const s = createFollow();
  const r = onFix(s, { lon: NaN, lat: LAT0, speedKmh: 40 }, 0, false);
  check('a fix with no position does nothing and does not throw', r.kind === 'none' && s.prev === null);
}

console.log(failed ? `\n${failed} FOLLOW-CAMERA SCENARIO(S) FAILED` : '\nALL FOLLOW-CAMERA SCENARIOS PASS');
process.exit(failed ? 1 : 0);
