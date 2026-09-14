import type { ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
};

const base =
  "inline-flex items-center justify-center rounded-full font-sans font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ivory-100 disabled:cursor-not-allowed disabled:opacity-40";

const variants = {
  primary: "bg-navy-900 text-ivory-50 hover:bg-navy-950",
  secondary: "border border-navy-300 bg-transparent text-navy-900 hover:bg-ivory-200",
  ghost: "bg-transparent text-sky-600 hover:bg-sky-50 hover:text-sky-700",
} as const;

const sizes = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-6 text-base",
  lg: "h-12 px-7 text-base",
} as const;

/**
 * Primary CTAs use the navy fill. Gold is a brand accent, not a button
 * color — keep it out of interactive surfaces so it stays rare.
 */
export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}
