import { useAuth } from "../lib/auth";

export function NoAccessPage() {
  const { email, signOut } = useAuth();

  return (
    <main className="flex min-h-screen items-center justify-center bg-mist px-6">
      <section className="w-full max-w-lg rounded-2xl bg-paper p-8 text-center shadow-sm">
        <p className="mrz mb-3 text-xs uppercase tracking-widest text-rgs-red">Access restricted</p>
        <h1 className="text-2xl font-bold text-ink">You do not have access to this screen</h1>
        <p className="mt-3 text-sm text-ink-soft">
          {email
            ? `${email} is signed in without the required admin role.`
            : "Your account does not have the required admin role."}
        </p>
        <button
          type="button"
          onClick={signOut}
          className="mt-6 rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-paper"
        >
          Sign out
        </button>
      </section>
    </main>
  );
}
