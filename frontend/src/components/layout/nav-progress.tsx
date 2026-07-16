'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';

/**
 * Thin top-of-page progress bar that gives INSTANT click feedback.
 *
 *  1. The moment any in-app link is clicked, the bar appears and animates to ~70%.
 *  2. When the pathname actually changes (route mounted) it finishes to 100% and fades.
 *
 * This decouples "did my click register?" from "is the page ready?". Even on a slow
 * dev-mode compile, the user sees the bar moving so they don't click again.
 */
export function NavProgress() {
  const pathname = usePathname();
  const lastPath = React.useRef(pathname);
  const [progress, setProgress] = React.useState(0);
  const [visible, setVisible] = React.useState(false);
  const timers = React.useRef<number[]>([]);

  const clearTimers = () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  };

  // Capture-phase listener so we beat the browser's own navigation.
  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new-tab clicks
      const a = (e.target as HTMLElement)?.closest('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#') || a.target === '_blank') return;
      // Same-path click? No nav happens — don't show the bar.
      const samePath = a.pathname === window.location.pathname && a.search === window.location.search;
      if (samePath) return;

      clearTimers();
      setVisible(true);
      setProgress(15);
      timers.current.push(window.setTimeout(() => setProgress(40), 80));
      timers.current.push(window.setTimeout(() => setProgress(70), 250));
      // Failsafe finish in case the route doesn't change (slow compile + then back-out).
      timers.current.push(window.setTimeout(() => setProgress(90), 800));
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // When the route actually changes, complete and fade.
  React.useEffect(() => {
    if (pathname === lastPath.current) return;
    lastPath.current = pathname;
    clearTimers();
    setProgress(100);
    timers.current.push(window.setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, 220));
    return clearTimers;
  }, [pathname]);

  if (!visible) return null;
  return (
    <div
      className="pointer-events-none fixed left-0 top-0 z-[200] h-0.5 bg-primary shadow-[0_0_8px_rgba(59,130,246,0.6)]"
      style={{
        width: `${progress}%`,
        transition: progress === 100 ? 'width 180ms ease-out, opacity 200ms 100ms' : 'width 250ms ease-out',
        opacity: progress === 100 ? 0 : 1,
      }}
    />
  );
}
