import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  type QuotaBar,
  type QuotaSnapshot,
  getQuotaSnapshot,
  subscribeQuota,
} from '../lib/quotaSignal';
import { Mascot } from './Mascot';

/**
 * Compact strip rendered as a second row inside the app header on narrow
 * viewports (< sm / 640px). Keeps the tamagochi + Claude/Codex 5h gauges
 * visible even when the sidebar is collapsed. Tap → /usage (the full
 * quota detail page); the header's hamburger handles drawer/nav instead.
 *
 * Data comes via subscribeQuota — no extra fetch, MenuUsageMini in the
 * drawer is the single source of truth and publishes after each refresh.
 */
export function MobileQuickBar() {
  const navigate = useNavigate();
  const [snap, setSnap] = useState<QuotaSnapshot>(() => getQuotaSnapshot());
  useEffect(() => subscribeQuota(setSnap), []);

  const claude5h = snap.claude?.primary ?? null;
  const codex5h = snap.codex?.primary ?? null;

  return (
    <button
      type="button"
      onClick={() => navigate('/usage')}
      className="mobile-quickbar"
      aria-label="Voir les quotas Claude et Codex en détail"
    >
      <span className="mobile-quickbar-mascot">
        <Mascot size={28} />
      </span>
      <span className="mobile-quickbar-bars">
        <MiniGauge label="Claude 5h" bar={claude5h} accent="cyan" />
        <MiniGauge label="Codex 5h" bar={codex5h} accent="amber" />
      </span>
      <span className="mobile-quickbar-hint" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

function MiniGauge({
  label,
  bar,
  accent,
}: {
  label: string;
  bar: QuotaBar;
  accent: 'cyan' | 'amber';
}) {
  if (!bar) {
    return (
      <span className="mobile-quickbar-gauge">
        <span className="mobile-quickbar-gauge-label">{label}</span>
        <span className="mobile-quickbar-gauge-value text-[var(--text-faint)]">n/a</span>
      </span>
    );
  }

  const clamped = Math.max(0, Math.min(100, bar.usedPercent));
  const nowSec = Math.floor(Date.now() / 1000);
  const reset = bar.resetsAt > 0 && nowSec >= bar.resetsAt;

  // Color rule mirrors MenuUsageMini: ok → provider accent, warn → amber,
  // danger → red. Keeps the visual language consistent across the two
  // entry points so the user doesn't have to relearn what each color means.
  const tone = reset
    ? 'reset'
    : clamped >= 85
      ? 'danger'
      : clamped >= 60
        ? 'warn'
        : accent === 'cyan'
          ? 'cyan'
          : 'amber';

  const fillColor =
    tone === 'reset'
      ? 'bg-[var(--surface-2)]'
      : tone === 'danger'
        ? 'bg-[#ff453a]'
        : tone === 'warn'
          ? 'bg-[#ffd60a]'
          : tone === 'cyan'
            ? 'bg-[#64d2ff]'
            : 'bg-[#ffd60a]';
  const textColor =
    tone === 'reset'
      ? 'text-[var(--text-faint)] line-through'
      : tone === 'danger'
        ? 'text-[#ff453a]'
        : tone === 'warn'
          ? 'text-[#ffd60a]'
          : tone === 'cyan'
            ? 'text-[#64d2ff]'
            : 'text-[#ffd60a]';

  return (
    <span className="mobile-quickbar-gauge">
      <span className="mobile-quickbar-gauge-row">
        <span className="mobile-quickbar-gauge-label">{label}</span>
        <span className={`mobile-quickbar-gauge-value num ${textColor}`}>
          {clamped.toFixed(0)}%
        </span>
      </span>
      <span className="mobile-quickbar-gauge-track">
        <span
          className={`mobile-quickbar-gauge-fill ${fillColor}`}
          style={{ width: `${clamped}%`, opacity: tone === 'reset' ? 0.3 : 1 }}
        />
      </span>
    </span>
  );
}
