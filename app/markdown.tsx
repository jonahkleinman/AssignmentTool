"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const components: Components = {
  h3: ({ children }) => (
    <h3 className="mt-6 flex items-baseline gap-2.5 font-display text-[1.3rem] font-semibold leading-tight text-ink first:mt-0">
      <span aria-hidden className="text-mint">
        ◇
      </span>
      <span>{children}</span>
    </h3>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-mint">{children}</strong>
  ),
};

export function StudioMarkdown({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </Markdown>
  );
}
