import type { ReactNode } from "react";

type HeadingProps = {
  /** "display" is the hero size (Home); 1 = page title, 2 = section, 3 = card title. */
  level?: "display" | 1 | 2 | 3;
  /** The element to render, when it should differ from the level (e.g. a display-size h1). */
  as?: "h1" | "h2" | "h3" | "p";
  id?: string;
  children: ReactNode;
  className?: string;
};

/**
 * Felyn's display type scale (Fraunces):
 * display 36→50px · page title 36→44px · section 28→32px · card title 20→22px.
 */
export const headingStyles = {
  display: "text-[2.25rem] leading-[1.1] sm:text-[2.625rem] lg:text-[3.125rem]",
  1: "text-4xl leading-[1.1] md:text-[2.75rem]",
  2: "text-[1.75rem] leading-tight md:text-[2rem]",
  3: "text-xl leading-snug md:text-[1.375rem]",
} as const;

/** Editorial display headings, set in Fraunces. Body copy stays on font-sans. */
export function Heading({ level = 2, as, id, children, className = "" }: HeadingProps) {
  const Tag = as ?? (level === "display" ? "h1" : (`h${level}` as "h1" | "h2" | "h3"));

  return (
    <Tag id={id} className={`font-display font-medium tracking-tight text-navy-950 ${headingStyles[level]} ${className}`}>
      {children}
    </Tag>
  );
}
