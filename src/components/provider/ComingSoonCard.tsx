import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";

/** P1: a calm, honest "not built yet" state for provider nav destinations beyond the dashboard/calendar. */
export function ComingSoonCard({ title, description }: { title: string; description: string }) {
  return (
    <Card className="mx-auto max-w-md text-center">
      <Heading level={2}>{title}</Heading>
      <p className="mt-2 text-navy-500">{description}</p>
    </Card>
  );
}
