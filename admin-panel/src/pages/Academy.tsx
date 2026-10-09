import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { AppIcon } from '../components/AppIcon';
import { api, API_URL } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * Driver Academy on the web — the "how to use the app" course, as a portal a manager can hand to
 * any driver, with a certificate at the end.
 *
 *   /academy                      the link to share: what the course is, sign in to start
 *   /driver/academy               the course itself, in the driver portal
 *   /academy/certificate/:id      a certificate — public, printable, verifiable by its number
 *
 * The course comes from the server (backend/src/services/academyCourse.js) and answers are graded
 * there; the browser never sees them. Progress is the same record the driver app keeps, so a lesson
 * finished on the phone counts here and the other way round.
 */

type Visual =
  | { kind: 'icon'; icon: string; color: string }
  | { kind: 'legend'; rows: { color: string; label: string }[] }
  | { kind: 'buttons'; rows: { icon?: string; glyph?: string; tint?: string; bg?: string; label: string }[] }
  | { kind: 'checklist'; rows: string[] }
  | { kind: 'steps'; rows: string[] };
type Card = { title: string; body: string; tip?: string; visual: Visual };
type Lesson = {
  id: string; title: string; summary: string; icon: string; color: string; minutes: number;
  cards: Card[]; question: { prompt: string; options: string[] };
};
type Progress = { lessons: string[]; score: number | null; completedAt: string | null; certificateId: string | null };
type Certificate = {
  valid: boolean; certificateId: string; name: string; project: string | null; country: string | null;
  completedAt: string; score: number | null; lessons: number;
};

/** The app's icons (FontAwesome names) as glyphs the web can show without an icon font. */
const GLYPH: Record<string, string> = {
  car: '🚗', shield: '🛡️', map: '🗺️', flag: '🚩', 'clock-o': '⏱️', 'life-ring': '🛟',
  'play-circle': '▶️', 'stop-circle': '⏹️', mobile: '📱', 'exclamation-triangle': '⚠️',
  'battery-full': '🔋', road: '🛣️', wifi: '📶', 'hand-paper-o': '✋', download: '⬇️', phone: '📞',
  refresh: '🔄', 'location-arrow': '➤', 'map-signs': '🧭',
};

const shareUrl = () => `${window.location.origin}/academy`;
const certUrl = (id: string) => `${window.location.origin}/academy/certificate/${id}`;
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

const STYLE = `
.acad { --a-brand: #0050a9; --a-ink: #0f172a; --a-muted: #64748b; --a-line: #e2e8f0; --a-green: #059669; --a-red: #dc2626; }
.acad-wrap { max-width: 860px; margin: 0 auto; padding: 8px 4px 40px; }
.acad-hero { display: flex; gap: 18px; align-items: center; padding: 22px; border-radius: 20px; color: #fff;
  background: radial-gradient(ellipse at 0% 0%, #1b497b, transparent 60%), linear-gradient(135deg, #012f62, #0050a9); }
.acad-hero h1 { margin: 0; font-size: 26px; letter-spacing: -.5px; }
.acad-hero p { margin: 4px 0 0; opacity: .85; font-size: 14px; line-height: 1.5; }
.acad-cap { width: 58px; height: 58px; flex: 0 0 58px; border-radius: 16px; display: grid; place-items: center; background: #ffffff1f; }
.acad-bar { display: flex; align-items: center; gap: 12px; margin: 18px 0 10px; }
.acad-track { flex: 1; height: 9px; border-radius: 99px; background: #e5e7eb; overflow: hidden; }
.acad-fill { height: 100%; background: var(--a-green); border-radius: 99px; transition: width .3s; }
.acad-lessons { display: grid; gap: 10px; }
.acad-lesson { display: flex; align-items: center; gap: 14px; text-align: left; padding: 14px 16px; border-radius: 14px;
  background: #fff; border: 1.5px solid var(--a-line); cursor: pointer; font: inherit; color: inherit; width: 100%; }
.acad-lesson:hover { border-color: var(--a-brand); }
.acad-lesson.next { border-color: var(--a-brand); box-shadow: 0 0 0 3px #0050a914; }
.acad-licon { width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; font-size: 22px; flex: 0 0 44px; }
.acad-lt { font-weight: 700; font-size: 15px; }
.acad-ls { color: var(--a-muted); font-size: 12.5px; margin-top: 2px; }
.acad-done { color: var(--a-green); font-weight: 800; font-size: 13px; white-space: nowrap; }
.acad-btn { border: 0; border-radius: 12px; padding: 12px 20px; font: inherit; font-weight: 700; font-size: 14.5px; cursor: pointer;
  background: var(--a-brand); color: #fff; display: inline-flex; align-items: center; gap: 8px; text-decoration: none; }
.acad-btn:disabled { opacity: .45; cursor: default; }
.acad-btn.ghost { background: #fff; color: var(--a-ink); border: 1px solid var(--a-line); }
.acad-btn.green { background: var(--a-green); }
.acad-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
.acad-panel { background: #fff; border: 1px solid var(--a-line); border-radius: 18px; padding: 24px; }
.acad-dots { display: flex; gap: 6px; margin: 4px 0 22px; }
.acad-dot { flex: 1; height: 5px; border-radius: 99px; background: #e5e7eb; }
.acad-kicker { font-size: 11.5px; font-weight: 700; color: var(--a-muted); text-transform: uppercase; letter-spacing: .5px; }
.acad-card-title { font-size: 22px; font-weight: 800; letter-spacing: -.4px; margin: 6px 0 8px; color: var(--a-ink); }
.acad-body { font-size: 15.5px; line-height: 1.6; color: #334155; margin: 0; }
.acad-tip { margin-top: 16px; padding: 12px 14px; border-radius: 12px; background: #fffbeb; border: 1px solid #fde68a; color: #92400e; font-size: 14px; }
.acad-big { width: 104px; height: 104px; border-radius: 30px; display: grid; place-items: center; font-size: 50px; margin: 4px auto 18px; }
.acad-vis { border: 1px solid var(--a-line); border-radius: 14px; padding: 8px 14px; margin-bottom: 18px; background: #f8fafc; }
.acad-row { display: flex; align-items: center; gap: 12px; padding: 7px 0; font-size: 14.5px; }
.acad-swatch { width: 28px; height: 6px; border-radius: 99px; flex: 0 0 28px; }
.acad-mock { width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; background: #fff; border: 1px solid var(--a-line); box-shadow: 0 1px 3px #0001; flex: 0 0 38px; font-size: 17px; }
.acad-num { width: 26px; height: 26px; border-radius: 99px; display: grid; place-items: center; background: #e0ecff; color: var(--a-brand); font-weight: 800; font-size: 13px; flex: 0 0 26px; }
.acad-opt { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 14px 16px; margin-bottom: 10px; border-radius: 12px;
  border: 1.5px solid var(--a-line); background: #fff; font: inherit; font-size: 15px; cursor: pointer; color: var(--a-ink); }
.acad-opt:hover:not(:disabled) { border-color: var(--a-brand); }
.acad-opt.right { border-color: var(--a-green); background: #ecfdf5; }
.acad-opt.wrong { border-color: var(--a-red); background: #fef2f2; }
.acad-radio { width: 20px; height: 20px; border-radius: 99px; border: 2px solid #cbd5e1; flex: 0 0 20px; display: grid; place-items: center; font-size: 12px; font-weight: 900; }
.acad-feedback { padding: 12px 14px; border-radius: 12px; font-size: 14.5px; margin-top: 4px; }
.acad-nav { display: flex; justify-content: space-between; gap: 10px; margin-top: 24px; }
.acad-share { display: flex; gap: 8px; margin-top: 10px; }
.acad-share input { flex: 1; min-width: 0; font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--a-line); background: #f8fafc; }
@media (max-width: 640px) { .acad-hero { flex-direction: column; align-items: flex-start; } .acad-panel { padding: 18px; } }

/* ── Certificate ── */
.cert-page { min-height: 100vh; background: #eef2f7; padding: 24px 12px 40px; }
.cert-tools { max-width: 1000px; margin: 0 auto 14px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; justify-content: space-between; }
.cert { max-width: 1000px; margin: 0 auto; aspect-ratio: 297 / 210; background: #fffdf7; position: relative; padding: 22px;
  box-shadow: 0 20px 60px #0f172a26; color: #0f172a; font-family: Georgia, 'Times New Roman', serif; }
.cert-frame { position: absolute; inset: 18px; border: 3px solid #0050a9; outline: 1px solid #c9a227; outline-offset: -10px; }
.cert-in { position: relative; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 4% 9%; }
.cert-logo { height: 46px; margin-bottom: 2%; }
.cert-kicker { letter-spacing: .32em; font-size: clamp(10px, 1.3vw, 13px); color: #0050a9; font-family: system-ui, sans-serif; font-weight: 700; }
.cert-title { font-size: clamp(22px, 4.4vw, 44px); margin: 1% 0 0; color: #0f172a; letter-spacing: .02em; }
.cert-rule { width: 120px; height: 2px; background: #c9a227; margin: 2.2% auto; }
.cert-small { font-size: clamp(11px, 1.5vw, 16px); color: #475569; font-style: italic; }
.cert-name { font-size: clamp(26px, 5.4vw, 56px); margin: 1% 0; color: #012f62; border-bottom: 1px solid #cbd5e1; padding: 0 4% 1%; }
.cert-text { font-size: clamp(11px, 1.55vw, 16.5px); line-height: 1.55; color: #334155; max-width: 760px; }
.cert-meta { display: flex; gap: 6%; margin-top: 3.2%; font-family: system-ui, sans-serif; font-size: clamp(9px, 1.2vw, 12.5px); color: #475569; flex-wrap: wrap; justify-content: center; }
.cert-meta b { display: block; color: #0f172a; font-size: clamp(11px, 1.45vw, 15px); margin-top: 2px; }
.cert-seal { position: absolute; right: 7%; bottom: 10%; width: clamp(64px, 11vw, 110px); aspect-ratio: 1; border-radius: 50%;
  background: radial-gradient(circle, #e6c65c, #c9a227); color: #5a4300; display: grid; place-items: center; text-align: center;
  font-family: system-ui, sans-serif; font-weight: 900; font-size: clamp(8px, 1.1vw, 11px); letter-spacing: .08em; box-shadow: inset 0 0 0 4px #fff6, 0 4px 12px #0003; }
.cert-sign { position: absolute; left: 9%; bottom: 10%; text-align: left; font-family: system-ui, sans-serif; font-size: clamp(9px, 1.15vw, 12px); color: #475569; }
.cert-sign b { display: block; font-family: Georgia, serif; font-size: clamp(12px, 1.6vw, 17px); color: #0f172a; border-top: 1px solid #94a3b8; padding-top: 4px; margin-top: 18px; min-width: 180px; }
.cert-verify { position: absolute; left: 0; right: 0; bottom: 4.2%; text-align: center; font-family: system-ui, sans-serif; font-size: clamp(8px, 1vw, 11px); color: #64748b; }
@media print {
  @page { size: A4 landscape; margin: 0; }
  body * { visibility: hidden; }
  .cert, .cert * { visibility: visible; }
  .cert { position: fixed; inset: 0; max-width: none; width: 100vw; height: 100vh; box-shadow: none; aspect-ratio: auto; margin: 0; }
  .cert-page { padding: 0; background: #fff; }
}
`;

/* ─────────────────────────────── /academy — the link a manager shares ─────────────────────────────── */

export function AcademyLanding() {
  const { user, loading, signOut } = useAuth();
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  if (loading) return <div className="center-screen">Loading…</div>;
  if (user?.role === 'user') return <Navigate to="/driver/academy" replace />;
  const staff = Boolean(user);
  return (
    <div className="acad cert-page">
      <style>{STYLE}</style>
      <div className="acad-wrap">
        <div className="acad-hero">
          <div className="acad-cap"><AppIcon name="academy" size={30} /></div>
          <div>
            <h1>JSAN Driver Academy</h1>
            <p>Six short lessons on how the JSAN tracking app works — about 9 minutes. Pass every quick check and you get a certificate with your name on it.</p>
          </div>
        </div>
        <div className="acad-panel" style={{ marginTop: 16 }}>
          {staff ? (
            <>
              <div className="acad-kicker">For managers</div>
              <h2 className="acad-card-title" style={{ fontSize: 19 }}>Give this link to your drivers</h2>
              <p className="acad-body">
                Drivers open it on a phone or computer and sign in with the same email and password as the driver app.
                Lessons they finish here or in the app count in both, and on the Drivers page the Academy column shows who has finished and opens their certificate.
              </p>
              <div className="acad-share">
                <input readOnly value={shareUrl()} onFocus={(e) => e.currentTarget.select()} />
                <button className="acad-btn" onClick={() => { navigator.clipboard?.writeText(shareUrl()).then(() => setCopied(true)).catch(() => {}); }}>
                  {copied ? 'Copied ✓' : 'Copy link'}
                </button>
              </div>
              {/* A manager wants to see the course too — and the driver sign-in is a different account,
                  so this signs the manager out first rather than hiding the button behind that step. */}
              <div className="acad-actions">
                <button className="acad-btn ghost" onClick={() => { signOut(); navigate('/login?next=/driver/academy', { replace: true }); }}>
                  Try it as a driver — signs you out, then sign in with a driver account
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="acad-kicker">For drivers</div>
              <h2 className="acad-card-title" style={{ fontSize: 19 }}>Sign in with your driver app account</h2>
              <p className="acad-body">Use the same email and password you use in the JSAN driver app. Your progress is saved, so you can stop and carry on later.</p>
              <div className="acad-actions">
                <Link className="acad-btn" to="/login?next=/driver/academy">Sign in and start</Link>
              </div>
            </>
          )}
        </div>
        <div className="acad-lessons" style={{ marginTop: 16 }}>
          {['How the app works', 'Keep tracking switched on', 'Your map', 'Flag a problem spot', 'Your day', 'Safety and help'].map((t, i) => (
            <div key={t} className="acad-lesson" style={{ cursor: 'default' }}>
              <div className="acad-licon" style={{ background: '#0050a914' }}>{['🚗', '🛡️', '🗺️', '🚩', '⏱️', '🛟'][i]}</div>
              <div className="acad-lt">{i + 1}. {t}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────── /driver/academy — the course ─────────────────────────────── */

type View = { kind: 'overview' } | { kind: 'lesson'; index: number; step: number } | { kind: 'done' };

export function DriverAcademy() {
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [name, setName] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'overview' });
  const [picked, setPicked] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<{ correct: boolean; explain: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ name: string; lessons: Lesson[]; progress: Progress }>('/api/academy/course')
      .then((r) => { setLessons(r.lessons); setName(r.name); setProgress(r.progress); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the course'));
  }, []);

  const open = useCallback((index: number) => {
    setPicked(null); setVerdict(null);
    setView({ kind: 'lesson', index, step: 0 });
    window.scrollTo({ top: 0 });
  }, []);

  if (error) return <div className="acad"><style>{STYLE}</style><div className="acad-wrap"><div className="acad-panel">{error}</div></div></div>;
  if (!lessons || !progress) return <div className="center-screen">Loading the course…</div>;

  const done = new Set(progress.lessons);
  const doneCount = lessons.filter((l) => done.has(l.id)).length;
  const nextIndex = Math.max(0, lessons.findIndex((l) => !done.has(l.id)));
  const finished = Boolean(progress.completedAt && progress.certificateId);

  const answer = async (lesson: Lesson, choice: number) => {
    setBusy(true); setPicked(choice);
    try {
      const r = await api.post<{ correct: boolean; explain: string | null; progress: Progress }>('/api/academy/answer', { lessonId: lesson.id, choice });
      setVerdict({ correct: r.correct, explain: r.explain });
      setProgress(r.progress);
    } catch (e) {
      setVerdict({ correct: false, explain: e instanceof Error ? e.message : 'Could not check the answer — try again' });
    } finally {
      setBusy(false);
    }
  };

  if (view.kind === 'done') {
    return (
      <div className="acad"><style>{STYLE}</style>
        <div className="acad-wrap">
          <div className="acad-panel" style={{ textAlign: 'center', padding: 36 }}>
            <div className="acad-big" style={{ background: '#ecfdf5' }}>🏆</div>
            <h2 className="acad-card-title">Well done, {name.split(' ')[0]} — you are certified</h2>
            <p className="acad-body">
              All {lessons.length} lessons done{progress.score != null ? ` · ${progress.score}% right first time` : ''}. Your certificate is ready.
            </p>
            <div className="acad-actions" style={{ justifyContent: 'center' }}>
              {progress.certificateId && <Link className="acad-btn green" to={`/academy/certificate/${progress.certificateId}`}>View my certificate</Link>}
              <button className="acad-btn ghost" onClick={() => setView({ kind: 'overview' })}>Back to the lessons</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view.kind === 'lesson') {
    const lesson = lessons[view.index];
    const onQuestion = view.step >= lesson.cards.length;
    const total = lesson.cards.length + 1;
    const card = lesson.cards[view.step];
    const passed = Boolean(verdict?.correct);
    return (
      <div className="acad"><style>{STYLE}</style>
        <div className="acad-wrap">
          <div className="acad-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
              <div>
                <div className="acad-kicker">Lesson {view.index + 1} of {lessons.length}</div>
                <div style={{ fontWeight: 800, fontSize: 17 }}>{lesson.title}</div>
              </div>
              <button className="acad-btn ghost" onClick={() => setView({ kind: 'overview' })}>All lessons</button>
            </div>
            <div className="acad-dots" style={{ marginTop: 14 }}>
              {Array.from({ length: total }).map((_, i) => (
                <div key={i} className="acad-dot" style={i <= view.step ? { background: lesson.color } : undefined} />
              ))}
            </div>

            {!onQuestion ? (
              <div>
                <VisualView v={card.visual} />
                <h2 className="acad-card-title">{card.title}</h2>
                <p className="acad-body">{card.body}</p>
                {card.tip && <div className="acad-tip">💡 {card.tip}</div>}
              </div>
            ) : (
              <div>
                <div className="acad-kicker" style={{ color: lesson.color }}>🎓 Quick check</div>
                <h2 className="acad-card-title">{lesson.question.prompt}</h2>
                {lesson.question.options.map((opt, i) => {
                  const chosen = picked === i;
                  const cls = chosen && verdict ? (verdict.correct ? ' right' : ' wrong') : '';
                  return (
                    <button key={i} className={`acad-opt${cls}`} disabled={busy || Boolean(verdict?.correct)} onClick={() => answer(lesson, i)}>
                      <span className="acad-radio" style={cls ? { borderColor: verdict!.correct ? '#059669' : '#dc2626', color: verdict!.correct ? '#059669' : '#dc2626' } : undefined}>
                        {cls === ' right' ? '✓' : cls === ' wrong' ? '✕' : ''}
                      </span>
                      {opt}
                    </button>
                  );
                })}
                {verdict && (
                  <div className="acad-feedback" style={{ background: verdict.correct ? '#ecfdf5' : '#fef2f2', color: verdict.correct ? '#065f46' : '#991b1b' }}>
                    <b>{verdict.correct ? 'Correct! ' : 'Not quite — try again. '}</b>{verdict.correct ? verdict.explain : ''}
                  </div>
                )}
              </div>
            )}

            <div className="acad-nav">
              <button className="acad-btn ghost" disabled={view.step === 0} onClick={() => { setPicked(null); setVerdict(null); setView({ ...view, step: view.step - 1 }); }}>‹ Back</button>
              {!onQuestion ? (
                <button className="acad-btn" style={{ background: lesson.color }} onClick={() => setView({ ...view, step: view.step + 1 })}>
                  {view.step === lesson.cards.length - 1 ? 'Quick check ›' : 'Next ›'}
                </button>
              ) : (
                <button
                  className="acad-btn green"
                  disabled={!passed}
                  onClick={() => {
                    if (progress.completedAt && progress.certificateId && lessons.every((l) => progress.lessons.includes(l.id))) {
                      setView({ kind: 'done' });
                      return;
                    }
                    const next = lessons.findIndex((l) => !progress.lessons.includes(l.id));
                    if (next >= 0) open(next); else setView({ kind: 'overview' });
                  }}
                >
                  {lessons.every((l) => progress.lessons.includes(l.id)) ? 'Finish ›' : 'Next lesson ›'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* overview */
  const pct = Math.round((doneCount / lessons.length) * 100);
  return (
    <div className="acad"><style>{STYLE}</style>
      <div className="acad-wrap">
        <div className="acad-hero">
          <div className="acad-cap"><AppIcon name="academy" size={30} /></div>
          <div>
            <h1>Driver Academy</h1>
            <p>
              {finished
                ? 'Course finished — your certificate is below. Open any lesson to refresh your memory.'
                : `Welcome, ${name.split(' ')[0]}! ${lessons.length} short lessons on how the app works — about ${lessons.reduce((a, l) => a + l.minutes, 0)} minutes. Pass each quick check to earn your certificate.`}
            </p>
          </div>
        </div>
        <div className="acad-bar">
          <div className="acad-track"><div className="acad-fill" style={{ width: `${pct}%` }} /></div>
          <b style={{ fontSize: 13.5 }}>{doneCount}/{lessons.length}</b>
        </div>
        <div className="acad-lessons">
          {lessons.map((l, i) => (
            <button key={l.id} className={`acad-lesson${!finished && i === nextIndex ? ' next' : ''}`} onClick={() => open(i)}>
              <div className="acad-licon" style={{ background: `${l.color}1a` }}>{GLYPH[l.icon] ?? '📘'}</div>
              <div style={{ flex: 1 }}>
                <div className="acad-lt">{i + 1}. {l.title}</div>
                <div className="acad-ls">{l.summary} · {l.minutes} min</div>
              </div>
              {done.has(l.id) ? <span className="acad-done">✓ Done</span> : <span style={{ color: '#94a3b8' }}>›</span>}
            </button>
          ))}
        </div>
        <div className="acad-actions">
          {finished && progress.certificateId ? (
            <Link className="acad-btn green" to={`/academy/certificate/${progress.certificateId}`}>🏅 View my certificate</Link>
          ) : (
            <button className="acad-btn" onClick={() => open(nextIndex)}>{doneCount === 0 ? 'Start the course' : 'Continue'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

function VisualView({ v }: { v: Visual }) {
  if (v.kind === 'icon') {
    return <div className="acad-big" style={{ background: `${v.color}1a` }}>{GLYPH[v.icon] ?? '📘'}</div>;
  }
  if (v.kind === 'legend') {
    return (
      <div className="acad-vis">
        {v.rows.map((r, i) => (
          <div key={i} className="acad-row"><span className="acad-swatch" style={{ background: r.color }} />{r.label}</div>
        ))}
      </div>
    );
  }
  if (v.kind === 'buttons') {
    return (
      <div className="acad-vis">
        {v.rows.map((r, i) => (
          <div key={i} className="acad-row">
            <span className="acad-mock" style={{ color: r.tint ?? '#0f172a', ...(r.bg ? { background: r.bg, borderColor: r.bg } : {}) }}>
              {r.glyph ?? GLYPH[r.icon ?? ''] ?? '•'}
            </span>
            {r.label}
          </div>
        ))}
      </div>
    );
  }
  if (v.kind === 'checklist') {
    return (
      <div className="acad-vis">
        {v.rows.map((r, i) => <div key={i} className="acad-row"><span style={{ color: '#059669', fontWeight: 900 }}>✓</span>{r}</div>)}
      </div>
    );
  }
  return (
    <div className="acad-vis">
      {v.rows.map((r, i) => <div key={i} className="acad-row"><span className="acad-num">{i + 1}</span>{r}</div>)}
    </div>
  );
}

/* ─────────────────────────────── /academy/certificate/:id ─────────────────────────────── */

export function AcademyCertificate() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [cert, setCert] = useState<Certificate | null>(null);
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Public: no sign-in, so a plain fetch rather than the panel's authenticated client.
    fetch(`${API_URL}/api/academy/certificate/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('not found'))))
      .then((c: Certificate) => setCert(c))
      .catch(() => setMissing(true));
  }, [id]);

  useEffect(() => {
    if (cert) document.title = `Certificate — ${cert.name} · JSAN Driver Academy`;
  }, [cert]);

  if (missing) {
    return (
      <div className="acad cert-page"><style>{STYLE}</style>
        <div className="acad-wrap"><div className="acad-panel" style={{ textAlign: 'center' }}>
          <div className="acad-big" style={{ background: '#fef2f2' }}>❌</div>
          <h2 className="acad-card-title">No certificate with this number</h2>
          <p className="acad-body">“{id}” is not a valid JSAN Driver Academy certificate. Check the number and try again.</p>
        </div></div>
      </div>
    );
  }
  if (!cert) return <div className="center-screen">Checking the certificate…</div>;

  return (
    <div className="acad cert-page"><style>{STYLE}</style>
      <div className="cert-tools">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#065f46', fontWeight: 700, fontFamily: 'system-ui' }}>
          ✓ Verified certificate · {cert.certificateId}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="acad-btn ghost" onClick={() => { navigator.clipboard?.writeText(certUrl(cert.certificateId)).then(() => setCopied(true)).catch(() => {}); }}>
            {copied ? 'Link copied ✓' : 'Copy link'}
          </button>
          <button className="acad-btn" onClick={() => window.print()}>Print / Save as PDF</button>
          {window.history.length > 1 && <button className="acad-btn ghost" onClick={() => navigate(-1)}>Back</button>}
        </div>
      </div>

      <div className="cert">
        <div className="cert-frame" />
        <div className="cert-in">
          <img className="cert-logo" src="/brand/logo.png" alt="JSAN" />
          <div className="cert-kicker">JSAN ATLAS OPS · DRIVER ACADEMY</div>
          <h1 className="cert-title">Certificate of Completion</h1>
          <div className="cert-rule" />
          <div className="cert-small">This is to certify that</div>
          <div className="cert-name">{cert.name}</div>
          <p className="cert-text">
            has successfully completed all {cert.lessons} lessons of the JSAN Driver Academy and has shown a working knowledge of the
            JSAN vehicle-tracking app — automatic trip recording, keeping tracking switched on, the driver map, flagging
            problem spots, working hours, and safe use on the road.
          </p>
          <div className="cert-meta">
            <div>Date of completion<b>{fmtDate(cert.completedAt)}</b></div>
            {/* The first-try score is for the manager (Drivers page); a pass is a pass on the certificate. */}
            {cert.project && <div>Project<b>{cert.project}</b></div>}
            <div>Certificate no.<b>{cert.certificateId}</b></div>
          </div>
        </div>
        <div className="cert-sign">
          <b>JSAN Consulting Ltd</b>
          Atlas Ops · Driver Academy
        </div>
        <div className="cert-seal">JSAN<br />VERIFIED<br />✓</div>
        <div className="cert-verify">Verify this certificate at {certUrl(cert.certificateId)}</div>
      </div>
    </div>
  );
}
