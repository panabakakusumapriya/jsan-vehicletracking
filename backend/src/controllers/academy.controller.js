const crypto = require('crypto');
const User = require('../models/User');
const Project = require('../models/Project');
const MarkerCategory = require('../models/MarkerCategory');
const asyncHandler = require('../utils/asyncHandler');
const { buildCourse, publicCourse, LESSON_IDS } = require('../services/academyCourse');

/**
 * Driver Academy on the web — the portal at /academy on the panel, which a manager can hand to any
 * driver. Drivers sign in with their app account; progress is the same record the app writes
 * (User.academy), so a lesson done on either counts on both.
 *
 * Finishing all six lessons issues a certificate: a number on the account, printed on the
 * certificate, and checkable by anyone at GET /api/academy/certificate/:id.
 */

/** Unambiguous characters only — the number gets read aloud and typed in. */
const CERT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCertificateId() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += CERT_ALPHABET[b % CERT_ALPHABET.length];
  return `JSAN-${s.slice(0, 4)}-${s.slice(4)}`;
}

/** % of finished lessons answered right first time (app: self-reported `score`; web: graded). */
function scoreFrom(a) {
  const done = a.lessons || [];
  if (!done.length) return null;
  const wrong = new Set(a.firstWrong || []);
  return Math.round((done.filter((l) => !wrong.has(l)).length / done.length) * 100);
}

/**
 * Stamp completion and the certificate number once all lessons are done. Shared with the app's
 * PUT /api/tracking/my-academy so a course finished on the phone is certified too.
 */
function certify(academy) {
  const done = new Set(academy.lessons || []);
  if (LESSON_IDS.every((id) => done.has(id))) {
    if (!academy.completedAt) academy.completedAt = new Date();
    if (!academy.certificateId) academy.certificateId = newCertificateId();
  }
  return academy;
}

function progressOf(user) {
  const a = user.academy || {};
  return {
    lessons: a.lessons || [],
    score: a.score ?? scoreFrom(a),
    completedAt: a.completedAt || null,
    certificateId: a.certificateId || null,
  };
}

async function courseFor(user) {
  let stop = null;
  const pid = (user.projectIds || [])[0];
  if (pid) {
    const p = await Project.findById(pid._id || pid).select('tripEndAfterMinutes');
    if (p && typeof p.tripEndAfterMinutes === 'number') stop = p.tripEndAfterMinutes;
  }
  const cats = await MarkerCategory.find({ active: true }).sort({ order: 1, createdAt: 1 }).select('name color description');
  return buildCourse(stop, cats.map((c) => ({ name: c.name, color: c.color, description: c.description })));
}

// GET /api/academy/course  (driver)
exports.course = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  res.json({ name: user.name, lessons: publicCourse(await courseFor(user)), progress: progressOf(user) });
});

// POST /api/academy/answer  (driver)  { lessonId, choice }
exports.answer = asyncHandler(async (req, res) => {
  const { lessonId, choice } = req.body || {};
  const user = await User.findById(req.user._id);
  const lesson = (await courseFor(user)).find((l) => l.id === lessonId);
  if (!lesson) return res.status(400).json({ error: 'Unknown lesson' });
  if (!Number.isInteger(choice) || choice < 0 || choice >= lesson.question.options.length) {
    return res.status(400).json({ error: 'choice must be one of the options' });
  }
  const a = { ...(user.toObject().academy || {}) };
  a.lessons = [...(a.lessons || [])];
  a.firstWrong = [...(a.firstWrong || [])];
  const correct = choice === lesson.question.correct;
  const already = a.lessons.includes(lesson.id);
  if (!correct && !already && !a.firstWrong.includes(lesson.id)) a.firstWrong.push(lesson.id);
  if (correct && !already) a.lessons.push(lesson.id);
  // The graded score replaces any self-reported one once the web has graded every finished lesson.
  a.score = scoreFrom(a);
  certify(a);
  user.academy = a;
  await user.save();
  res.json({ correct, explain: correct ? lesson.question.explain : null, progress: progressOf(user) });
});

// GET /api/academy/certificate/:id  (public — anyone holding the number can check it)
exports.certificate = asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').toUpperCase();
  if (!/^JSAN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(id)) return res.status(404).json({ valid: false });
  const user = await User.findOne({ 'academy.certificateId': id }).select('name project country academy active');
  if (!user || !user.academy?.completedAt) return res.status(404).json({ valid: false });
  res.json({
    valid: true,
    certificateId: id,
    name: user.name,
    project: user.project || null,
    country: user.country || null,
    completedAt: user.academy.completedAt,
    score: user.academy.score ?? scoreFrom(user.academy),
    lessons: LESSON_IDS.length,
  });
});

exports.certify = certify;
