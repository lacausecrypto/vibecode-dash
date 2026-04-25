import { type PropsWithChildren, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { emitActivity } from '../lib/activityBus';
import { useTranslation } from '../lib/i18n';
import { type ActionId, formatBinding, useBindings, useShortcut } from '../lib/shortcuts';
import { Mascot } from './Mascot';
import { MenuUsageMini } from './MenuUsageMini';
import { PresenceBadge } from './PresenceBadge';
import { Dot } from './ui';

type NavEntry = { to: string; key: string; action: ActionId };

const NAV_ITEMS: readonly NavEntry[] = [
  { to: '/', key: 'overview', action: 'nav.overview' },
  { to: '/projects', key: 'projects', action: 'nav.projects' },
  { to: '/github', key: 'github', action: 'nav.github' },
  { to: '/vault', key: 'vault', action: 'nav.vault' },
  { to: '/usage', key: 'usage', action: 'nav.usage' },
  { to: '/agent', key: 'agent', action: 'nav.agent' },
  { to: '/radar', key: 'radar', action: 'nav.radar' },
  { to: '/presence', key: 'presence', action: 'nav.presence' },
  { to: '/settings', key: 'settings', action: 'nav.settings' },
] as const;

type PresenceFeedSummary = {
  proposed: number;
  proposed_unviewed: number;
  dying_within_1h: number;
  dying_within_24h: number;
};

export function Layout({ children }: PropsWithChildren) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const [healthStatus, setHealthStatus] = useState<'checking' | 'ok' | 'down'>('checking');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [presenceFeed, setPresenceFeed] = useState<PresenceFeedSummary | null>(null);
  // Track the previous summary so we can detect deltas and emit a
  // notification activity when something newly noteworthy lands (drives
  // the Mascot's notification sprite). We use a ref instead of state
  // because the comparison is internal to the polling effect — no render
  // needs to react to it.
  const prevPresenceRef = useRef<PresenceFeedSummary | null>(null);

  // Poll the presence feed summary every 30 s for the nav badge. Cheap
  // (a single SQLite COUNT query server-side, < 5 ms typical), and the
  // result drives the urgency pastille beside the "Presence" nav item.
  useEffect(() => {
    let cancelled = false;
    const fetchSummary = async () => {
      try {
        const { apiGet } = await import('../lib/api');
        const data = await apiGet<PresenceFeedSummary>('/api/presence/feed-summary');
        if (cancelled) return;
        setPresenceFeed(data);

        // Notification heuristic: any of the urgency counters grew since
        // the previous tick. We skip the first tick (prev = null) so the
        // mascot doesn't flash notification on every page load. Rationale
        // for these specific deltas:
        //  - proposed_unviewed ↑: a new draft is queued for review.
        //  - dying_within_1h ↑: something needs attention soon.
        //  - dying_within_24h ↑ (only if 1h didn't already grow): same
        //    thing on a longer horizon.
        const prev = prevPresenceRef.current;
        if (prev) {
          const reasons: string[] = [];
          if (data.proposed_unviewed > prev.proposed_unviewed) {
            reasons.push(`${data.proposed_unviewed - prev.proposed_unviewed} new draft(s) queued`);
          }
          if (data.dying_within_1h > prev.dying_within_1h) {
            reasons.push(`${data.dying_within_1h - prev.dying_within_1h} item(s) dying within 1h`);
          } else if (data.dying_within_24h > prev.dying_within_24h) {
            reasons.push(
              `${data.dying_within_24h - prev.dying_within_24h} item(s) dying within 24h`,
            );
          }
          if (reasons.length > 0) {
            emitActivity({
              kind: 'notification',
              reason: reasons.join(' · '),
              at: Date.now(),
            });
          }
        }
        prevPresenceRef.current = data;
      } catch {
        // Silent: badge just disappears if the call fails (server down etc.)
      }
    };
    void fetchSummary();
    const id = setInterval(() => void fetchSummary(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const bindings = useBindings();
  const nav = useMemo(
    () =>
      NAV_ITEMS.map((item) => ({
        ...item,
        label:
          item.key === 'radar'
            ? 'Radar'
            : item.key === 'presence'
              ? t('nav.presence')
              : t(`nav.${item.key}`),
        hint: formatBinding(bindings[item.action]),
      })),
    [t, bindings],
  );

  const activeNav = useMemo(() => {
    return (
      nav.find((item) => item.to !== '/' && location.pathname.startsWith(item.to)) ||
      nav.find((item) => item.to === '/')
    );
  }, [location.pathname, nav]);

  const isFullBleed = location.pathname.startsWith('/agent');

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/api/health');
        if (cancelled) {
          return;
        }
        setHealthStatus(res.ok ? 'ok' : 'down');
      } catch {
        if (!cancelled) {
          setHealthStatus('down');
        }
      }
    };

    void check();
    const id = setInterval(() => void check(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const goOverview = useCallback(() => navigate('/'), [navigate]);
  const goProjects = useCallback(() => navigate('/projects'), [navigate]);
  const goGithub = useCallback(() => navigate('/github'), [navigate]);
  const goVault = useCallback(() => navigate('/vault'), [navigate]);
  const goUsage = useCallback(() => navigate('/usage'), [navigate]);
  const goAgent = useCallback(() => navigate('/agent'), [navigate]);
  const goRadar = useCallback(() => navigate('/radar'), [navigate]);
  const goPresence = useCallback(() => navigate('/presence'), [navigate]);
  const goSettings = useCallback(() => navigate('/settings'), [navigate]);
  useShortcut('nav.overview', goOverview);
  useShortcut('nav.projects', goProjects);
  useShortcut('nav.github', goGithub);
  useShortcut('nav.vault', goVault);
  useShortcut('nav.usage', goUsage);
  useShortcut('nav.agent', goAgent);
  useShortcut('nav.radar', goRadar);
  useShortcut('nav.presence', goPresence);
  useShortcut('nav.settings', goSettings);
  useShortcut('nav.agentJump', goAgent);

  return (
    <div className="app-shell">
      <a
        href="#main-content"
        className="sr-only rounded-md bg-[var(--accent)] px-3 py-2 text-black focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50"
      >
        Skip to content
      </a>

      <header className="app-header">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileNavOpen((value) => !value)}
              className="btn btn-ghost md:hidden"
              aria-label="Toggle navigation"
            >
              {t('nav.menu')}
            </button>

            <div className="flex items-baseline gap-3">
              <span className="text-[15px] font-semibold tracking-tight text-[var(--text)]">
                Dashboard
              </span>
              <span className="text-[13px] text-[var(--text-dim)]">
                {activeNav?.label || t('nav.overview')}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="chip">
              <Dot
                tone={
                  healthStatus === 'ok' ? 'success' : healthStatus === 'down' ? 'danger' : 'warn'
                }
              />
              <span className="text-[11px]">api {healthStatus}</span>
            </span>
            <span className="chip chip-muted hidden sm:inline-flex">127.0.0.1</span>
          </div>
        </div>
      </header>

      <div
        className={`grid grid-cols-1 gap-4 py-4 md:grid-cols-[200px_minmax(0,1fr)] ${
          isFullBleed
            ? 'px-3'
            : 'mx-auto max-w-[1280px] gap-6 px-6 py-6 md:grid-cols-[220px_minmax(0,1fr)]'
        }`}
      >
        <aside className="app-sidebar hidden md:block">
          <div className="mb-2 flex items-center justify-center">
            <Mascot size={96} />
          </div>
          <nav className="flex flex-col gap-0.5">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`.trim()}
                data-active={
                  location.pathname === item.to ||
                  (item.to !== '/' && location.pathname.startsWith(item.to))
                }
              >
                <span className="flex items-center gap-1.5">
                  {item.label}
                  {item.key === 'presence' && presenceFeed ? (
                    <PresenceBadge summary={presenceFeed} />
                  ) : null}
                </span>
                <kbd>{item.hint}</kbd>
              </NavLink>
            ))}
          </nav>

          <div className="divider" />

          <div className="flex flex-col gap-1 px-1 text-[11px] text-[var(--text-dim)]">
            <span>{t('nav.shortcuts')}</span>
            <span>
              <kbd>/</kbd> {t('nav.searchHint')} ·{' '}
              <kbd>{formatBinding(bindings['nav.agentJump'])}</kbd> {t('nav.agentHint')}
            </span>
          </div>

          <div className="mt-3">
            <MenuUsageMini />
          </div>
        </aside>

        {mobileNavOpen ? (
          <aside className="app-sidebar md:hidden">
            <nav className="flex flex-col gap-0.5">
              {nav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  onClick={() => setMobileNavOpen(false)}
                  className="nav-item"
                  data-active={
                    location.pathname === item.to ||
                    (item.to !== '/' && location.pathname.startsWith(item.to))
                  }
                >
                  <span>{item.label}</span>
                  <kbd>{item.hint}</kbd>
                </NavLink>
              ))}
            </nav>
          </aside>
        ) : null}

        <main id="main-content" className="app-main !px-0 !pt-0">
          {children}
        </main>
      </div>
    </div>
  );
}
