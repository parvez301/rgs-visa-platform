import { Link, NavLink, useLocation } from "react-router";
import type { ReactNode } from "react";
import { useAdminAccess } from "../lib/adminAccess";
import { useAuth } from "../lib/auth";
import { ADMIN_NAV_LINKS, type AdminNavLink } from "../lib/navLinks";

/**
 * Cases owns `/crm` and `/crm/cases/:id`, but not its sibling destinations
 * (Review, Status emails, Doc checklists) that also live under `/crm/...`.
 */
function isCasesParentActive(pathname: string): boolean {
  return pathname === "/crm" || pathname.startsWith("/crm/cases/");
}

function navLinkClassName(isActive: boolean, isChild: boolean): string {
  const base = `block rounded-md px-3 py-2 text-sm transition-colors ${isChild ? "ml-4" : ""}`;
  return `${base} ${
    isActive ? "bg-paper/10 font-semibold text-paper" : "text-paper/70 hover:bg-paper/5 hover:text-paper"
  }`;
}

function SidebarNavLink({ navLink, pathname }: { navLink: AdminNavLink; pathname: string }) {
  const { canAccess } = useAdminAccess();
  const accessibleChildren = (navLink.children ?? []).filter((childLink) =>
    canAccess(childLink.screen),
  );

  return (
    <li>
      <NavLink
        to={navLink.to}
        end={navLink.to === "/" || navLink.children !== undefined}
        className={({ isActive }) =>
          navLinkClassName(
            navLink.children !== undefined ? isCasesParentActive(pathname) : isActive,
            false,
          )
        }
      >
        {navLink.label}
      </NavLink>
      {accessibleChildren.length > 0 && (
        <ul className="mt-1 space-y-1">
          {accessibleChildren.map((childLink) => (
            <li key={childLink.to}>
              <NavLink
                to={childLink.to}
                className={({ isActive }) => navLinkClassName(isActive, true)}
              >
                {childLink.label}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * `contentWidth` only caps the content column inside the main pane: the
 * visa-platform pages read best in 1152px, the CRM grid + agent panel want
 * ~1440px, and `full` opts out. Chrome is identical on every screen.
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
  const { pathname } = useLocation();
  const widthClass =
    contentWidth === "full" ? "max-w-none" : contentWidth === "wide" ? "max-w-[90rem]" : "max-w-6xl";

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-[220px] shrink-0 flex-col bg-ink text-paper">
        <Link to="/" className="flex items-center gap-3 px-4 py-5">
          <img
            src="/brand/rgs-logo.png"
            alt="Rays Global Services"
            className="h-6 w-auto brightness-0 invert"
          />
          <span className="mrz rounded border border-rgs-red px-1.5 py-0.5 text-[10px] text-rgs-red">
            Admin
          </span>
        </Link>
        <nav className="flex-1 overflow-y-auto px-3 py-2">
          <ul className="space-y-1">
            {ADMIN_NAV_LINKS.filter((navLink) => canAccess(navLink.screen)).map((navLink) => (
              <SidebarNavLink key={navLink.to} navLink={navLink} pathname={pathname} />
            ))}
          </ul>
        </nav>
        <div className="space-y-3 border-t border-paper/10 px-4 py-4">
          <p className="truncate text-xs text-paper/60" title={email ?? undefined}>
            {email}
          </p>
          <button
            type="button"
            onClick={signOut}
            className="w-full rounded-full border border-paper/30 px-4 py-1.5 text-sm hover:bg-paper/10 transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto bg-paper">
        <div className={`mx-auto ${widthClass} px-6 ${contentWidth === "default" ? "py-8" : "py-6"}`}>
          {children}
        </div>
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
