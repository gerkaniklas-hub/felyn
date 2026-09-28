import type { ReactNode } from "react";
import { ProviderNav } from "@/components/provider/ProviderNav";

export default function ProviderLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <ProviderNav />
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 lg:px-8">{children}</div>
    </div>
  );
}
