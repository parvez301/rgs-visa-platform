import { Link, NavLink } from "react-router";
import type { ReactNode } from "react";
import { useAuth } from "../lib/auth";

const NAV_LINKS = [
  { label: "Queue", to: "/" },
  { label: "Activity", to: "/activity" },
  { label: "Leads", to: "/leads" },
  { label: "Config", to: "/config" },
] as const;

export function AdminShell({ children }: { children: ReactNode }) {
  const { email, signOut } = useAuth();

  return (
    <div className="min-h-screen">
      <header className="bg-ink text-paper">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="mrz text-xs text-paper/70">RGS Admin</p>
            <p className="text-sm text-paper/90">{email}</p>
          </div>
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
