/**
 * The Felyn Team's avatar in Messages: the app's compact "F." mark (as in the
 * navigation rail) on a navy disc. Size comes from `className`, like the other
 * avatars in the inbox (e.g. "h-11 w-11").
 */
export function FelynTeamAvatar({ className = "h-11 w-11" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-navy-900 font-display text-lg font-medium tracking-tight text-ivory-50 ${className}`}
    >
      F<span className="text-gold-500">.</span>
    </span>
  );
}
