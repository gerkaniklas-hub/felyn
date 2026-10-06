/**
 * The navigation's two row styles, shared by AppSidebar, HelpLink and the
 * notification bell so every row in the frame has the same height, icon
 * size, spacing and selected state.
 *
 * - Primary items (Home, Explore, …): full rows in the sidebar.
 * - Utilities (Help, Notifications, Log out): a round icon button in the
 *   phone top bar, a centred square on the tablet rail, and a quieter,
 *   labelled row on desktop.
 */
export function navItemClass(active: boolean): string {
  return `flex h-11 items-center justify-center gap-3 rounded-xl px-3 text-[15px] font-medium transition-colors lg:justify-start ${
    active ? "bg-sky-50 text-sky-700" : "text-navy-600 hover:bg-ivory-200 hover:text-navy-950"
  }`;
}

export function navUtilityClass(active = false): string {
  return `relative inline-flex h-9 w-9 shrink-0 items-center justify-center gap-3 rounded-full transition-colors md:h-11 md:w-11 md:rounded-xl lg:w-full lg:justify-start lg:px-3 lg:text-sm lg:font-medium ${
    active ? "bg-sky-50 text-sky-700" : "text-navy-500 hover:bg-ivory-200 hover:text-navy-900"
  }`;
}
