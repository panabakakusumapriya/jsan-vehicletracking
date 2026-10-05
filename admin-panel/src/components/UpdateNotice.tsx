import { useEffect, useState } from 'react';

/**
 * "A newer version of the panel is out — reload."
 *
 * A tab left open keeps running the code it loaded with, however many deploys happen meanwhile.
 * That is how an import still started on its first archive after the fix for exactly that was live:
 * the operator's tab was older than the fix. So the panel checks, now and then and whenever the tab
 * comes back into view, whether the page it would load today names a different bundle than the
 * one it is running, and says so.
 *
 * Production builds only: the dev server has no hashed bundle to compare.
 */
const CHECK_EVERY_MS = 3 * 60 * 1000;
const BUNDLE = /\/assets\/index-[\w-]+\.js/;

function runningBundle(): string | null {
  for (const s of Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))) {
    const hit = new URL(s.src, location.href).pathname.match(BUNDLE);
    if (hit) return hit[0];
  }
  return null;
}

export function UpdateNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const mine = runningBundle();
    if (!mine) return undefined;
    let stopped = false;
    const check = async () => {
      if (stopped || document.hidden) return;
      try {
        const html = await (await fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } })).text();
        const latest = html.match(BUNDLE)?.[0];
        if (latest && latest !== mine) setStale(true);
      } catch {
        /* offline or the host is mid-deploy — ask again later */
      }
    };
    check();
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="update-notice" role="status">
      <span>A newer version of the panel is out.</span>
      <button type="button" className="btn" onClick={() => location.reload()}>Reload</button>
      <button type="button" className="update-notice-x" aria-label="Later" onClick={() => setStale(false)}>✕</button>
    </div>
  );
}
