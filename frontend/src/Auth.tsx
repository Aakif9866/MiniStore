import { useState, type FormEvent } from "react";
import { api, setToken } from "./api";
import { Logo } from "./App";

export function Auth() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    setBusy(true);
    setError("");
    try {
      if (mode === "register") await api.register(email, password);
      setToken((await api.login(email, password)).token);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const input =
    "w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 outline-none transition-colors duration-150 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/30 dark:border-white/10 dark:bg-ink-800";

  return (
    <main className="grid min-h-[calc(100dvh-6px)] place-items-center p-4">
      <div className="w-full max-w-sm motion-safe:animate-rise">
        <div className="mb-8 text-center">
          <Logo />
          <h1 className="mt-6 text-3xl font-bold lg:text-4xl">
            {mode === "login" ? "Welcome back" : "Create your space"}
          </h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Your files in object storage, metadata in Postgres.
          </p>
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-tl-3xl rounded-br-3xl border border-gray-200 bg-white p-6 dark:border-white/10 dark:bg-ink-900"
        >
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Email</span>
            <input name="email" type="email" required autoComplete="email" className={input} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Password</span>
            <input
              name="password"
              type="password"
              required
              minLength={8}
              maxLength={128}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className={input}
            />
          </label>

          {error && (
            <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <button
            disabled={busy}
            className="brand-gradient w-full rounded-lg py-2.5 font-semibold text-white transition-transform duration-150 hover:brightness-110 active:scale-95 disabled:opacity-60"
          >
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {mode === "login" ? "New here? " : "Already have an account? "}
          <button
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
            className="font-medium text-teal-700 hover:underline dark:text-teal-400"
          >
            {mode === "login" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </div>
    </main>
  );
}
