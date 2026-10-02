import type { ReactNode, SVGProps } from "react";

/**
 * Felyn's small outline icon set: one 24px grid, one stroke weight, round
 * caps/joins, always `currentColor`. Deliberately inline SVG (no icon
 * dependency); add new icons here rather than mixing in another style.
 */
type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, className = "h-5 w-5", ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      {children}
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 10.5 12 3.75l8.5 6.75" />
      <path d="M5.5 9v10.25h4.75V14.5h3.5v4.75h4.75V9" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.25" />
      <path d="m15.75 15.75 4.5 4.5" />
    </Icon>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20.25 11.5c0 4.14-3.69 7.25-8.25 7.25-1.1 0-2.15-.18-3.11-.51L4 19.75l1.24-3.55C4.29 14.9 3.75 13.25 3.75 11.5c0-4.14 3.69-7.25 8.25-7.25s8.25 3.11 8.25 7.25Z" />
    </Icon>
  );
}

export function SuitcaseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.75" y="7.25" width="16.5" height="12.5" rx="2.5" />
      <path d="M9 7.25V5.5A1.75 1.75 0 0 1 10.75 3.75h2.5A1.75 1.75 0 0 1 15 5.5v1.75" />
      <path d="M3.75 12.5h16.5" />
    </Icon>
  );
}

export function UserIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8.25" r="3.75" />
      <path d="M4.75 20c.9-3.4 3.83-5.5 7.25-5.5s6.35 2.1 7.25 5.5" />
    </Icon>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.75" y="5.25" width="16.5" height="15" rx="2.5" />
      <path d="M3.75 10h16.5M8.25 3.25v3.5M15.75 3.25v3.5" />
    </Icon>
  );
}

export function CalendarCheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.75" y="5.25" width="16.5" height="15" rx="2.5" />
      <path d="M3.75 10h16.5M8.25 3.25v3.5M15.75 3.25v3.5" />
      <path d="m9.25 15 1.9 1.75 3.6-3.5" />
    </Icon>
  );
}

export function GridIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.75" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.75" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.75" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.75" />
    </Icon>
  );
}

export function DocumentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 3.75H7.5a2 2 0 0 0-2 2v12.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.25L14 3.75Z" />
      <path d="M14 3.75v4.5h4.5M9 13h6M9 16.5h4" />
    </Icon>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.25 16.5V11a5.75 5.75 0 0 1 11.5 0v5.5l1.5 1.75H4.75l1.5-1.75Z" />
      <path d="M10 20.25a2.25 2.25 0 0 0 4 0" />
    </Icon>
  );
}

export function LogOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14.5 4.75H7a2 2 0 0 0-2 2v10.5a2 2 0 0 0 2 2h7.5" />
      <path d="M11 12h9.25M17 8.5l3.5 3.5-3.5 3.5" />
    </Icon>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19.25 12H4.75M10.5 6.25 4.75 12l5.75 5.75" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function MapPinIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18.75 10.25c0 5-6.75 10-6.75 10s-6.75-5-6.75-10a6.75 6.75 0 0 1 13.5 0Z" />
      <circle cx="12" cy="10.25" r="2.25" />
    </Icon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.75V12l2.75 1.75" />
    </Icon>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9.5" cy="8.5" r="3.25" />
      <path d="M3.75 19.25c.75-2.9 3.1-4.75 5.75-4.75s5 1.85 5.75 4.75" />
      <path d="M15.5 5.5a3.25 3.25 0 0 1 0 6M17.25 14.75c1.6.6 2.65 2.1 3 4.5" />
    </Icon>
  );
}
