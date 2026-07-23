import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../lib/auth";

type AuthMode = "signIn" | "signUp" | "confirm";

export function AuthPage() {
  const { signIn, signUp, confirmSignUp } = useAuth();
  const navigate = useNavigate();
  const [authMode, setAuthMode] = useState<AuthMode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [confirmationCode, setConfirmationCode] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  async function handleSubmit(submitEvent: React.FormEvent) {
    submitEvent.preventDefault();
    setErrorMessage(null);
    setIsBusy(true);
    try {
      if (authMode === "signIn") {
        await signIn(email, password);
        navigate("/");
      } else if (authMode === "signUp") {
        await signUp(email, password, fullName, phone);
        setAuthMode("confirm");
      } else {
        await confirmSignUp(email, confirmationCode);
        await signIn(email, password);
        navigate("/");
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Something went wrong");
    } finally {
      setIsBusy(false);
    }
  }

  const inputClasses =
    "w-full rounded-xl border border-line bg-paper px-4 py-3 text-sm focus:border-ink/30";

  return (
    <div className="speedlines flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <img
        src="/brand/rgs-logo.png"
        alt="Rays Global Services"
        className="mb-6 h-8 w-auto"
      />
      <div className="relative w-full max-w-md rounded-2xl border border-line bg-paper p-8 shadow-[0_20px_60px_rgb(23_25_31/0.08)]">
        <div
          className="stamp pointer-events-none absolute -top-4 -right-4 rounded-md border-2 border-rgs-red bg-paper/90 px-2.5 py-1"
          aria-hidden="true"
        >
          <span className="mrz text-[9px] font-semibold text-rgs-red">Visas on time</span>
        </div>
        <p className="mrz text-xs text-rgs-red mb-2">RGS Visa Portal</p>
        <h1 className="text-2xl font-bold mb-6">
          {authMode === "signIn" && "Sign in to your account"}
          {authMode === "signUp" && "Create your account"}
          {authMode === "confirm" && "Check your email"}
        </h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          {authMode === "confirm" ? (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">
                Verification code sent to {email}
              </span>
              <input
                className={inputClasses}
                value={confirmationCode}
                onChange={(changeEvent) => setConfirmationCode(changeEvent.target.value)}
                inputMode="numeric"
                required
              />
            </label>
          ) : (
            <>
              {authMode === "signUp" && (
                <>
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">Full name</span>
                    <input
                      className={inputClasses}
                      value={fullName}
                      onChange={(changeEvent) => setFullName(changeEvent.target.value)}
                      required
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">
                      Phone (with country code)
                    </span>
                    <input
                      className={inputClasses}
                      type="tel"
                      placeholder="+91…"
                      value={phone}
                      onChange={(changeEvent) => setPhone(changeEvent.target.value)}
                    />
                  </label>
                </>
              )}
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
            </>
          )}

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
            {isBusy
              ? "Please wait…"
              : authMode === "signIn"
                ? "Sign in"
                : authMode === "signUp"
                  ? "Create account"
                  : "Verify & continue"}
          </button>
        </form>

        {authMode !== "confirm" && (
          <p className="mt-5 text-center text-sm text-ink-soft">
            {authMode === "signIn" ? (
              <>
                New to RGS?{" "}
                <button
                  className="font-semibold text-rgs-red hover:underline"
                  onClick={() => setAuthMode("signUp")}
                >
                  Create an account
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  className="font-semibold text-rgs-red hover:underline"
                  onClick={() => setAuthMode("signIn")}
                >
                  Sign in
                </button>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
