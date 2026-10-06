import { Card } from "@/components/ui/card";
import { PageContainer } from "@/components/ui/page";

/**
 * Shown while /recommendations' data (stay lookup + hard-filter + AI
 * ranking) loads — Next.js wraps page.tsx in a Suspense boundary using
 * this file automatically. Mirrors the Stay Planner's two-column shape so
 * the transition into the real layout feels continuous.
 */
export default function RecommendationsLoading() {
  return (
    <PageContainer>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[30%_1fr]">
        <div className="flex flex-col gap-3">
          <div className="h-3 w-20 animate-pulse rounded bg-ivory-300" />
          <div className="h-5 w-2/3 animate-pulse rounded bg-ivory-300" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-ivory-300" />
        </div>
        <div className="flex flex-col gap-6">
          <div className="h-8 w-2/3 animate-pulse rounded bg-ivory-300" />
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="flex flex-col gap-4">
                <div className="aspect-[4/3] w-full animate-pulse rounded-xl bg-ivory-300" />
                <div className="h-5 w-2/3 animate-pulse rounded bg-ivory-300" />
                <div className="h-4 w-1/3 animate-pulse rounded bg-ivory-300" />
              </Card>
            ))}
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
