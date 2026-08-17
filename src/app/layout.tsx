import type { Metadata } from "next";
import { EB_Garamond, Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

/**
 * Typography.
 *
 * ---------------------------------------------------------------------------
 * HELVETICA NEUE is a licensed font and cannot be served from a CDN. It is on
 * every Mac, so it is named first and Macs get the real thing.
 *
 * On Windows it is absent, and naming Arial or Segoe UI after it produces the
 * platform's own default -- which is exactly what the browser was already
 * using. The change is real, correct, and completely invisible to anyone not
 * on a Mac, which is worse than not making it: it looks like nothing shipped.
 *
 * So Inter is served as the substitute. It is a neo-grotesque cut from the same
 * lineage, close enough in skeleton and x-height that a table does not reflow
 * between the two, and it is a genuine download -- so every machine shows the
 * intended typeface rather than falling back to whatever it happened to have.
 *
 * ADOBE GARAMOND PRO is also licensed -- through Adobe Fonts, which serves it
 * from use.typekit.net against a paid plan. It is named first in the serif
 * stack, so it is used wherever it is available: any machine with Creative
 * Cloud installed, and every visitor once a kit ID is set below.
 *
 * EB Garamond is loaded as the web fallback. It is Octavio Pardo's revival of
 * the same Claude Garamond sources Adobe Garamond draws on, it is open
 * licensed, and side by side the difference is a matter of a few terminals. It
 * means the page reads as Garamond on a Windows machine that has never heard of
 * Adobe, rather than falling back to Times New Roman.
 *
 * To switch on the real thing: create a Web Project in Adobe Fonts containing
 * Adobe Garamond Pro, and set NEXT_PUBLIC_ADOBE_FONTS_KIT to the kit ID. No
 * other change is needed -- the stylesheet below appears and the font ahead of
 * EB Garamond in the stack starts resolving.
 * ---------------------------------------------------------------------------
 */
const garamond = EB_Garamond({
  variable: "--font-serif-fallback",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "600"],
});

const sans = Inter({
  variable: "--font-sans-fallback",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
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
      <body className={`${sans.variable} ${garamond.variable} ${mono.variable} antialiased`}>
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
