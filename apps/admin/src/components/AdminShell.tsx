import { Link, NavLink } from "react-router";
import type { ReactNode } from "react";
import { useAuth } from "../lib/auth";

const NAV_LINKS = [
  { label: "Queue", to: "/" },
  { label: "Activity", to: "/activity" },
  { label: "Leads", to: "/leads" },
  { label: "Notices", to: "/notices" },
  { label: "Config", to: "/config" },
  { label: "CRM", to: "/crm" },
] as const;

export function AdminShell({ children }: { children: ReactNode }) {
  const { email, signOut } = useAuth();

  return (
    <div className="min-h-screen">
      <header className="bg-ink text-paper">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
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
            {NAV_LINKS.map((navLink) => (
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
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
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
