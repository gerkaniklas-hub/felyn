/**
 * Renders an EmailDocument (src/lib/email/templates/document.ts) as branded
 * HTML. The templates describe content as blocks; this maps each block onto
 * the shared components, so every transactional email has the same design.
 */
import { render } from "@react-email/components";
import type { EmailDocument } from "../lib/email/templates/document";
import { DetailsList, EmailButton, EmailHeading, EmailLayout, EmailText } from "./components";

type BookingEmailProps = { doc: EmailDocument; signature: string; footer: string };

export function BookingEmail({ doc, signature, footer }: BookingEmailProps) {
  return (
    <EmailLayout preview={doc.preheader} footer={footer}>
      {doc.blocks.map((block, index) => {
        switch (block.type) {
          case "heading":
            return <EmailHeading key={index}>{block.text}</EmailHeading>;
          case "text":
            return <EmailText key={index}>{block.text}</EmailText>;
          case "details":
            return <DetailsList key={index} rows={block.rows} />;
          case "cta":
            return (
              <EmailButton key={index} href={block.url}>
                {block.label}
              </EmailButton>
            );
        }
      })}
      <EmailText muted>{signature}</EmailText>
    </EmailLayout>
  );
}

export function renderBookingEmailHtml(doc: EmailDocument, signature: string, footer: string): Promise<string> {
  return render(<BookingEmail doc={doc} signature={signature} footer={footer} />);
}
