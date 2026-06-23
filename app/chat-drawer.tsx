"use client";

import { useEffect, useRef, useState } from "react";
import { streamRedesign, type Message } from "./agent";
import { StudioMarkdown } from "./markdown";

export interface DrawerConfig {
  title: string;
  eyebrow: string;
  /** Seed conversation. If it ends in a user message, the drawer auto-runs it. */
  seed: Message[];
  /** When provided, assistant replies show an "adopt" button. */
  onAdopt?: (text: string) => void;
  adoptLabel?: string;
}

/** Strips Markdown noise so an adopted reply reads cleanly as a short answer. */
function plainify(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/[*_`>]/g, "")
    .trim();
}

export function ChatDrawer({
  config,
  onClose,
}: {
  config: DrawerConfig;
  onClose: () => void;
}) {
  const seedEndsUser = config.seed[config.seed.length - 1]?.role === "user";

  const [messages, setMessages] = useState<Message[]>(
    seedEndsUser ? [...config.seed, { role: "assistant", content: "" }] : config.seed,
  );
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(seedEndsUser);
  const [error, setError] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // Performs the request; all setState happens after the first await,
  // so this is safe to kick off from an effect without cascading renders.
  async function stream(history: Message[]) {
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamRedesign(
        history,
        (delta) =>
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, content: last.content + delta };
            return next;
          }),
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError((err as Error).message);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && last.content === "") {
          return prev.slice(0, -1);
        }
        return prev;
      });
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  }

  function run(history: Message[]) {
    setError(null);
    setPending(true);
    setMessages([...history, { role: "assistant", content: "" }]);
    void stream(history);
  }

  // Auto-run the seed once if it's waiting on an assistant reply. State is
  // already primed with the placeholder, so the effect only does async work.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    // stream() only setStates after its first await (streaming an external
    // source), which is the blessed pattern — the rule can't see through it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (seedEndsUser) void stream(config.seed);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || pending) return;
    setInput("");
    run([...messages, { role: "user", content: text }]);
  }

  const streamingLast =
    pending && messages.length > 0 && messages[messages.length - 1].role === "assistant";

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-canvas/70 backdrop-blur-sm animate-fade-in"
      />
      <aside className="animate-slide-in relative flex h-full w-full max-w-md flex-col border-l border-line bg-panel shadow-2xl sm:max-w-lg">
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div>
            <p className="font-mono text-[0.6rem] uppercase tracking-[0.24em] text-amber">
              {config.eyebrow}
            </p>
            <h2 className="mt-1 font-display text-xl font-semibold text-ink">
              {config.title}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="-mr-1 rounded-full border border-line p-1.5 text-ink-soft transition-colors hover:border-line-bright hover:text-ink"
            aria-label="Close chat"
          >
            <span aria-hidden>✕</span>
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            const showThinking =
              streamingLast && isLast && m.role === "assistant" && m.content === "";

            if (m.role === "user") {
              return (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-line bg-card px-4 py-3 text-[0.95rem] text-ink-soft">
                    {m.content}
                  </div>
                </div>
              );
            }

            return (
              <div key={i}>
                {showThinking ? (
                  <div className="flex items-center gap-1.5 py-1">
                    <span className="think-dot" style={{ animationDelay: "0ms" }} />
                    <span className="think-dot" style={{ animationDelay: "150ms" }} />
                    <span className="think-dot" style={{ animationDelay: "300ms" }} />
                  </div>
                ) : (
                  <div className="studio-prose text-[0.95rem]">
                    <StudioMarkdown>{m.content}</StudioMarkdown>
                    {streamingLast && isLast && <span className="caret" aria-hidden />}
                    {config.onAdopt && !streamingLast && m.content.trim() && (
                      <button
                        onClick={() => {
                          config.onAdopt?.(plainify(m.content));
                          onClose();
                        }}
                        className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-mint px-4 py-1.5 text-sm font-semibold text-[#06231a] transition-colors hover:bg-mint-deep"
                      >
                        {config.adoptLabel ?? "Use this"}
                        <span aria-hidden>→</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-rose/40 bg-rose/10 px-4 py-3 text-sm text-ink"
            >
              {error}
            </div>
          )}
          <div ref={endRef} />
        </div>

        <form onSubmit={send} className="border-t border-line px-4 py-4">
          <div className="flex items-end gap-2 rounded-xl border border-line bg-card px-3 py-2 transition-colors focus-within:border-mint focus-within:ring-4 focus-within:ring-mint/15">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(e);
                }
              }}
              rows={1}
              placeholder="Push back, add detail, ask for another angle…"
              className="max-h-32 flex-1 resize-none bg-transparent py-1 text-[0.95rem] text-ink placeholder:text-ink-faint focus:outline-none"
            />
            <button
              type="submit"
              disabled={!input.trim() || pending}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-mint text-[#06231a] transition-colors hover:bg-mint-deep disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Send"
            >
              {pending ? <span className="think-dot bg-[#06231a]" /> : <span aria-hidden>↑</span>}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}
