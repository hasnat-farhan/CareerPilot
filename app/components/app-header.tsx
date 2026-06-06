"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  FileText,
  Search,
  Gauge,
  MessageSquare,
  Trello,
  CalendarDays,
  Sparkles,
  ArrowRight,
  Menu,
  X,
} from "lucide-react";
import { useUser, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import { cn } from "@/lib/utils";

type AppNavItem = {
  href: "/dashboard" | "/cv" | "/hunter" | "/fit-score" | "/chat" | "/tracker" | "/calendar";
  label: string;
  icon: typeof LayoutDashboard;
};

const APP_NAV: readonly AppNavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/cv", label: "My CV", icon: FileText },
  { href: "/hunter", label: "Job Hunter", icon: Search },
  { href: "/fit-score", label: "Fit Score", icon: Gauge },
  { href: "/chat", label: "Assistant", icon: MessageSquare },
  { href: "/tracker", label: "Tracker", icon: Trello },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
];

const SECONDARY_ANCHORS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#pricing", label: "Pricing" },
];

export function AppHeader() {
  const { isSignedIn, isLoaded } = useUser();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Auto-close the mobile panel on route change so the menu doesn't
  // stay open after the user taps a link.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <header className="sticky top-0 z-20 border-b border-secondary-100 bg-white/85 backdrop-blur">
      <div className="container-wide flex h-16 items-center justify-between gap-2 md:gap-6">
        {/* Mobile-only menu toggle — far left, hidden on desktop */}
        {isLoaded && isSignedIn && (
          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            className="-ml-3 inline-flex h-10 w-10 items-center justify-center rounded-md text-secondary-600 transition hover:bg-secondary-50 hover:text-secondary md:hidden"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        )}

        <Link
          href={isSignedIn ? "/dashboard" : "/"}
          className="flex items-center gap-2 font-heading text-base font-bold text-secondary"
        >
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-white shadow-card">
            <Sparkles className="h-4 w-4" />
          </span>
          CareerPilot
        </Link>

        {/* In-app nav (signed in) or marketing anchors (signed out) — desktop only */}
        {isSignedIn ? (
          <nav className="hidden flex-1 items-center gap-0.5 overflow-x-auto md:flex">
            {APP_NAV.map(({ href, label, icon: Icon }) => {
              const active =
                pathname === href || pathname?.startsWith(`${href}/`);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition",
                    active
                      ? "bg-primary-50 text-primary"
                      : "text-secondary-600 hover:bg-secondary-50 hover:text-secondary",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Link>
              );
            })}
          </nav>
        ) : (
          <nav className="hidden items-center gap-6 text-sm font-medium text-secondary-600 md:flex">
            {SECONDARY_ANCHORS.map(({ href, label }) => (
              <a
                key={href}
                href={href}
                className="transition hover:text-primary"
              >
                {label}
              </a>
            ))}
          </nav>
        )}

        <div className="flex items-center gap-2">
          {!isLoaded ? (
            <span aria-hidden className="inline-block h-9 w-24" />
          ) : isSignedIn ? (
            <UserButton
              appearance={{ elements: { avatarBox: "h-8 w-8" } }}
            />
          ) : (
            <>
              <SignInButton mode="modal">
                <button
                  type="button"
                  className="hidden text-sm font-medium text-secondary-600 hover:text-primary sm:inline-block"
                >
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="modal">
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card transition hover:bg-primary-600"
                >
                  Get Started
                  <ArrowRight className="h-4 w-4" />
                </button>
              </SignUpButton>
            </>
          )}
        </div>
      </div>

      {/* Mobile in-app nav panel */}
      {isLoaded && isSignedIn && mobileOpen && (
        <nav
          aria-label="Primary"
          className="border-t border-secondary-100 bg-white md:hidden"
        >
          <ul className="container-wide flex flex-col gap-0.5 py-2">
            {APP_NAV.map(({ href, label, icon: Icon }) => {
              const active =
                pathname === href || pathname?.startsWith(`${href}/`);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition",
                      active
                        ? "bg-primary-50 text-primary"
                        : "text-secondary-600 hover:bg-secondary-50 hover:text-secondary",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </header>
  );
}
