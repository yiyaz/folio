import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { WorkspaceProvider } from './workspace';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { LoginPage, SignupPage, VerifyPage, ForgotPage, ResetPage } from './pages/AuthPages';
import { DocPage } from './pages/DocPage';
import { HomePage, SearchPage, TagsPage, TagPage, SharedPage, FolderPage, UserPage, TrashPage, PublicDocPage, NotFound } from './pages/BrowsePages';
import { SettingsPage, WorkspaceSettingsPage, AdminPage } from './pages/SettingsPages';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`} replace />;
  return <WorkspaceProvider>{children}</WorkspaceProvider>;
}

function GuestOnly({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  return me ? <Navigate to="/" replace /> : <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
      <Route path="/signup" element={<GuestOnly><SignupPage /></GuestOnly>} />
      <Route path="/verify" element={<VerifyPage />} />
      <Route path="/forgot" element={<ForgotPage />} />
      <Route path="/reset" element={<ResetPage />} />
      <Route path="/p/:token" element={<PublicDocPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<HomePage />} />
        <Route path="/d/:docId" element={<DocPage />} />
        <Route path="/f/:folderId" element={<FolderPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/tags" element={<TagsPage />} />
        <Route path="/tags/:tag" element={<TagPage />} />
        <Route path="/shared" element={<SharedPage />} />
        <Route path="/u/:username" element={<UserPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/workspace/:wsId" element={<WorkspaceSettingsPage />} />
        <Route path="/workspace/:wsId/trash" element={<TrashPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
