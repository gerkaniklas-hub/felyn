import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/ui/logo";

type Swatch = { name: string; className: string; hex: string };

const ivory: Swatch[] = [
  { name: "ivory-50", className: "bg-ivory-50", hex: "#fdfbf6" },
  { name: "ivory-100", className: "bg-ivory-100", hex: "#faf5ec" },
  { name: "ivory-200", className: "bg-ivory-200", hex: "#f4eee1" },
  { name: "ivory-300", className: "bg-ivory-300", hex: "#ece3d2" },
  { name: "ivory-400", className: "bg-ivory-400", hex: "#ddd0b8" },
  { name: "ivory-500", className: "bg-ivory-500", hex: "#c9b896" },
];

const navy: Swatch[] = [
  { name: "navy-50", className: "bg-navy-50", hex: "#eef1f5" },
  { name: "navy-100", className: "bg-navy-100", hex: "#e3e7ed" },
  { name: "navy-300", className: "bg-navy-300", hex: "#9aa5b8" },
  { name: "navy-500", className: "bg-navy-500", hex: "#5c6b87" },
  { name: "navy-700", className: "bg-navy-700", hex: "#33415c" },
  { name: "navy-900", className: "bg-navy-900", hex: "#16233d" },
  { name: "navy-950", className: "bg-navy-950", hex: "#0d1626" },
];

const sky: Swatch[] = [
  { name: "sky-50", className: "bg-sky-50", hex: "#f1f8fd" },
  { name: "sky-100", className: "bg-sky-100", hex: "#dceefa" },
  { name: "sky-200", className: "bg-sky-200", hex: "#bfe1f5" },
  { name: "sky-300", className: "bg-sky-300", hex: "#93cdec" },
  { name: "sky-400", className: "bg-sky-400", hex: "#63b3e0" },
  { name: "sky-500", className: "bg-sky-500", hex: "#3b9ad9" },
  { name: "sky-600", className: "bg-sky-600", hex: "#1e7fbe" },
  { name: "sky-700", className: "bg-sky-700", hex: "#17638f" },
];

const gold: Swatch[] = [
  { name: "gold-100", className: "bg-gold-100", hex: "#f8ecd3" },
  { name: "gold-300", className: "bg-gold-300", hex: "#e9c687" },
  { name: "gold-500", className: "bg-gold-500", hex: "#d9a441" },
  { name: "gold-700", className: "bg-gold-700", hex: "#96652f" },
];

function SwatchRow({ swatches }: { swatches: Swatch[] }) {
  return (
    <div className="flex flex-wrap gap-3">
      {swatches.map((s) => (
        <div key={s.name} className="w-24 text-center">
          <div className={`h-16 w-full rounded-lg border border-navy-100 ${s.className}`} />
          <p className="mt-1.5 text-xs font-medium text-navy-700">{s.name}</p>
          <p className="text-[11px] text-navy-300">{s.hex}</p>
        </div>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <Heading level={3}>{title}</Heading>
      {children}
    </section>
  );
}

export default function StyleGuidePage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-14 px-6 py-16">
      <header className="flex flex-col gap-2">
        <Logo size="lg" />
        <p className="text-navy-500">
          Felyn design system — internal reference, not a product screen.
        </p>
      </header>

      <Section title="Logo">
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center rounded-xl border border-ivory-300 bg-ivory-50 px-6 py-5">
            <Logo variant="default" />
          </div>
          <div className="flex items-center rounded-xl bg-navy-950 px-6 py-5">
            <Logo variant="reverse" />
          </div>
        </div>
        <p className="text-sm text-navy-500">
          The period is always the golden-hour dot. It marks the wordmark only —
          never use it alone as an app icon.
        </p>
      </Section>

      <Section title="Color">
        <div className="flex flex-col gap-6">
          <div>
            <p className="mb-2 text-sm font-medium text-navy-700">Ivory / cloud — dominant surface</p>
            <SwatchRow swatches={ivory} />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-navy-700">Navy — text &amp; UI</p>
            <SwatchRow swatches={navy} />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-navy-700">Sky — secondary accent</p>
            <SwatchRow swatches={sky} />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium text-navy-700">Gold — golden-hour accent, used sparingly</p>
            <SwatchRow swatches={gold} />
          </div>
        </div>
        <p className="max-w-xl text-sm text-navy-500">
          Target balance across a screen: roughly 55–60% ivory, 25–30% navy,
          10–15% sky, 3–5% gold. Sky is for interactive/informational elements
          (links, focus states, active tabs) — not large fills. Gold marks rare
          highlights (the logo dot, a small badge, a rating star) and should
          never dominate a layout.
        </p>
      </Section>

      <Section title="Typography">
        <div className="flex flex-col gap-3">
          <Heading level={1}>Make more of the time together.</Heading>
          <Heading level={2}>A relaxed evening around the table</Heading>
          <Heading level={3}>What to expect</Heading>
          <p className="max-w-lg font-sans text-base text-navy-900">
            Body copy uses Plus Jakarta Sans — warm, modern and highly legible
            at small sizes. Headings use Fraunces, a soft editorial serif that
            keeps things feeling premium and human rather than corporate.
          </p>
          <p className="text-sm text-navy-500">Secondary text — navy-500 on ivory.</p>
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">Request this experience</Button>
          <Button variant="secondary">Edit details</Button>
          <Button variant="ghost">Back to Explore</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="sm">
            Small
          </Button>
          <Button variant="primary" size="md">
            Medium
          </Button>
          <Button variant="primary" size="lg">
            Large
          </Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
        </div>
      </Section>

      <Section title="Input">
        <div className="max-w-sm">
          <Input label="Email or mobile number" name="email" placeholder="you@example.com" />
        </div>
      </Section>

      <Section title="Card">
        <Card className="max-w-sm">
          <p className="font-display text-lg text-navy-950">Sunset Seafood Dinner</p>
          <p className="mt-1 text-sm text-navy-500">La Orotava · €65 per person</p>
        </Card>
      </Section>

      <Section title="Badge">
        <div className="flex flex-wrap gap-2">
          <Badge tone="navy">Friends&apos; getaway</Badge>
          <Badge tone="sky">Fits your budget</Badge>
          <Badge tone="gold">★ 4.9</Badge>
        </div>
      </Section>
    </div>
  );
}
