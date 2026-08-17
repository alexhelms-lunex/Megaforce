import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

/**
 * Typography.
 *
 * JetBrains Mono carries headlines, Inter carries everything else. Both come
 * from Google Fonts and are downloaded rather than merely named, so every
 * machine renders the intended face -- the mistake that made the last two
 * typeface changes invisible on Windows.
 *
 * A monospace for headings is an unusual choice and a deliberate one here: it
 * is the house style, and it reads as deliberate on a screen otherwise full of
 * figures. It is confined to headings for the same reason -- monospaced prose
 * is slow to read, and this is an application people are in all day.
 */
const sans = Inter({
  variable: "--font-sans-fallback",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const display = JetBrains_Mono({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
  weight: ["500", "700"],
});

const mono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

const adobeKit = process.env.NEXT_PUBLIC_ADOBE_FONTS_KIT?.trim();

export const metadata: Metadata = {
  title: "Megaforce CRM",
  description: "Prospect ownership, call capture, and the clock that governs both.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {adobeKit ? (
          <link rel="stylesheet" href={`https://use.typekit.net/${adobeKit}.css`} />
        ) : null}
      </head>
      <body className={`${sans.variable} ${display.variable} ${mono.variable} antialiased`}>
        {/* suppressHydrationWarning on <html> above is required: next-themes
            writes the class before React hydrates, so the server and client
            markup differ by design on exactly that attribute. */}
        <ThemeProvider>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
