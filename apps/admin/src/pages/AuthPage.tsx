import { useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../lib/auth";

export function AuthPage() {
  const { isSignedIn, needsNewPassword, signIn, completeNewPassword } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  if (isSignedIn) return <Navigate to="/" replace />;

  async function handleSignIn(submitEvent: React.FormEvent) {
    submitEvent.preventDefault();
    setErrorMessage(null);
    setIsBusy(true);
    try {
      const signInOutcome = await signIn(email, password);
      if (signInOutcome === "signedIn") navigate("/");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleNewPassword(submitEvent: React.FormEvent) {
    submitEvent.preventDefault();
    setErrorMessage(null);
    if (newPassword !== confirmNewPassword) {
      setErrorMessage("Passwords do not match");
      return;
    }
    setIsBusy(true);
    try {
      await completeNewPassword(newPassword);
      navigate("/");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setIsBusy(false);
    }
  }

  const inputClasses =
    "w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm focus:border-ink/30";

  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-ink px-6 py-4 text-paper">
        <p className="mrz text-xs text-paper/70">RGS Admin</p>
        <h1 className="text-xl font-bold">Staff sign in</h1>
      </header>

      <div className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md rounded-2xl border border-line bg-paper p-8 shadow-[0_20px_60px_rgb(23_25_31/0.08)]">
          {needsNewPassword ? (
            <>
              <h2 className="text-2xl font-bold mb-2">Set a new password</h2>
              <p className="mb-6 text-sm text-ink-soft">
                Your account requires a new password before you can continue.
              </p>
              <form onSubmit={handleNewPassword} className="space-y-4">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">New password</span>
                  <input
                    className={inputClasses}
                    type="password"
                    value={newPassword}
                    onChange={(changeEvent) => setNewPassword(changeEvent.target.value)}
                    minLength={8}
                    required
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">Confirm new password</span>
                  <input
                    className={inputClasses}
                    type="password"
                    value={confirmNewPassword}
                    onChange={(changeEvent) => setConfirmNewPassword(changeEvent.target.value)}
                    minLength={8}
                    required
                  />
                </label>
                {errorMessage && (
                  <p className="rounded-lg bg-rgs-red/10 px-3 py-2 text-sm text-rgs-red-deep">
                    {errorMessage}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={isBusy}
                  className="w-full rounded-full bg-rgs-red px-6 py-3 font-semibold text-white hover:bg-rgs-red-deep transition-colors disabled:opacity-60"
                >
                  {isBusy ? "Please wait…" : "Update password & continue"}
                </button>
              </form>
            </>
          ) : (
            <>
              <h2 className="text-2xl font-bold mb-6">Sign in</h2>
              <form onSubmit={handleSignIn} className="space-y-4">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">Email</span>
                  <input
                    className={inputClasses}
                    type="email"
                    value={email}
                    onChange={(changeEvent) => setEmail(changeEvent.target.value)}
                    required
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">Password</span>
                  <input
                    className={inputClasses}
                    type="password"
                    value={password}
                    onChange={(changeEvent) => setPassword(changeEvent.target.value)}
                    minLength={8}
                    required
                  />
                </label>
                {errorMessage && (
                  <p className="rounded-lg bg-rgs-red/10 px-3 py-2 text-sm text-rgs-red-deep">
                    {errorMessage}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={isBusy}
                  className="w-full rounded-full bg-rgs-red px-6 py-3 font-semibold text-white hover:bg-rgs-red-deep transition-colors disabled:opacity-60"
                >
                  {isBusy ? "Please wait…" : "Sign in"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
