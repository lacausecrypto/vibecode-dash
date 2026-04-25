import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { useTranslation } from './lib/i18n';

const OverviewRoute = lazy(() => import('./routes/overview'));
const ProjectsRoute = lazy(() => import('./routes/projects'));
const ProjectDetailRoute = lazy(() => import('./routes/project-detail'));
const GithubRoute = lazy(() => import('./routes/github'));
const VaultRoute = lazy(() => import('./routes/vault'));
const UsageRoute = lazy(() => import('./routes/usage'));
const AgentRoute = lazy(() => import('./routes/agent'));
const RadarRoute = lazy(() => import('./routes/radar'));
const PresenceRoute = lazy(() => import('./routes/presence'));
const SettingsRoute = lazy(() => import('./routes/settings'));

function RouteFallback() {
  const { t } = useTranslation();
  return (
    <div className="flex h-64 items-center justify-center text-sm text-slate-500">
      {t('common.loading')}
    </div>
  );
}

export default function App() {
  const { locale } = useTranslation();
  return (
    <Layout>
      <ErrorBoundary locale={locale}>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<OverviewRoute />} />
            <Route path="/projects" element={<ProjectsRoute />} />
            <Route path="/projects/:id" element={<ProjectDetailRoute />} />
            <Route path="/github" element={<GithubRoute />} />
            <Route path="/vault" element={<VaultRoute />} />
            <Route path="/usage" element={<UsageRoute />} />
            <Route path="/agent" element={<AgentRoute />} />
            <Route path="/radar" element={<RadarRoute />} />
            <Route path="/presence" element={<PresenceRoute />} />
            <Route path="/settings" element={<SettingsRoute />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </Layout>
  );
}
