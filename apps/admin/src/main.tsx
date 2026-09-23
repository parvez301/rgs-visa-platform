import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppProviders } from "./AppProviders";
import { HomeRoute } from "./components/HomeRoute";
import { RequireScreen } from "./components/RequireScreen";
import { useAuth } from "./lib/auth";
import { ActivityPage } from "./pages/ActivityPage";
import { AdminUsersPage } from "./pages/AdminUsersPage";
import { ApplicationDetailPage } from "./pages/ApplicationDetailPage";
import { AuthPage } from "./pages/AuthPage";
import { ConfigPage } from "./pages/ConfigPage";
import { LeadsPage } from "./pages/LeadsPage";
import { CasePage } from "./crm/case/CasePage";
import { LedgerPage } from "./crm/ledger/LedgerPage";
import { ReviewPage } from "./crm/review/ReviewPage";
import { NoticesPage } from "./pages/NoticesPage";
import { NoAccessPage } from "./pages/NoAccessPage";
import { QueuePage } from "./pages/QueuePage";
import { UserActivityPage } from "./pages/UserActivityPage";
import "./styles.css";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoading, isSignedIn } = useAuth();
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-ink-soft">
        Loading…
      </div>
    );
  }
  if (!isSignedIn) return <Navigate to="/auth" replace />;
  return <>{children}</>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Every provider lives in `AppProviders` so a test can mount the same tree. */}
    <AppProviders>
      <BrowserRouter>
        <Routes>
          <Route path="/auth" element={<AuthPage />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <HomeRoute>
                  <QueuePage />
                </HomeRoute>
              </RequireAuth>
            }
          />
          <Route
            path="/applications/:applicationId"
            element={
              <RequireAuth>
                <RequireScreen screen="queue">
                  <ApplicationDetailPage />
                </RequireScreen>
              </RequireAuth>
            }
          />
          <Route
            path="/activity"
            element={
              <RequireAuth>
                <RequireScreen screen="activity">
                  <ActivityPage />
                </RequireScreen>
              </RequireAuth>
            }
          />
          <Route
            path="/leads"
            element={
              <RequireAuth>
                <RequireScreen screen="leads">
                  <LeadsPage />
                </RequireScreen>
              </RequireAuth>
            }
          />
          <Route
            path="/config"
            element={
              <RequireAuth>
                <RequireScreen screen="config">
                  <ConfigPage />
                </RequireScreen>
              </RequireAuth>
            }
          />
          <Route
            path="/notices"
            element={
              <RequireAuth>
                <RequireScreen screen="notices">
                  <NoticesPage />
                </RequireScreen>
              </RequireAuth>
            }
          />
          <Route
            path="/users/:userId"
            element={
              <RequireAuth>
                <RequireScreen screen="portalUser">
                  <UserActivityPage />
                </RequireScreen>
              </RequireAuth>
            }
          />
          <Route
            path="/admin/users"
            element={
              <RequireAuth>
                <RequireScreen screen="adminUsers">
                  <AdminUsersPage />
                </RequireScreen>
              </RequireAuth>
            }
          />
          <Route
            path="/crm"
            element={
              <RequireAuth>
                <RequireScreen screen="crm">
                  <LedgerPage />
                </RequireScreen>
              </RequireAuth>
            }
          />
          <Route
            path="/crm/review"
            element={
              <RequireAuth>
                <RequireScreen screen="crmReview">
                  <ReviewPage />
                </RequireScreen>
              </RequireAuth>
            }
          />
          <Route
            path="/crm/cases/:caseId"
            element={
              <RequireAuth>
                <RequireScreen screen="crm">
                  <CasePage />
                </RequireScreen>
              </RequireAuth>
            }
          />
          <Route
            path="/no-access"
            element={
              <RequireAuth>
                <NoAccessPage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AppProviders>
  </StrictMode>,
);
