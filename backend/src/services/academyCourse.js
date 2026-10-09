/**
 * Driver Academy — the course, as the web portal (/academy on the panel) serves it.
 *
 * The same six lessons, ids and questions as the driver app's copy
 * (JSAN-AUTO-TRACKING/src/lib/academy.ts), so progress made on either counts on both. The app
 * carries its own copy because it must work offline; change one, change the other — a course
 * that disagrees with the app it teaches is worse than none.
 *
 * Questions are graded here, never in the browser: `correct` and `explain` are stripped from what
 * the portal receives, which is what makes the certificate worth something.
 */

const MAP = { todo: '#dc2626', done: '#2563eb', trace: '#059669', outside: '#f59e0b', history: '#6b7280' };

const DEFAULT_MARKER_CATS = [
  { name: 'Red Flag', color: '#ef4444', description: 'Tunnel, Traffic Accident, By Mistake, Underpass Road, Stopped by Police, Stopped by a Person, Due to Toll, Funeral Procession' },
  { name: 'Yellow Marker', color: '#fbbc04', description: 'Military Base, Private Area, Private Road, Private Property' },
  { name: 'Blue Marker', color: '#4285f4', description: 'Road Is Impassable, Low-Hanging Trees, Low-Hanging Cables' },
];

const LESSON_IDS = ['welcome', 'setup', 'map', 'markers', 'day', 'safety'];

function buildCourse(stopMinutes, cats) {
  const mins = typeof stopMinutes === 'number' && stopMinutes > 0 ? stopMinutes : 10;
  const flags = cats && cats.length ? cats : DEFAULT_MARKER_CATS;
  const cableAt = flags.findIndex((c) => /cable/i.test(`${c.name} ${c.description || ''}`));
  const cableFlag = cableAt >= 0 ? cableAt : Math.max(0, flags.findIndex((c) => /blue/i.test(c.name)));

  return [
    {
      id: 'welcome', title: 'How the app works', summary: 'Your drives are recorded by themselves',
      icon: 'car', color: '#7c3aed', minutes: 1,
      cards: [
        { title: 'No start button — it records by itself', body: 'Once you are signed in, the app watches for driving in the background. You never press Start or Stop: keep the phone with you in the vehicle and drive as normal.', tip: 'Stay signed in for the whole shift. Signing out stops your drives being recorded.', visual: { kind: 'icon', icon: 'mobile', color: '#7c3aed' } },
        { title: 'A trip starts when you drive off', body: 'When the vehicle moves off, a trip starts and the Dashboard turns green: "Trip in progress". Walking around with the phone does not start one.', visual: { kind: 'icon', icon: 'play-circle', color: '#059669' } },
        { title: `A trip ends after ${mins} minutes stopped`, body: `Traffic lights, queues and short stops do not end your trip. Once the vehicle has been stopped for ${mins} minutes, the trip closes by itself and is sent to the office.`, tip: `${mins} minutes is your project's setting — your manager can change it.`, visual: { kind: 'icon', icon: 'stop-circle', color: '#dc2626' } },
      ],
      question: { prompt: 'What do you need to press to record a trip?', options: ['Start at the beginning, Stop at the end', 'Nothing — it starts when I drive and ends when I stop', 'Start once at the beginning of the shift'], correct: 1, explain: `Nothing. A trip starts when the vehicle drives off and ends after ${mins} minutes stopped.` },
    },
    {
      id: 'setup', title: 'Keep tracking switched on', summary: 'Six phone settings that must stay on',
      icon: 'shield', color: '#059669', minutes: 2,
      cards: [
        { title: 'Six settings, all green', body: 'The app can only record if these stay on. You set them when you signed in; the Dashboard shows them in a checklist so you can see at a glance that all are green.', visual: { kind: 'checklist', rows: ['Precise location', 'Background location ("all the time")', 'Physical activity', 'Notifications', 'Battery optimisation off', 'Location (GPS) switched on'] } },
        { title: 'A red screen means: fix one setting', body: 'If a setting gets switched off — by you, by an update or by the phone itself — the app covers the screen and shows which one. Tap the button, switch it back on, and the screen goes away.', visual: { kind: 'icon', icon: 'exclamation-triangle', color: '#dc2626' } },
        { title: 'Do not let the phone put the app to sleep', body: 'Never swipe the app away from recent apps, and never turn battery saving back on for it. Some phones (Xiaomi, Oppo, Vivo, Samsung) also need "Autostart" allowed — the tips on the Dashboard show where.', tip: 'Keep the phone charging in the vehicle — GPS uses battery.', visual: { kind: 'icon', icon: 'battery-full', color: '#d97706' } },
      ],
      question: { prompt: 'Your phone offers to "optimise battery" for this app. What do you do?', options: ['Allow it — it saves battery', 'Say no — battery optimisation must stay off for this app', 'Allow it only at night'], correct: 1, explain: 'Say no. An "optimised" app is put to sleep by the phone, and your drives stop being recorded.' },
    },
    {
      id: 'map', title: 'Your map', summary: 'Your area, your roads and the buttons',
      icon: 'map', color: '#2563eb', minutes: 2,
      cards: [
        { title: 'What the colours mean', body: 'The My Map tab shows the area you are assigned and every road in it. Your job is to turn red roads blue.', visual: { kind: 'legend', rows: [{ color: MAP.todo, label: 'Red road — still to drive' }, { color: MAP.done, label: 'Blue road — already driven' }, { color: MAP.trace, label: 'Green line — your drive right now' }, { color: MAP.outside, label: 'Amber line — you are outside your area' }, { color: MAP.history, label: 'Grey line — your earlier trips' }] } },
        { title: 'The buttons on the right', body: 'Four buttons sit on the right-hand side of the map.', visual: { kind: 'buttons', rows: [{ icon: 'location-arrow', tint: '#2563eb', label: 'Back to me — the map follows the vehicle (blue while following)' }, { glyph: '⚑', tint: '#dc2626', label: 'Flag a problem spot (next lesson)' }, { glyph: '☰', label: 'Layers — show or hide the area, the roads and earlier trips' }, { icon: 'map-signs', tint: '#ffffff', bg: '#2563eb', label: 'Navigate to my area — opens Google Maps' }] } },
        { title: 'Roads turn blue as you drive them', body: 'A road you drive turns blue on your map straight away. The office confirms it after the trip ends, so the totals settle a few minutes later. Pull the panel at the bottom up to see your trip figures.', visual: { kind: 'icon', icon: 'road', color: MAP.done } },
      ],
      question: { prompt: 'A RED road on your map means…', options: ['The road is closed', 'You still need to drive it', 'You drove it too fast'], correct: 1, explain: 'Red is still to drive. Once you drive it, it turns blue.' },
    },
    {
      id: 'markers', title: 'Flag a problem spot', summary: 'Tell the office about a road you cannot drive',
      icon: 'flag', color: '#dc2626', minutes: 2,
      cards: [
        { title: 'Three flags — pick the colour', body: 'If you cannot drive a road, flag it so the office knows why. Each colour covers a group of reasons:', visual: { kind: 'legend', rows: flags.map((c) => ({ color: c.color, label: `${c.name}${c.description ? ` — ${c.description}` : ''}` })) } },
        { title: 'How to drop a flag', body: 'Only when the vehicle is safely stopped:', visual: { kind: 'steps', rows: ['Tap ⚑ on the map', 'Pick the colour', 'Move the map until the pin sits on the spot', 'Tap "Drop marker here"'] } },
        { title: 'No signal? It is saved', body: 'A flag dropped with no signal is kept on the phone and sent by itself when the signal comes back. It stays on your map in the meantime.', visual: { kind: 'icon', icon: 'wifi', color: '#64748b' } },
      ],
      question: { prompt: 'Low-hanging cables block the road. Which flag do you drop?', options: flags.map((c) => c.name), correct: cableFlag, explain: `${flags[cableFlag]?.name ?? 'Blue Marker'} — it covers ${flags[cableFlag]?.description ?? 'road is impassable, low-hanging trees and cables'}.` },
    },
    {
      id: 'day', title: 'Your day', summary: 'Working hours and offline driving',
      icon: 'clock-o', color: '#d97706', minutes: 1,
      cards: [
        { title: 'Working hours on the Dashboard', body: 'The Working hours card lists each trip — start, end, how long and how far — and the day’s total at the bottom. Use ‹ › to look at earlier days.', visual: { kind: 'legend', rows: [{ color: '#7c3aed', label: '13:28 – 14:12 · 44m · 12.0 km' }, { color: '#7c3aed', label: '15:00 – 16:30 · 1h 30m · 30.0 km' }, { color: '#5b21b6', label: 'Total · 2 trips · 2h 14m' }] } },
        { title: 'No signal is fine', body: 'The route is recorded on the phone even with no signal and uploads when the signal returns. The "Queued" number on the Dashboard is what is still waiting to upload — it goes back to 0 by itself.', tip: 'Pull down on the Dashboard to send everything now.', visual: { kind: 'icon', icon: 'refresh', color: '#d97706' } },
      ],
      question: { prompt: 'You drove through an area with no signal. What happens to that part of your route?', options: ['It is lost', 'It is saved on the phone and uploads when the signal returns', 'You must drive it again'], correct: 1, explain: 'Nothing is lost: the phone keeps it and uploads it as soon as it has signal.' },
    },
    {
      id: 'safety', title: 'Safety and help', summary: 'Drive safely, keep the app up to date',
      icon: 'life-ring', color: '#0891b2', minutes: 1,
      cards: [
        { title: 'Eyes on the road', body: 'Mount the phone; never type or tap while driving. The app needs nothing from you while you drive. Drop flags and check the map only when stopped.', visual: { kind: 'icon', icon: 'hand-paper-o', color: '#dc2626' } },
        { title: 'Install updates when asked', body: 'When a new version is needed, the app tells you and gives you the download. Install it straight away — your sign-in stays, you do not need to log in again.', visual: { kind: 'icon', icon: 'download', color: '#0891b2' } },
        { title: 'Something wrong?', body: 'Check the Dashboard first: the checklist shows any setting that is off, and the status card shows whether a trip is running. If it still looks wrong, contact your team lead or manager. You can open this course again from the Dashboard at any time.', visual: { kind: 'icon', icon: 'phone', color: '#059669' } },
      ],
      question: { prompt: 'When can you drop a flag on the map?', options: ['Any time, even while driving', 'Only when the vehicle is safely stopped', 'Only at the end of the day'], correct: 1, explain: 'Only when stopped. Nothing in the app needs you while you drive.' },
    },
  ];
}

/** What the browser receives: everything but the answers. */
function publicCourse(course) {
  return course.map((l) => ({
    ...l,
    question: { prompt: l.question.prompt, options: l.question.options },
  }));
}

module.exports = { buildCourse, publicCourse, LESSON_IDS, DEFAULT_MARKER_CATS };
