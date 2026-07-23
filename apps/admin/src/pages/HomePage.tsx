import { Link } from "react-router";
import { useAuth } from "../lib/auth";

const navLinks = [
  { label: "Queue", to: "#" },
  { label: "Activity", to: "#" },
  { label: "Leads", to: "#" },
  { label: "Config", to: "#" },
] as const;

export function HomePage() {
  const { email, signOut } = useAuth();

  return (
    <div className="min-h-screen">
      <header className="bg-ink text-paper">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <p className="mrz text-xs text-paper/70">RGS Admin</p>
            <p className="text-sm text-paper/90">{email}</p>
          </div>
          <nav className="flex flex-wrap items-center gap-4 text-sm">
            {navLinks.map((navLink) => (
              <Link
                key={navLink.label}
                to={navLink.to}
                className="text-paper/80 hover:text-paper transition-colors"
              >
                {navLink.label}
              </Link>
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

      <main className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="text-3xl font-bold mb-3">Admin queue coming in Task 8</h1>
        <p className="text-ink-soft max-w-xl">
          Application review, activity feed, leads, and country configuration will land in the
          next task. You are signed in and ready.
        </p>
      </main>
    </div>
  );
}
