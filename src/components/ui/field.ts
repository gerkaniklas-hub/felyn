/**
 * Form field looks, shared by the Input/Textarea primitives and by the
 * native <select>/<input>/<textarea> elements that forms render directly.
 * Single-line fields are pills at the same 44px height as a md Button;
 * multi-line fields take the card radius. Border color is left out of
 * `fieldShape` so a form can swap in its own error color.
 */
export const fieldShape =
  "h-11 rounded-full border bg-ivory-50 px-4 text-base text-navy-900 outline-none transition-colors placeholder:text-navy-300 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-50";

export const fieldClass = `${fieldShape} border-ivory-400`;

export const textareaClass =
  "min-h-28 rounded-card border border-ivory-400 bg-ivory-50 px-4 py-3 text-base text-navy-900 outline-none transition-colors placeholder:text-navy-300 focus:border-sky-500 focus:ring-2 focus:ring-sky-100";

export const fieldLabelClass = "text-sm font-medium text-navy-700";
