import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';

export type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger';

function toneClass(tone: Tone | undefined, base: string): string {
  switch (tone) {
    case 'accent':
      return `${base} chip-accent`;
    case 'success':
      return `${base} chip-success`;
    case 'warn':
      return `${base} chip-warn`;
    case 'danger':
      return `${base} chip-danger`;
    default:
      return base;
  }
}

export function Section({
  title,
  meta,
  action,
  actionWide,
  children,
  className,
}: PropsWithChildren<{
  title?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  /**
   * Marks the action as "wide" (e.g. a Segmented with many tabs) so the
   * head stacks the action below the title on narrow viewports instead
   * of trying to fit them on one row. Default false: a single button or
   * a narrow chip cluster stays inline with the title (the
   * Sync now / Rescan all pattern, where stacking would look wrong).
   *
   * Why we can't auto-detect: a CSS-only "wrap when too wide" path looks
   * tempting but max-width on the action defeats flex-wrap (clamps the
   * flex-basis to the container so wrap never triggers), and removing
   * the max-width lets the action overflow the section box. Per-section
   * opt-in is the only deterministic fix.
   */
  actionWide?: boolean;
  className?: string;
}>) {
  return (
    <section className={`section ${className || ''}`.trim()}>
      {title || meta || action ? (
        <div className={`section-head${actionWide ? ' section-head-stack' : ''}`}>
          {/* Title block: flex-1 + min-w-0 lets it own the available row
              width but ALSO shrink past content size when the action is
              wider — without min-w-0 it would block the action from ever
              shrinking and we'd get word-by-word wrap on the title. */}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {title ? <h2 className="section-title">{title}</h2> : null}
            {meta ? <div className="section-meta">{meta}</div> : null}
          </div>
          {/* Action block: shrink-0 keeps the action's natural width.
              max-w-full + overflow-x-auto cap the rendered width at the
              parent so a wide tab strip scrolls internally instead of
              breaking the section box. When `actionWide` is set the
              parent's `section-head-stack` class flips to column on
              narrow viewports so this lives on its own row. */}
          {action ? (
            <div className="flex max-w-full shrink-0 items-center gap-2 overflow-x-auto">
              {action}
            </div>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Card({
  children,
  className,
  tight,
  hover,
}: PropsWithChildren<{ className?: string; tight?: boolean; hover?: boolean }>) {
  return (
    <div
      className={`${tight ? 'card-tight' : 'card'} ${hover ? 'card-hover' : ''} ${className || ''}`.trim()}
    >
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
  children,
}: PropsWithChildren<{
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}>) {
  const valueColor =
    tone === 'accent'
      ? 'text-[#64d2ff]'
      : tone === 'success'
        ? 'text-[#30d158]'
        : tone === 'warn'
          ? 'text-[#ffd60a]'
          : tone === 'danger'
            ? 'text-[#ff453a]'
            : '';

  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value num ${valueColor}`.trim()}>{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
      {children ? <div className="mt-2 flex flex-col gap-1">{children}</div> : null}
    </div>
  );
}

export function KV({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="stat-sub">
      <span>{label}</span>
      <span className="num text-[var(--text)]">{value}</span>
    </div>
  );
}

export function Chip({
  tone,
  children,
  className,
  title,
}: PropsWithChildren<{ tone?: Tone; className?: string; title?: string }>) {
  return (
    <span className={`${toneClass(tone, 'chip')} ${className || ''}`.trim()} title={title}>
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone?: 'success' | 'warn' | 'danger' | 'neutral' }) {
  const cls =
    tone === 'success'
      ? 'dot-success'
      : tone === 'warn'
        ? 'dot-warn'
        : tone === 'danger'
          ? 'dot-danger'
          : '';
  return <span className={`dot ${cls}`.trim()} />;
}

type ButtonTone = 'neutral' | 'accent' | 'primary' | 'ghost';

export function Button({
  tone = 'neutral',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  const toneClassName =
    tone === 'accent'
      ? 'btn-accent'
      : tone === 'primary'
        ? 'btn-primary'
        : tone === 'ghost'
          ? 'btn-ghost'
          : '';
  return (
    <button className={`btn ${toneClassName} ${className || ''}`.trim()} {...rest}>
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Toolbar({ children }: PropsWithChildren) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--text-mute)]">
      {children}
    </div>
  );
}

export function FieldLabel({
  label,
  children,
  htmlFor,
}: PropsWithChildren<{ label: ReactNode; htmlFor?: string }>) {
  return (
    <label
      htmlFor={htmlFor}
      className="flex flex-col gap-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]"
    >
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Empty({ children }: PropsWithChildren) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-6 text-center text-sm text-[var(--text-dim)]">
      {children}
    </div>
  );
}

export function ErrorBanner({ children }: PropsWithChildren) {
  if (!children) {
    return null;
  }
  return (
    <div className="rounded-[var(--radius)] border border-[rgba(255,69,58,0.32)] bg-[rgba(255,69,58,0.08)] px-3 py-2 text-sm text-[#ffc6c1]">
      {children}
    </div>
  );
}
