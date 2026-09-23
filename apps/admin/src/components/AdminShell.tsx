import { Link, NavLink } from "react-router";
import type { ReactNode } from "react";
import type { AdminScreen } from "@rgs/shared";
import { useAdminAccess } from "../lib/adminAccess";
import { useAuth } from "../lib/auth";

const NAV_LINKS: ReadonlyArray<{
  label: string;
  to: string;
  screen: AdminScreen;
}> = [
  { label: "Queue", to: "/", screen: "queue" },
  { label: "Activity", to: "/activity", screen: "activity" },
  { label: "Leads", to: "/leads", screen: "leads" },
  { label: "Notices", to: "/notices", screen: "notices" },
  { label: "Config", to: "/config", screen: "config" },
  { label: "CRM", to: "/crm", screen: "crm" },
  { label: "Users", to: "/admin/users", screen: "adminUsers" },
] as const;

/**
 * `contentWidth`: the visa-platform pages read best in a 1152px column; the
 * CRM needs more room for its grid + agent panel but not the raw viewport --
 * edge-to-edge on ultrawide stretches filters and thins row cells. `wide`
 * caps around 1440px and centers the sheet.
 */
export function AdminShell({
  children,
  contentWidth = "default",
}: {
  children: ReactNode;
  contentWidth?: "default" | "wide" | "full";
}) {
  const { email, signOut } = useAuth();
  const { canAccess } = useAdminAccess();
  const widthClass =
    contentWidth === "full" ? "max-w-none" : contentWidth === "wide" ? "max-w-[90rem]" : "max-w-6xl";
  const isCrmWide = contentWidth === "wide";

  return (
    <div className={`min-h-screen ${isCrmWide ? "bg-mist" : ""}`}>
      <header className="bg-ink text-paper">
        <div className={`mx-auto flex ${widthClass} items-center justify-between gap-4 px-6 py-4`}>
          <Link to="/" className="flex items-center gap-3">
            <img
              src="/brand/rgs-logo.png"
              alt="Rays Global Services"
              className="h-6 w-auto brightness-0 invert"
            />
            <span className="mrz rounded border border-rgs-red px-1.5 py-0.5 text-[10px] text-rgs-red">
              Admin
            </span>
            <span className="hidden md:inline text-xs text-paper/60">{email}</span>
          </Link>
          <nav className="flex flex-wrap items-center gap-4 text-sm">
            {NAV_LINKS.filter((navLink) => canAccess(navLink.screen)).map((navLink) => (
              <NavLink
                key={navLink.to}
                to={navLink.to}
                end={navLink.to === "/"}
                className={({ isActive }) =>
                  `transition-colors ${isActive ? "text-paper font-semibold" : "text-paper/80 hover:text-paper"}`
                }
              >
                {navLink.label}
              </NavLink>
            ))}
            <button
              type="button"
              onClick={signOut}
              className="rounded-full border border-paper/30 px-4 py-1.5 text-sm hover:bg-paper/10 transition-colors"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>
      <main
        className={`mx-auto ${widthClass} px-6 ${
          contentWidth === "default" ? "py-8" : "py-6"
        } ${isCrmWide ? "rounded-t-2xl bg-paper shadow-sm shadow-ink/5" : ""}`}
      >
        {children}
      </main>
    </div>
  );
}

export function AdminPageLink({
  to,
  children,
}: {
  to: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} className="text-rgs-red font-medium hover:underline">
      {children}
    </Link>
  );
}
