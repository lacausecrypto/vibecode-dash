import type { ReactNode } from 'react';
import { useTranslation } from '../lib/i18n';

type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
};

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-800 bg-slate-950/40 px-6 py-12 text-center">
      <div className="text-sm font-medium text-slate-200">{title}</div>
      {description ? <div className="max-w-md text-xs text-slate-400">{description}</div> : null}
      {action}
    </div>
  );
}

type ErrorStateProps = {
  message: string;
  onRetry?: () => void;
};

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-xl border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-200"
    >
      <div className="font-medium">{t('common.error')}</div>
      <div className="text-xs text-red-200/80">{message}</div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-md border border-red-700/60 bg-red-900/40 px-3 py-1 text-xs text-red-100 hover:bg-red-900/60"
        >
          {t('common.retry')}
        </button>
      ) : null}
    </div>
  );
}

type SkeletonProps = {
  className?: string;
};

export function Skeleton({ className = 'h-4 w-full' }: SkeletonProps) {
  return (
    <div className={`animate-pulse rounded bg-slate-800/60 ${className}`} aria-hidden="true" />
  );
}

type SkeletonListProps = {
  rows?: number;
  rowClassName?: string;
};

export function SkeletonList({ rows = 4, rowClassName = 'h-12' }: SkeletonListProps) {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: skeletons are static
          key={i}
          className={`${rowClassName} w-full`}
        />
      ))}
    </div>
  );
}
