type LogoProps = {
  /** "default" = deep navy wordmark on ivory. "reverse" = ivory wordmark on navy. */
  variant?: "default" | "reverse";
  size?: "sm" | "md" | "lg";
  className?: string;
};

const sizes = {
  sm: "text-lg",
  md: "text-2xl",
  lg: "text-4xl",
} as const;

/**
 * The Felyn wordmark. The period is always the golden-hour accent —
 * the only place gold appears as a fixed brand mark rather than a
 * sparing UI highlight. Never use the dot alone as an app icon.
 */
export function Logo({ variant = "default", size = "md", className = "" }: LogoProps) {
  const textColor = variant === "reverse" ? "text-ivory-50" : "text-navy-950";

  return (
    <span
      className={[
        "font-display font-medium tracking-tight",
        sizes[size],
        textColor,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      Felyn<span className="text-gold-500">.</span>
    </span>
  );
}
