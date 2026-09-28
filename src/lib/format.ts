/** Small display-formatting helpers shared by /home and /recommendations. */

// timeZone: "UTC" keeps this consistent regardless of server/browser
// timezone — without it, a date-only string like "2026-10-02" (parsed as
// UTC midnight) can render as the previous day on any negative-UTC-offset
// timezone once toLocaleDateString reinterprets it locally.
export function formatDateRange(checkIn: string, checkOut: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", timeZone: "UTC" };
  const inDate = new Date(checkIn);
  const outDate = new Date(checkOut);
  return `${inDate.toLocaleDateString("en-GB", opts)} – ${outDate.toLocaleDateString("en-GB", opts)} ${outDate.toLocaleDateString("en-GB", { year: "numeric", timeZone: "UTC" })}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = { EUR: "€", USD: "$", GBP: "£" };

export function formatCurrency(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency];
  const rounded = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return symbol ? `${symbol}${rounded}` : `${rounded} ${currency}`;
}

export function formatPrice(pricePerPerson: number, currency: string): string {
  return `${formatCurrency(pricePerPerson, currency)} per person`;
}
