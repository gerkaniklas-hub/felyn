import type { Metadata } from "next";
import { Fraunces, Plus_Jakarta_Sans } from "next/font/google";
import { MessagingProvider } from "@/components/messaging/MessagingProvider";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
});

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Felyn",
  description: "Make more of the time together.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${jakarta.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-ivory-100 text-navy-900">
        {/* Mounted once, app-wide (task 2/4): the floating chat window it
            renders survives client-side navigation across every guest and
            provider page, so opening a conversation never gets lost by
            moving around the app. No-ops entirely for a signed-out visitor
            (see MessagingProvider/FloatingChatWindow). */}
        <MessagingProvider>{children}</MessagingProvider>
      </body>
    </html>
  );
}
