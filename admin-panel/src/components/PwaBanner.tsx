import { useCallback, useEffect, useState } from 'react';
import { canInstall, isIOS, isInstalled, onInstallStateChange, promptInstall } from '../lib/pwa';
import { enablePush, getPushState, type PushState } from '../lib/push';

/**
 * The "install this app" nudge, followed by the "turn on alerts" nudge.
 *
 * The gate is STATE, not history:
 *
 *  - not installed  -> offer the install
 *  - installed      -> never offer it again, in any window (see `isInstalled()`, which
 *                      answers for the whole browser rather than just this tab)
 *  - alerts off     -> offer to turn them on
 *  - alerts on      -> nothing to ask
 *
 * "Once" is scoped to a sitting, not to a lifetime: the shown-marker lives in
 * sessionStorage, so ignoring the banner, navigating or reloading will not bring it back —
 * but someone who still hasn't installed gets asked again next time they open the panel.
 * A permanent dismissal would quietly strand them: no install, no push, no driver alerts,
 * and no prompt to fix it. The sidebar bell remains the manual way in either way.
 *
 * Install comes first on purpose: on iOS, web push only works from an installed app, so
 * asking for notification permission in a Safari tab there would fail outright.
 */
const INSTALL_KEY = 'jsan_pwa_install_prompt_v1';
const ALERTS_KEY = 'jsan_pwa_alerts_prompt_v1';

type Step = 'install' | 'ios-install' | 'alerts' | null;

// sessionStorage, deliberately — see the note above. Wrapped because both accessors throw
// in some privacy modes, and a storage failure must not take the panel down.
const seen = (key: string) => {
  try {
    return sessionStorage.getItem(key) === 'done';
  } catch {
    return false;
  }
};
const markSeen = (key: string) => {
  try {
    sessionStorage.setItem(key, 'done');
  } catch {
    /* nothing to remember with — the banner just reappears next navigation */
  }
};

const TruckMark = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 17H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v9a2 2 0 0 1-2 2h-1" />
    <circle cx="7" cy="17" r="2" /><circle cx="17" cy="17" r="2" />
    <path d="M9 3v5h6" />
  </svg>
);

const BellMark = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const ShareMark = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-2px' }}>
    <path d="M12 16V3" /><path d="m8 7 4-4 4 4" />
    <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
  </svg>
);

export function PwaBanner() {
  const [step, setStep] = useState<Step>(null);
  const [busy, setBusy] = useState(false);
  // null on both = still probing. Nothing is shown until they answer, so a slow probe can
  // never flash the wrong banner (and burn its shown-marker on the way past).
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [pushState, setPushState] = useState<PushState | null>(null);
  // Mirrored into state because `canInstall()` is a plain module read: without this, a
  // `beforeinstallprompt` that lands after mount would never re-run the decision.
  const [installable, setInstallable] = useState(canInstall());

  useEffect(() => {
    let alive = true;
    isInstalled().then((v) => alive && setInstalled(v));
    getPushState().then((s) => alive && setPushState(s));
    return () => {
      alive = false;
    };
  }, []);

  const alertsDue = useCallback(
    () => !seen(ALERTS_KEY) && pushState === 'off',
    [pushState]
  );

  /** Which nudge is due right now — pure, so it can be consulted from several places. */
  const decide = useCallback((): Step => {
    if (installed === null || pushState === null) return null;
    if (!installed && !seen(INSTALL_KEY)) {
      if (installable) return 'install';
      // iOS never fires beforeinstallprompt — Add to Home Screen is a manual gesture.
      if (isIOS()) return 'ios-install';
      // Desktop Safari/Firefox: no install to offer, so don't pretend there is one.
      return null;
    }
    return alertsDue() ? 'alerts' : null;
  }, [installed, installable, pushState, alertsDue]);

  // `?? decide()` and never a plain overwrite: once a banner is up it stays up until the
  // person acts on it. A late-resolving probe must not swap the card out mid-read.
  useEffect(() => {
    setStep((current) => current ?? decide());
  }, [decide]);

  // Chrome can hand us the install offer well after mount; re-probe when it does, since
  // that offer is itself proof the app is not installed.
  useEffect(
    () =>
      onInstallStateChange(() => {
        setInstallable(canInstall());
        isInstalled().then(setInstalled);
      }),
    []
  );

  // Mark on display, not on click — that is what stops a reload or a route change from
  // bringing the same card back within one sitting.
  useEffect(() => {
    if (step === 'install' || step === 'ios-install') markSeen(INSTALL_KEY);
    else if (step === 'alerts') markSeen(ALERTS_KEY);
  }, [step]);

  // Installed by any route, including Chrome's own address-bar button while this tab sat
  // open: retract the ask immediately and move on to alerts.
  useEffect(() => {
    const onInstalledEvent = () => {
      setInstalled(true);
      markSeen(INSTALL_KEY);
      setStep((c) => (c === 'install' || c === 'ios-install' ? (alertsDue() ? 'alerts' : null) : c));
    };
    window.addEventListener('appinstalled', onInstalledEvent);
    return () => window.removeEventListener('appinstalled', onInstalledEvent);
  }, [alertsDue]);

  // Once install is settled, fall through to the alerts nudge in the same session.
  const finishInstallStep = () => {
    markSeen(INSTALL_KEY);
    setStep(alertsDue() ? 'alerts' : null);
  };

  const onInstall = async () => {
    setBusy(true);
    try {
      await promptInstall();
    } finally {
      setBusy(false);
      finishInstallStep();
    }
  };

  const onEnableAlerts = async () => {
    setBusy(true);
    try {
      const next = await enablePush();
      setPushState(next);
    } finally {
      setBusy(false);
      markSeen(ALERTS_KEY);
      setStep(null);
    }
  };

  if (!step) return null;

  if (step === 'alerts') {
    return (
      <div className="pwa-banner" role="dialog" aria-label="Turn on driver alerts">
        <div className="pwa-banner-icon"><BellMark /></div>
        <div className="pwa-banner-text">
          <strong>Get alerted when a driver goes offline</strong>
          <span>
            We'll notify you the moment a vehicle stops reporting — even with this panel closed.
          </span>
        </div>
        <div className="pwa-banner-actions">
          <button className="btn-ghost" onClick={() => { markSeen(ALERTS_KEY); setStep(null); }}>
            Not now
          </button>
          <button className="btn" onClick={onEnableAlerts} disabled={busy}>
            {busy ? 'Enabling…' : 'Turn on alerts'}
          </button>
        </div>
      </div>
    );
  }

  if (step === 'ios-install') {
    return (
      <div className="pwa-banner" role="dialog" aria-label="Install JSAN Fleet">
        <div className="pwa-banner-icon"><TruckMark /></div>
        <div className="pwa-banner-text">
          <strong>Install JSAN Fleet on this iPhone</strong>
          <span>
            Tap <ShareMark /> Share, then <b>Add to Home Screen</b>. iOS only delivers driver
            alerts to the installed app.
          </span>
        </div>
        <div className="pwa-banner-actions">
          <button className="btn" onClick={finishInstallStep}>Got it</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pwa-banner" role="dialog" aria-label="Install JSAN Fleet">
      <div className="pwa-banner-icon"><TruckMark /></div>
      <div className="pwa-banner-text">
        <strong>Install JSAN Fleet</strong>
        <span>Add it once and get driver-offline alerts without keeping this tab open.</span>
      </div>
      <div className="pwa-banner-actions">
        <button className="btn-ghost" onClick={finishInstallStep}>Not now</button>
        <button className="btn" onClick={onInstall} disabled={busy}>
          {busy ? 'Installing…' : 'Install app'}
        </button>
      </div>
    </div>
  );
}
