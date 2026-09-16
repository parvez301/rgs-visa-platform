import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppProviders } from "./AppProviders";
import { useAuth } from "./lib/auth";
import { ActivityPage } from "./pages/ActivityPage";
import { ApplicationDetailPage } from "./pages/ApplicationDetailPage";
import { AuthPage } from "./pages/AuthPage";
import { ConfigPage } from "./pages/ConfigPage";
import { LeadsPage } from "./pages/LeadsPage";
import { CasePage } from "./crm/case/CasePage";
import { LedgerPage } from "./crm/ledger/LedgerPage";
import { NoticesPage } from "./pages/NoticesPage";
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
                <QueuePage />
              </RequireAuth>
            }
          />
          <Route
            path="/applications/:applicationId"
            element={
              <RequireAuth>
                <ApplicationDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/activity"
            element={
              <RequireAuth>
                <ActivityPage />
              </RequireAuth>
            }
          />
          <Route
            path="/leads"
            element={
              <RequireAuth>
                <LeadsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/config"
            element={
              <RequireAuth>
                <ConfigPage />
              </RequireAuth>
            }
          />
          <Route
            path="/notices"
            element={
              <RequireAuth>
                <NoticesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/users/:userId"
            element={
              <RequireAuth>
                <UserActivityPage />
              </RequireAuth>
            }
          />
          <Route
            path="/crm"
            element={
              <RequireAuth>
                <LedgerPage />
              </RequireAuth>
            }
          />
          <Route
            path="/crm/cases/:caseId"
            element={
              <RequireAuth>
                <CasePage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AppProviders>
  </StrictMode>,
);
