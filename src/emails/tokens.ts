/**
 * Felyn brand values for emails, copied from the app's design tokens
 * (src/app/globals.css @theme) as plain hex values: email clients support
 * neither Tailwind nor CSS variables, so every style is inline.
 *
 * Fonts: Fraunces / Plus Jakarta Sans are named first for the few clients
 * that have them; everyone else gets the closest web-safe fallback.
 */
export const emailColors = {
  page: "#faf5ec", // ivory-100, the app background
  card: "#fdfbf6", // ivory-50
  panel: "#f4eee1", // ivory-200, like the app's Card
  border: "#ece3d2", // ivory-300
  heading: "#0d1626", // navy-950
  text: "#16233d", // navy-900
  muted: "#5c6b87", // navy-500
  buttonBackground: "#16233d", // navy-900, the app's primary Button
  buttonText: "#fdfbf6", // ivory-50
  link: "#1e7fbe", // sky-600
  gold: "#d9a441", // gold-500, the wordmark's dot only
} as const;

export const emailFonts = {
  display: "Fraunces, Georgia, 'Times New Roman', serif",
  body: "'Plus Jakarta Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
} as const;
