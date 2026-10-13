"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const INTERVAL_MS = 4000;
const MAX_REFRESHES = 30; // about two minutes

/**
 * While a payment is being confirmed, re-reads the page every few seconds so the
 * guest sees the database's answer (CONFIRMED) as soon as Stripe's verified event
 * has been processed. It shows nothing and decides nothing itself.
 */
export function PaymentStatusRefresher() {
  const router = useRouter();
  useEffect(() => {
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      router.refresh();
      if (count >= MAX_REFRESHES) clearInterval(timer);
    }, INTERVAL_MS);
    return () => clearInterval(timer);
  }, [router]);
  return null;
}
