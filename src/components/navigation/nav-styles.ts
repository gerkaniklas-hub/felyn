/**
 * The navigation's two row styles, shared by AppSidebar, HelpLink and the
 * notification bell so every row in the frame has the same height, icon
 * size, spacing and selected state.
 *
 * - Primary items (Home, Explore, …): full rows in the sidebar.
 * - Utilities (Help, Notifications, Log out): a round icon button in the
 *   phone top bar, a centred square on the tablet rail, and a quieter,
 *   labelled row on desktop.
 *
 * `tone` picks the surface the navigation sits on: "light" (the guest app and
 * the host application, the default) or "host" (the approved host workspace's
 * navy shell — ivory text, a navy-800 selected row with a thin sky accent).
 */
export type NavTone = "light" | "host";

/** The selected host row: lifted navy with a thin sky edge on the left. */
const HOST_ACTIVE = "bg-navy-800 text-ivory-50 shadow-[inset_3px_0_0_var(--color-sky-400)]";
const HOST_IDLE = "text-navy-300 hover:bg-navy-900 hover:text-ivory-50";

export function navItemClass(active: boolean, tone: NavTone = "light"): string {
  if (tone === "host") {
    return `flex h-11 items-center justify-center gap-3 rounded-xl px-3 text-[15px] font-medium transition-colors lg:justify-start ${
      active ? HOST_ACTIVE : HOST_IDLE
    }`;
  }
  return `flex h-11 items-center justify-center gap-3 rounded-xl px-3 text-[15px] font-medium transition-colors lg:justify-start ${
    active ? "bg-sky-50 text-sky-700" : "text-navy-600 hover:bg-ivory-200 hover:text-navy-950"
  }`;
}

export function navUtilityClass(active = false, tone: NavTone = "light"): string {
  if (tone === "host") {
    return `relative inline-flex h-9 w-9 shrink-0 items-center justify-center gap-3 rounded-full transition-colors md:h-11 md:w-11 md:rounded-xl lg:w-full lg:justify-start lg:px-3 lg:text-sm lg:font-medium ${
      active ? HOST_ACTIVE : HOST_IDLE
    }`;
  }
  return `relative inline-flex h-9 w-9 shrink-0 items-center justify-center gap-3 rounded-full transition-colors md:h-11 md:w-11 md:rounded-xl lg:w-full lg:justify-start lg:px-3 lg:text-sm lg:font-medium ${
    active ? "bg-sky-50 text-sky-700" : "text-navy-500 hover:bg-ivory-200 hover:text-navy-900"
  }`;
}
