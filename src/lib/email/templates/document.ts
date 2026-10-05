/**
 * The email document model every transactional email is built from.
 *
 * Templates (booking-emails.ts) only describe CONTENT as a list of blocks.
 * The HTML comes from the branded React Email components in src/emails/
 * (EmailLayout, EmailHeading, EmailText, DetailsList, EmailButton); the
 * plain-text part is rendered here from the same blocks.
 */
import { renderBookingEmailHtml } from "../../../emails/booking-email";

export type EmailBlock =
  | { type: "heading"; text: string }
  | { type: "text"; text: string }
  | { type: "details"; rows: { label: string; value: string }[] }
  | { type: "cta"; label: string; url: string };

export type EmailDocument = {
  subject: string;
  /** Inbox preview line. */
  preheader: string;
  blocks: EmailBlock[];
};

export type RenderedEmail = { subject: string; html: string; text: string };

const SIGNATURE = "The Felyn team";
const FOOTER = "You are receiving this email because of activity on your Felyn account.";

/** One line, no control characters (a subject is a mail header), max 150 characters. */
export function sanitizeSubject(subject: string): string {
  const oneLine = subject.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  return oneLine.length > 150 ? `${oneLine.slice(0, 149)}…` : oneLine;
}

export function renderEmailText(doc: EmailDocument): string {
  const parts = doc.blocks.map((block) => {
    switch (block.type) {
      case "heading":
      case "text":
        return block.text;
      case "details":
        return block.rows.map((row) => `${row.label}: ${row.value}`).join("\n");
      case "cta":
        return `${block.label}: ${block.url}`;
    }
  });
  return [...parts, SIGNATURE, FOOTER].join("\n\n");
}

/** React escapes every text value and attribute, so user-entered text (titles, names) can never inject markup. */
export async function renderEmail(doc: EmailDocument): Promise<RenderedEmail> {
  return {
    subject: sanitizeSubject(doc.subject),
    html: await renderBookingEmailHtml(doc, SIGNATURE, FOOTER),
    text: renderEmailText(doc),
  };
}
