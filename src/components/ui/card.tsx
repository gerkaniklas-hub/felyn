import type { HTMLAttributes } from "react";

type CardProps = HTMLAttributes<HTMLDivElement>;

/** The default "cloud" surface used to lift content off the ivory page background. */
export function Card({ className = "", ...props }: CardProps) {
  return (
    <div
      className={`rounded-2xl border border-ivory-300 bg-ivory-200 p-6 shadow-sm ${className}`}
      {...props}
    />
  );
}
