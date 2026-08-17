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
  variable: "--font-display-family",
  subsets: ["latin"],
  display: "swap",
  weight: ["500", "700"],
});

const mono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Megaforce CRM",
  description: "Prospect ownership, call capture, and the clock that governs both.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    /*
     * THE FONT VARIABLES GO ON <html>, NOT ON <body>.
     *
     * next/font hands back a class that DEFINES --font-sans-fallback and
     * friends. Put on <body>, those variables do not exist on <html> -- and
     * the base stylesheet sets `html { font-family: var(--font-sans-fallback),
     * ... }`. A var() with no fallback that resolves to nothing does not fall
     * through to the next family in the list: the WHOLE declaration becomes
     * invalid at computed-value time, and the element takes the browser
     * default, which is a serif.
     *
     * So the page rendered in Times wherever an element did not carry an
     * explicit font utility of its own, which is most body text. That is the
     * "old font still visible in some sections" -- it was never a leftover
     * face, it was the absence of any face at all.
     */
    <html
      lang="en"
      className={`${sans.variable} ${display.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      {/* No Typekit link. Adobe Garamond was dropped when the house style moved
          to JetBrains Mono and Inter, and the loader was still fetching a
          stylesheet from an external host on every page load for a face nothing
          referenced. */}
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
