"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function EvalAccessGate({
  configured,
  labeler,
  title = "Retrieval relevance labeling",
  description = "This workspace records expert judgments about which background sources can genuinely help redesign each assignment. Scores remain hidden from the retrieval system until labeling is complete.",
}: {
  configured: boolean;
  labeler: string;
  title?: string;
  description?: string;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!configured || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/eval/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Access could not be verified.");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Access could not be verified.");
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-5xl flex-1 items-center px-5 py-12 sm:px-8">
      <div className="grid w-full overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl shadow-black/25 md:grid-cols-[1.1fr_0.9fr]">
        <section className="border-b border-line p-7 sm:p-10 md:border-b-0 md:border-r">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.2em] text-mint">
            Private review desk
          </p>
          <h1 className="mt-5 max-w-xl font-display text-4xl font-semibold leading-[0.98] tracking-[-0.04em] text-ink sm:text-5xl">
            {title}
          </h1>
          <p className="mt-6 max-w-lg text-base leading-relaxed text-ink-soft">
            {description}
          </p>
          <div className="mt-8 inline-flex rounded-full border border-line-bright px-3 py-1.5 font-mono text-[0.65rem] uppercase tracking-[0.14em] text-ink-faint">
            Labeler · {labeler}
          </div>
        </section>

        <section className="flex items-center p-7 sm:p-10">
          <form className="w-full" onSubmit={submit}>
            <label htmlFor="eval-access-code" className="block text-sm font-semibold text-ink">
              Shared access code
            </label>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-faint">
              Enter the code provided with your labeling link. Access lasts for two weeks on this
              browser.
            </p>
            <input
              id="eval-access-code"
              type="password"
              autoComplete="current-password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={!configured || loading}
              className="mt-5 w-full rounded-lg border border-line-bright bg-canvas px-4 py-3 text-ink placeholder:text-ink-faint focus:border-mint disabled:opacity-50"
              placeholder="Enter access code"
              required
              autoFocus
            />
            {error && (
              <p role="alert" className="mt-3 text-sm text-rose">
                {error}
              </p>
            )}
            {!configured && (
              <p role="alert" className="mt-3 text-sm text-amber">
                Access has not been configured on this deployment. Ask the site owner to add
                EVAL_ACCESS_CODE.
              </p>
            )}
            <button
              type="submit"
              disabled={!configured || loading || !code.trim()}
              className="mt-5 w-full rounded-lg bg-mint px-4 py-3 text-sm font-bold text-mint-ink hover:bg-mint-deep disabled:cursor-not-allowed disabled:opacity-40"
            >
              {loading ? "Checking…" : "Open review desk"}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
