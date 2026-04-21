import { type PropsWithChildren, useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from '../lib/i18n';
import { type ActionId, formatBinding, useBindings, useShortcut } from '../lib/shortcuts';
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
  { to: '/settings', key: 'settings', action: 'nav.settings' },
] as const;

export function Layout({ children }: PropsWithChildren) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const [healthStatus, setHealthStatus] = useState<'checking' | 'ok' | 'down'>('checking');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const bindings = useBindings();
  const nav = useMemo(
    () =>
      NAV_ITEMS.map((item) => ({
        ...item,
        label: item.key === 'radar' ? 'Radar' : t(`nav.${item.key}`),
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
  const goSettings = useCallback(() => navigate('/settings'), [navigate]);
  useShortcut('nav.overview', goOverview);
  useShortcut('nav.projects', goProjects);
  useShortcut('nav.github', goGithub);
  useShortcut('nav.vault', goVault);
  useShortcut('nav.usage', goUsage);
  useShortcut('nav.agent', goAgent);
  useShortcut('nav.radar', goRadar);
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
                <span>{item.label}</span>
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
