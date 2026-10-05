/**
 * Shared building blocks for every Felyn transactional email (React Email).
 * Inline styles only — no Tailwind, no CSS variables — so the markup holds
 * up in Gmail, Outlook and Apple Mail. Brand values: ./tokens.ts.
 */
import { Body, Button, Container, Head, Heading, Html, Preview, Section, Text } from "@react-email/components";
import type { ReactNode } from "react";
import { emailColors, emailFonts } from "./tokens";

/**
 * The Felyn wordmark as text, matching src/components/ui/logo.tsx: navy
 * "Felyn" with the golden period. Text rather than an image, so it shows
 * even when a client blocks images.
 */
function Wordmark() {
  return (
    <Text
      style={{
        margin: 0,
        fontFamily: emailFonts.display,
        fontSize: "28px",
        lineHeight: "32px",
        fontWeight: 500,
        letterSpacing: "-0.5px",
        color: emailColors.heading,
      }}
    >
      Felyn<span style={{ color: emailColors.gold }}>.</span>
    </Text>
  );
}

export function EmailLayout({ preview, footer, children }: { preview: string; footer: string; children: ReactNode }) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={{ margin: 0, padding: "32px 12px", backgroundColor: emailColors.page, fontFamily: emailFonts.body }}>
        <Container style={{ maxWidth: "560px", margin: "0 auto" }}>
          <Section style={{ padding: "0 8px 20px" }}>
            <Wordmark />
          </Section>
          <Section
            style={{
              backgroundColor: emailColors.card,
              border: `1px solid ${emailColors.border}`,
              borderRadius: "16px",
              padding: "32px 28px",
            }}
          >
            {children}
          </Section>
          <Text style={{ margin: "20px 8px 0", fontSize: "12px", lineHeight: "18px", color: emailColors.muted }}>{footer}</Text>
        </Container>
      </Body>
    </Html>
  );
}

export function EmailHeading({ children }: { children: ReactNode }) {
  return (
    <Heading
      as="h1"
      style={{
        margin: "0 0 16px",
        fontFamily: emailFonts.display,
        fontSize: "26px",
        lineHeight: "32px",
        fontWeight: 500,
        color: emailColors.heading,
      }}
    >
      {children}
    </Heading>
  );
}

export function EmailText({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <Text style={{ margin: "0 0 16px", fontSize: "16px", lineHeight: "24px", color: muted ? emailColors.muted : emailColors.text }}>
      {children}
    </Text>
  );
}

export function EmailButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section style={{ margin: "8px 0 24px" }}>
      <Button
        href={href}
        style={{
          display: "inline-block",
          backgroundColor: emailColors.buttonBackground,
          color: emailColors.buttonText,
          borderRadius: "9999px",
          padding: "13px 26px",
          fontSize: "16px",
          lineHeight: "20px",
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        {children}
      </Button>
    </Section>
  );
}

/** Label / value rows on the app's ivory card colour. */
export function DetailsList({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <Section style={{ margin: "0 0 16px", backgroundColor: emailColors.panel, borderRadius: "12px", padding: "14px 18px" }}>
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ borderCollapse: "collapse" }}>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td
                style={{
                  padding: "5px 16px 5px 0",
                  width: "36%",
                  verticalAlign: "top",
                  fontSize: "14px",
                  lineHeight: "20px",
                  color: emailColors.muted,
                }}
              >
                {row.label}
              </td>
              <td style={{ padding: "5px 0", verticalAlign: "top", fontSize: "15px", lineHeight: "20px", color: emailColors.text }}>
                {row.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
