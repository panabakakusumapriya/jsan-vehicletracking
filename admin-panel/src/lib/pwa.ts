// Service-worker registration + "can this be installed?" state.
//
// The install prompt has an awkward constraint: Chrome fires `beforeinstallprompt` once,
// early, and if nobody calls preventDefault() on it the event is gone for good. So we hook
// it at module load (main.tsx imports this before React mounts) and stash the event for the
// banner to use whenever the user gets around to clicking Install.

type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

// Sticky "this browser has the app installed" marker. Needed because none of the live
// signals work everywhere: display-mode only describes the current window, and
// getInstalledRelatedApps() is Chromium-only.
const INSTALLED_KEY = 'jsan_pwa_installed';

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

/** Subscribe to install-availability changes. */
export function onInstallStateChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function canInstall(): boolean {
  return deferredPrompt !== null;
}

/**
 * True when *this window* is the installed app.
 *
 * Note what this does NOT tell you: someone who installed the panel and then carries on in
 * their normal browser tab gets `false` here. Use `isInstalled()` for "do they have it?".
 */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari predates display-mode and exposes this instead.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function memoInstalled(value: boolean): void {
  try {
    if (value) localStorage.setItem(INSTALLED_KEY, 'yes');
    else localStorage.removeItem(INSTALLED_KEY);
  } catch {
    /* private mode — we just lose the memo */
  }
}

function memoSaysInstalled(): boolean {
  try {
    return localStorage.getItem(INSTALLED_KEY) === 'yes';
  } catch {
    return false;
  }
}

export function markInstalled(): void {
  memoInstalled(true);
}

/**
 * Has this browser got the app installed, asked from any window?
 *
 * Four signals in strict priority order, because no single one covers every case and two of
 * them can go stale:
 *
 *   1. `isStandalone()` — we ARE the installed app. Unambiguous.
 *   2. `canInstall()` — Chrome only fires `beforeinstallprompt` for an app it does NOT
 *      already have, so a live install offer is an authoritative "not installed". This is
 *      also what makes the answer self-correcting: uninstall the app and Chrome starts
 *      offering again, so the memo below gets cleared and the banner returns.
 *   3. `getInstalledRelatedApps()` — the only signal that says "yes" from an ordinary
 *      browser tab, catching whoever installed via Chrome's address-bar button without ever
 *      touching our banner. Chromium-only; needs the manifest `related_applications` entry.
 *   4. the sticky memo — last resort for Safari/Firefox, where neither 2 nor 3 exists.
 *
 * Order matters: checking the memo before (2) is what would wrongly silence the banner
 * forever after an uninstall.
 */
export async function isInstalled(): Promise<boolean> {
  if (isStandalone()) {
    memoInstalled(true);
    return true;
  }

  if (canInstall()) {
    memoInstalled(false); // the browser is offering an install: it is not installed
    return false;
  }

  const nav = navigator as Navigator & {
    getInstalledRelatedApps?: () => Promise<unknown[]>;
  };
  if (typeof nav.getInstalledRelatedApps === 'function') {
    try {
      const apps = await nav.getInstalledRelatedApps();
      if (apps.length > 0) {
        memoInstalled(true);
        return true;
      }
    } catch {
      /* not a secure top-level context, or unsupported — fall through */
    }
  }

  return memoSaysInstalled();
}

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports itself as a Mac; the touch points give it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** Show the browser's own install dialog. Resolves with what the user chose. */
export async function promptInstall(): Promise<InstallOutcome> {
  const evt = deferredPrompt;
  if (!evt) return 'unavailable';
  deferredPrompt = null; // a prompt event is single-use
  notify();
  await evt.prompt();
  const { outcome } = await evt.userChoice;
  return outcome;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep the event alive so we can fire it from our own banner
    deferredPrompt = e as BeforeInstallPromptEvent;
    // An install offer means the app is not installed — drop a memo left over from before
    // an uninstall, so the banner is free to come back.
    memoInstalled(false);
    notify();
  });

  // Fires however the install happened — our button, or Chrome's own address-bar icon.
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    markInstalled();
    notify();
  });
}

/**
 * Register the worker that receives push while the panel is closed.
 * Safe to call on every boot — the browser dedupes by script URL.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // Pick up a redeployed worker without waiting for every tab to close.
    reg.update().catch(() => {});
    return reg;
  } catch (err) {
    console.warn('Service worker registration failed:', err);
    return null;
  }
}
