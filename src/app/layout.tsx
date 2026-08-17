import type { Metadata } from "next";
import { EB_Garamond, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

/**
 * Typography.
 *
 * ---------------------------------------------------------------------------
 * HELVETICA NEUE is a licensed font and is not available to serve from a CDN.
 * It is present on macOS and iOS, so it is named first and the stack falls
 * through to Helvetica, then Arial, on everything else. Those three share
 * metrics closely enough that a table does not reflow between platforms, which
 * is the part that actually matters for a screen full of numbers.
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
    <html lang="en">
      <head>
        {adobeKit ? (
          <link rel="stylesheet" href={`https://use.typekit.net/${adobeKit}.css`} />
        ) : null}
      </head>
      <body className={`${garamond.variable} ${mono.variable} antialiased`}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
