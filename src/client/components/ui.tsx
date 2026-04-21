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
  children,
  className,
}: PropsWithChildren<{
  title?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  className?: string;
}>) {
  return (
    <section className={`section ${className || ''}`.trim()}>
      {title || meta || action ? (
        <div className="section-head">
          <div className="flex flex-col gap-0.5">
            {title ? <h2 className="section-title">{title}</h2> : null}
            {meta ? <div className="section-meta">{meta}</div> : null}
          </div>
          {action ? <div className="flex items-center gap-2">{action}</div> : null}
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
