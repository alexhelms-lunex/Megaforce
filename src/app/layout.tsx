import type { Metadata } from "next";
import { Figtree, JetBrains_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

/**
 * Figtree, to match megacorp.com.
 *
 * The site runs a geometric humanist with round terminals and a double-storey
 * 'a'. Figtree is the closest thing with an open licence, and it holds up in a
 * dense table at 13px, which the display faces that look right in a hero
 * headline generally do not.
 *
 * The variable is named --font-sans because that is what globals.css reads.
 * It previously declared --font-geist-sans, which nothing referenced, so the
 * whole application had silently been rendering in the browser default.
 */
const sans = Figtree({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
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
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable} antialiased`}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
