import { Badge } from "@/components/ui/badge";
import { SUPPORT_STATUS_LABELS, type SupportStatus } from "@/lib/support/constants";

/** OPEN needs attention (sky); RESOLVED and CLOSED are calm (navy). */
export function StaffStatusBadge({ status, className = "" }: { status: SupportStatus; className?: string }) {
  return (
    <Badge tone={status === "OPEN" ? "sky" : "navy"} className={`text-[10px] ${status === "CLOSED" ? "opacity-70" : ""} ${className}`}>
      {SUPPORT_STATUS_LABELS[status]}
    </Badge>
  );
}
