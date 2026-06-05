import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { AuthCTA } from "@/app/components/auth-cta";
import { Syne, DM_Sans } from "next/font/google";
import "./globals.css";

const syne = Syne({
  subsets: ["latin"],
  variable: "--font-heading",
  weight: ["400", "500", "600", "700", "800"],
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "700"],
});

export const metadata: Metadata = {
  title: {
    default: "CareerPilot \u2014 Your next job starts here",
    template: "%s | CareerPilot",
  },
  description:
    "Put your job search on autopilot. CareerPilot hunts, scores, and applies for you.",
  metadataBase: new URL("https://careerpilot.app"),
  openGraph: {
    type: "website",
    title: "CareerPilot \u2014 Your next job starts here",
    description:
      "Meet the AI co-pilot that hunts, scores, and applies for you.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${syne.variable} ${dmSans.variable}`}>
        <body className="min-h-screen bg-surface font-body text-secondary antialiased">
          <header className="flex items-center justify-end gap-2 border-b border-secondary-100 bg-white px-6 py-3">
            <AuthCTA variant="header" />
          </header>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
