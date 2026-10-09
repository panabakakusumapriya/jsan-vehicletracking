import FontAwesome from '@expo/vector-icons/FontAwesome';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  buildCourse, loadProgress, saveProgress, scoreOf, syncProgress,
  type AcademyProgress, type Card, type Lesson, type MarkerCat, type Visual,
} from '@/src/lib/academy';
import { apiMarkerCategories } from '@/src/lib/api';
import { useAuth } from '@/src/lib/auth';

/**
 * Driver Academy — see src/lib/academy.ts for the course and how progress is kept.
 *
 * Three views: the course overview (lessons, progress, Start / Continue), a lesson (its cards, then
 * its question), and the finish screen. Opened by itself once after a driver's first login, and
 * from the Dashboard card any time after.
 */

const C = {
  brand: '#7c3aed',
  brandDeep: '#5b21b6',
  brandSoft: '#ede9fe',
  bg: '#f7f7fb',
  surface: '#ffffff',
  border: '#e9ecf0',
  text: '#0d0d12',
  text2: '#374151',
  muted: '#9ca3af',
  green: '#059669',
  greenBg: '#ecfdf5',
  red: '#dc2626',
  redBg: '#fef2f2',
};

type View_ =
  | { kind: 'overview' }
  | { kind: 'lesson'; index: number; step: number }
  | { kind: 'done' };

export default function Academy() {
  const { user, token, refreshUser } = useAuth();
  const insets = useSafeAreaInsets();
  const [progress, setProgress] = useState<AcademyProgress>(() => loadProgress(user));
  const [cats, setCats] = useState<MarkerCat[]>([]);
  const [view, setView] = useState<View_>({ kind: 'overview' });
  /** The option picked on the current question, and whether it was this lesson's first try. */
  const [picked, setPicked] = useState<number | null>(null);
  const [triedWrong, setTriedWrong] = useState(false);

  // The flags as the admins defined them, so the marker lesson shows the real list.
  useEffect(() => {
    if (!token) return;
    apiMarkerCategories(token)
      .then((r) => setCats(r.categories.filter((c) => c.active !== false)))
      .catch(() => { /* the built-in list is used */ });
  }, [token]);

  const course = useMemo(() => buildCourse(user?.tripEndAfterMinutes, cats), [user?.tripEndAfterMinutes, cats]);
  const doneCount = course.filter((l) => progress.done.includes(l.id)).length;
  const nextIndex = Math.max(0, course.findIndex((l) => !progress.done.includes(l.id)));

  const update = useCallback((next: AcademyProgress) => {
    setProgress(next);
    if (user) saveProgress(user._id, next);
    // The account copy follows; refreshing the user keeps the Dashboard card in step.
    void syncProgress(token, next).then(() => refreshUser().catch(() => {}));
  }, [user, token, refreshUser]);

  const leave = useCallback(() => {
    // Leaving an unfinished course is "skip for now": it stops opening by itself, and stays on
    // the Dashboard to pick up later.
    if (!progress.completedAt && !progress.skippedAt) update({ ...progress, skippedAt: new Date().toISOString() });
    if (router.canGoBack()) router.back();
    else router.replace('/home');
  }, [progress, update]);

  const openLesson = (index: number) => {
    setPicked(null);
    setTriedWrong(false);
    setView({ kind: 'lesson', index, step: 0 });
  };

  // Android back: a lesson steps back, the overview leaves.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (view.kind === 'lesson') {
        if (view.step > 0) setView({ ...view, step: view.step - 1 });
        else setView({ kind: 'overview' });
        return true;
      }
      if (view.kind === 'done') { setView({ kind: 'overview' }); return true; }
      leave();
      return true;
    });
    return () => sub.remove();
  }, [view, leave]);

  const finishLesson = (lesson: Lesson) => {
    const done = progress.done.includes(lesson.id) ? progress.done : [...progress.done, lesson.id];
    const firstTry = lesson.id in progress.firstTry ? progress.firstTry : { ...progress.firstTry, [lesson.id]: !triedWrong };
    const all = course.every((l) => done.includes(l.id));
    update({ ...progress, done, firstTry, completedAt: progress.completedAt || (all ? new Date().toISOString() : undefined) });
    if (all) setView({ kind: 'done' });
    else {
      const next = course.findIndex((l) => !done.includes(l.id));
      if (next >= 0) openLesson(next);
      else setView({ kind: 'overview' });
    }
  };

  /* ── views ── */

  if (view.kind === 'done') {
    const score = scoreOf({ ...progress });
    return (
      <View style={[s.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 20 }]}>
        <View style={s.doneWrap}>
          <View style={[s.bigBadge, { backgroundColor: C.greenBg }]}>
            <FontAwesome name="trophy" size={54} color={C.green} />
          </View>
          <Text style={s.doneTitle}>You are ready to drive</Text>
          <Text style={s.doneSub}>
            All {course.length} lessons done{score != null ? ` · ${score}% right first time` : ''}.
            {'\n'}You can open the course again from the Dashboard at any time.
          </Text>
          <TouchableOpacity style={s.primary} onPress={leave}>
            <Text style={s.primaryText}>Start using the app</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setView({ kind: 'overview' })} style={{ padding: 12 }}>
            <Text style={s.link}>Back to the lessons</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (view.kind === 'lesson') {
    const lesson = course[view.index];
    const onQuestion = view.step >= lesson.cards.length;
    const total = lesson.cards.length + 1;
    const q = lesson.question;
    const right = picked === q.correct;
    return (
      <View style={[s.root, { paddingTop: insets.top + 8 }]}>
        <View style={s.lessonHead}>
          <TouchableOpacity onPress={() => setView({ kind: 'overview' })} style={s.iconBtn} accessibilityLabel="Back to the lessons">
            <FontAwesome name="th-large" size={16} color={C.text2} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.lessonKicker}>Lesson {view.index + 1} of {course.length}</Text>
            <Text style={s.lessonTitle} numberOfLines={1}>{lesson.title}</Text>
          </View>
        </View>
        <View style={s.dots}>
          {Array.from({ length: total }).map((_, i) => (
            <View key={i} style={[s.dot, i <= view.step && { backgroundColor: lesson.color }]} />
          ))}
        </View>

        <ScrollView contentContainerStyle={s.lessonBody}>
          {!onQuestion ? (
            <CardView card={lesson.cards[view.step]} />
          ) : (
            <View>
              <View style={[s.qBadge, { backgroundColor: lesson.color + '1f' }]}>
                <FontAwesome name="graduation-cap" size={14} color={lesson.color} />
                <Text style={[s.qBadgeText, { color: lesson.color }]}>Quick check</Text>
              </View>
              <Text style={s.qPrompt}>{q.prompt}</Text>
              {q.options.map((opt, i) => {
                const chosen = picked === i;
                const showRight = picked != null && right && i === q.correct;
                const showWrong = chosen && !right;
                return (
                  <TouchableOpacity
                    key={i}
                    disabled={right}
                    onPress={() => {
                      setPicked(i);
                      if (i !== q.correct) setTriedWrong(true);
                    }}
                    style={[
                      s.option,
                      showRight && { borderColor: C.green, backgroundColor: C.greenBg },
                      showWrong && { borderColor: C.red, backgroundColor: C.redBg },
                    ]}
                  >
                    <View style={[s.radio, (showRight || showWrong) && { borderColor: showRight ? C.green : C.red }]}>
                      {showRight && <FontAwesome name="check" size={12} color={C.green} />}
                      {showWrong && <FontAwesome name="times" size={12} color={C.red} />}
                    </View>
                    <Text style={s.optionText}>{opt}</Text>
                  </TouchableOpacity>
                );
              })}
              {picked != null && (
                <View style={[s.feedback, { backgroundColor: right ? C.greenBg : C.redBg }]}>
                  <Text style={[s.feedbackTitle, { color: right ? C.green : C.red }]}>
                    {right ? 'Correct!' : 'Not quite — try again'}
                  </Text>
                  {right && <Text style={s.feedbackText}>{q.explain}</Text>}
                </View>
              )}
            </View>
          )}
        </ScrollView>

        <View style={[s.navBar, { paddingBottom: insets.bottom + 12 }]}>
          <TouchableOpacity
            style={[s.secondary, view.step === 0 && { opacity: 0.4 }]}
            disabled={view.step === 0}
            onPress={() => { setPicked(null); setView({ ...view, step: view.step - 1 }); }}
          >
            <FontAwesome name="chevron-left" size={12} color={C.text2} />
            <Text style={s.secondaryText}>Back</Text>
          </TouchableOpacity>
          {!onQuestion ? (
            <TouchableOpacity style={[s.primary, s.navPrimary, { backgroundColor: lesson.color }]} onPress={() => setView({ ...view, step: view.step + 1 })}>
              <Text style={s.primaryText}>{view.step === lesson.cards.length - 1 ? 'Quick check' : 'Next'}</Text>
              <FontAwesome name="chevron-right" size={12} color="#fff" />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[s.primary, s.navPrimary, { backgroundColor: right ? C.green : C.muted }]}
              disabled={!right}
              onPress={() => finishLesson(lesson)}
            >
              <Text style={s.primaryText}>{view.index === course.length - 1 || doneCount === course.length - 1 ? 'Finish' : 'Next lesson'}</Text>
              <FontAwesome name="chevron-right" size={12} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  /* Overview */
  const pct = Math.round((doneCount / course.length) * 100);
  const finished = Boolean(progress.completedAt);
  return (
    <View style={[s.root, { paddingTop: insets.top + 8 }]}>
      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 120 }}>
        <View style={s.overHead}>
          <View style={s.capBadge}><FontAwesome name="graduation-cap" size={22} color="#fff" /></View>
          <TouchableOpacity onPress={leave} style={s.iconBtn} accessibilityLabel="Close">
            <FontAwesome name="times" size={16} color={C.text2} />
          </TouchableOpacity>
        </View>
        <Text style={s.overTitle}>Driver Academy</Text>
        <Text style={s.overSub}>
          {finished
            ? 'Course finished — open any lesson to refresh your memory.'
            : `Welcome${user?.name ? `, ${user.name.split(' ')[0]}` : ''}! ${course.length} short lessons on how this app works — about ${course.reduce((a, l) => a + l.minutes, 0)} minutes.`}
        </Text>

        <View style={s.progressRow}>
          <View style={s.progressTrack}><View style={[s.progressFill, { width: `${pct}%` }]} /></View>
          <Text style={s.progressText}>{doneCount}/{course.length}</Text>
        </View>

        {course.map((l, i) => {
          const done = progress.done.includes(l.id);
          const isNext = !finished && i === nextIndex;
          return (
            <TouchableOpacity key={l.id} style={[s.lessonRow, isNext && { borderColor: l.color }]} onPress={() => openLesson(i)}>
              <View style={[s.lessonIcon, { backgroundColor: l.color + '1a' }]}>
                <FontAwesome name={l.icon} size={18} color={l.color} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.lessonRowTitle}>{i + 1}. {l.title}</Text>
                <Text style={s.lessonRowSub}>{l.summary} · {l.minutes} min</Text>
              </View>
              {done ? (
                <FontAwesome name="check-circle" size={22} color={C.green} />
              ) : (
                <FontAwesome name="chevron-right" size={14} color={isNext ? l.color : C.muted} />
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <View style={[s.footer, { paddingBottom: insets.bottom + 12 }]}>
        <TouchableOpacity style={s.primary} onPress={() => (finished ? setView({ kind: 'done' }) : openLesson(nextIndex))}>
          <Text style={s.primaryText}>{finished ? 'View certificate' : doneCount === 0 ? 'Start the course' : 'Continue'}</Text>
        </TouchableOpacity>
        {!finished && (
          <TouchableOpacity onPress={leave} style={{ padding: 10, alignItems: 'center' }}>
            <Text style={s.link}>Skip for now — it stays on the Dashboard</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

/* ── One lesson card ── */
function CardView({ card }: { card: Card }) {
  return (
    <View>
      <VisualView v={card.visual} />
      <Text style={s.cardTitle}>{card.title}</Text>
      <Text style={s.cardBody}>{card.body}</Text>
      {card.tip && (
        <View style={s.tip}>
          <FontAwesome name="lightbulb-o" size={15} color="#b45309" />
          <Text style={s.tipText}>{card.tip}</Text>
        </View>
      )}
    </View>
  );
}

function VisualView({ v }: { v: Visual }) {
  if (v.kind === 'icon') {
    return (
      <View style={[s.bigBadge, { backgroundColor: v.color + '1a', alignSelf: 'center', marginBottom: 22 }]}>
        <FontAwesome name={v.icon} size={52} color={v.color} />
      </View>
    );
  }
  if (v.kind === 'legend') {
    return (
      <View style={s.panel}>
        {v.rows.map((r, i) => (
          <View key={i} style={s.panelRow}>
            <View style={[s.swatch, { backgroundColor: r.color }]} />
            <Text style={s.panelText}>{r.label}</Text>
          </View>
        ))}
      </View>
    );
  }
  if (v.kind === 'buttons') {
    return (
      <View style={s.panel}>
        {v.rows.map((r, i) => (
          <View key={i} style={s.panelRow}>
            <View style={[s.mockBtn, r.bg ? { backgroundColor: r.bg, borderColor: r.bg } : null]}>
              {r.icon
                ? <FontAwesome name={r.icon} size={16} color={r.tint ?? '#0f172a'} />
                : <Text style={{ fontSize: 17, color: r.tint ?? '#0f172a' }}>{r.glyph}</Text>}
            </View>
            <Text style={s.panelText}>{r.label}</Text>
          </View>
        ))}
      </View>
    );
  }
  if (v.kind === 'checklist') {
    return (
      <View style={s.panel}>
        {v.rows.map((r, i) => (
          <View key={i} style={s.panelRow}>
            <FontAwesome name="check-circle" size={18} color={C.green} />
            <Text style={s.panelText}>{r}</Text>
          </View>
        ))}
      </View>
    );
  }
  return (
    <View style={s.panel}>
      {v.rows.map((r, i) => (
        <View key={i} style={s.panelRow}>
          <View style={s.stepNum}><Text style={s.stepNumText}>{i + 1}</Text></View>
          <Text style={s.panelText}>{r}</Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },

  overHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  capBadge: {
    width: 48, height: 48, borderRadius: 15, backgroundColor: C.brand, alignItems: 'center', justifyContent: 'center',
    shadowColor: C.brandDeep, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
  },
  iconBtn: { width: 38, height: 38, borderRadius: 11, borderWidth: 1, borderColor: C.border, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center' },
  overTitle: { fontSize: 26, fontWeight: '900', color: C.text, letterSpacing: -0.5 },
  overSub: { fontSize: 14, color: C.text2, marginTop: 6, lineHeight: 20 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18, marginBottom: 14 },
  progressTrack: { flex: 1, height: 8, borderRadius: 99, backgroundColor: '#e5e7eb', overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 99, backgroundColor: C.green },
  progressText: { fontSize: 13, fontWeight: '800', color: C.text2, fontVariant: ['tabular-nums'] },

  lessonRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.surface, borderRadius: 16,
    borderWidth: 1.5, borderColor: C.border, padding: 14, marginBottom: 10,
  },
  lessonIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  lessonRowTitle: { fontSize: 15, fontWeight: '800', color: C.text },
  lessonRowSub: { fontSize: 12.5, color: C.muted, marginTop: 2 },

  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 16, backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.border },
  primary: {
    backgroundColor: C.brand, borderRadius: 14, paddingVertical: 15, paddingHorizontal: 20,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
  },
  primaryText: { color: '#fff', fontSize: 15.5, fontWeight: '800' },
  link: { color: C.text2, fontSize: 13, fontWeight: '600', textAlign: 'center' },

  lessonHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 6 },
  lessonKicker: { fontSize: 11.5, fontWeight: '700', color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4 },
  lessonTitle: { fontSize: 17, fontWeight: '900', color: C.text },
  dots: { flexDirection: 'row', gap: 6, paddingHorizontal: 20, marginTop: 14 },
  dot: { flex: 1, height: 5, borderRadius: 99, backgroundColor: '#e5e7eb' },
  lessonBody: { padding: 22, paddingTop: 28, paddingBottom: 40 },

  bigBadge: { width: 112, height: 112, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 22, fontWeight: '900', color: C.text, letterSpacing: -0.4, marginTop: 4 },
  cardBody: { fontSize: 15.5, color: C.text2, lineHeight: 23, marginTop: 10 },
  tip: { flexDirection: 'row', gap: 10, backgroundColor: '#fffbeb', borderWidth: 1, borderColor: '#fde68a', borderRadius: 12, padding: 12, marginTop: 16 },
  tipText: { flex: 1, fontSize: 13.5, color: '#92400e', lineHeight: 19 },

  panel: { backgroundColor: C.surface, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 12, marginBottom: 20, gap: 4 },
  panelRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 7 },
  panelText: { flex: 1, fontSize: 14, color: C.text, lineHeight: 19 },
  swatch: { width: 26, height: 6, borderRadius: 99 },
  mockBtn: {
    width: 40, height: 40, borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3, elevation: 2,
  },
  stepNum: { width: 26, height: 26, borderRadius: 13, backgroundColor: C.brandSoft, alignItems: 'center', justifyContent: 'center' },
  stepNumText: { color: C.brandDeep, fontWeight: '900', fontSize: 13 },

  qBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99 },
  qBadgeText: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  qPrompt: { fontSize: 20, fontWeight: '900', color: C.text, marginTop: 14, marginBottom: 16, lineHeight: 27 },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.surface, borderWidth: 1.5,
    borderColor: C.border, borderRadius: 14, padding: 15, marginBottom: 10,
  },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: '#d1d5db', alignItems: 'center', justifyContent: 'center' },
  optionText: { flex: 1, fontSize: 15, color: C.text, lineHeight: 20 },
  feedback: { borderRadius: 14, padding: 14, marginTop: 6 },
  feedbackTitle: { fontSize: 15, fontWeight: '900' },
  feedbackText: { fontSize: 14, color: C.text2, marginTop: 4, lineHeight: 20 },

  navBar: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg },
  navPrimary: { flex: 1 },
  secondary: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, borderRadius: 14,
    borderWidth: 1, borderColor: C.border, backgroundColor: C.surface,
  },
  secondaryText: { color: C.text2, fontSize: 14.5, fontWeight: '700' },

  doneWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 6 },
  doneTitle: { fontSize: 26, fontWeight: '900', color: C.text, marginTop: 20, textAlign: 'center' },
  doneSub: { fontSize: 14.5, color: C.text2, textAlign: 'center', lineHeight: 21, marginBottom: 22 },
});
