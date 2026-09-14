import type { ReactNode } from "react";

type HeadingProps = {
  level?: 1 | 2 | 3;
  children: ReactNode;
  className?: string;
};

const styles = {
  1: "text-4xl sm:text-5xl leading-tight",
  2: "text-3xl leading-snug",
  3: "text-xl leading-snug",
} as const;

/** Editorial display headings, set in Fraunces. Body copy stays on font-sans. */
export function Heading({ level = 2, children, className = "" }: HeadingProps) {
  const Tag = `h${level}` as "h1" | "h2" | "h3";

  return (
    <Tag
      className={`font-display font-medium tracking-tight text-navy-950 ${styles[level]} ${className}`}
    >
      {children}
    </Tag>
  );
}
