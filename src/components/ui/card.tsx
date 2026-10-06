import type { HTMLAttributes } from "react";

type CardProps = HTMLAttributes<HTMLDivElement>;

/**
 * The Felyn card surface: warm near-white on the ivory page, a 1px warm
 * border, the 20px card radius and a barely-there shadow. Hand-built card
 * compositions (photo cards, list rows) use the same `cardSurface` recipe
 * so every card in the app shares one visual language.
 */
export const cardSurface = "rounded-card border border-ivory-300 bg-ivory-50 shadow-card";

export function Card({ className = "", ...props }: CardProps) {
  return <div className={`${cardSurface} p-6 ${className}`} {...props} />;
}
