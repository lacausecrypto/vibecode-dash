import { Component, type ErrorInfo, type ReactNode } from 'react';
import { translate } from '../lib/i18n';

type Props = { children: ReactNode; locale?: 'fr' | 'en' | 'es' };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep a breadcrumb in the dev console even when the overlay is gone in prod.
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }
    const locale = this.props.locale ?? 'fr';
    const t = (key: string) => translate(locale, key);
    return (
      <div
        role="alert"
        className="mx-auto my-8 flex max-w-xl flex-col gap-3 rounded-[var(--radius)] border border-red-900/60 bg-red-950/30 p-5 text-sm"
      >
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-red-400" />
          <h2 className="text-[14px] font-semibold text-red-100">
            {t('common.errorBoundaryTitle')}
          </h2>
        </div>
        <p className="text-[12.5px] text-red-200/90">{t('common.errorBoundaryHint')}</p>
        <pre className="max-h-40 overflow-auto rounded-md bg-black/40 p-3 text-[11px] text-red-200/80">
          {this.state.error.message || String(this.state.error)}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.handleReset}
            className="rounded-md border border-red-700/60 bg-red-900/40 px-3 py-1 text-xs text-red-100 hover:bg-red-900/60"
          >
            {t('common.retry')}
          </button>
          <button
            type="button"
            onClick={this.handleReload}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1 text-xs text-[var(--text-mute)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
          >
            {t('common.reload')}
          </button>
        </div>
      </div>
    );
  }
}
