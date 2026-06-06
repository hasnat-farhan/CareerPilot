import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { AppHeader } from "@/app/components/app-header";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "CareerPilot — Your next job starts here",
    template: "%s | CareerPilot",
  },
  description:
    "Put your job search on autopilot. CareerPilot hunts, scores, and applies for you.",
  metadataBase: new URL("https://careerpilot.app"),
  openGraph: {
    type: "website",
    title: "CareerPilot — Your next job starts here",
    description:
      "Meet the AI co-pilot that hunts, scores, and applies for you.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className="min-h-screen bg-background font-body text-secondary antialiased">
          <AppHeader />
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
