import type { ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "sm" | "md" | "lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

const base =
  "inline-flex items-center justify-center gap-2 rounded-full font-sans font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ivory-100 disabled:cursor-not-allowed disabled:opacity-40";

const variants = {
  primary: "bg-navy-900 text-ivory-50 hover:bg-navy-950",
  secondary: "border border-navy-200 bg-ivory-50 text-navy-900 hover:border-navy-300 hover:bg-ivory-200",
  ghost: "bg-transparent text-sky-600 hover:bg-sky-50 hover:text-sky-700",
} as const;

const sizes = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-6 text-[15px]",
  lg: "h-12 px-7 text-base",
} as const;

/**
 * The button look as a class string, so a next/link <Link> (a navigation,
 * not an action) can share exactly the same treatment as <Button>.
 */
export function buttonClasses({
  variant = "primary",
  size = "md",
  className = "",
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return `${base} ${variants[variant]} ${sizes[size]} ${className}`;
}

/**
 * Primary CTAs use the navy fill. Gold is a brand accent, not a button
 * color — keep it out of interactive surfaces so it stays rare.
 */
export function Button({ variant = "primary", size = "md", className = "", ...props }: ButtonProps) {
  return <button className={buttonClasses({ variant, size, className })} {...props} />;
}
