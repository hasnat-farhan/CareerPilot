import type { ReactNode } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  LayoutDashboard,
  FileText,
  Search,
  Gauge,
  MessageSquare,
  Trello,
  CalendarDays,
  Settings,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = {
  href: Route;
  label: string;
  icon: typeof LayoutDashboard;
};

const navItems: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/cv", label: "My CV", icon: FileText },
  { href: "/hunter", label: "Job Hunter", icon: Search },
  { href: "/fit-score", label: "Fit Score", icon: Gauge },
  { href: "/chat", label: "Assistant", icon: MessageSquare },
  { href: "/tracker", label: "Tracker", icon: Trello },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <Topbar />
        <main className="flex-1 p-6 md:p-8">{children}</main>
      </div>
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-screen w-64 flex-shrink-0 border-r border-secondary-100 bg-white md:block">
      <div className="flex h-16 items-center gap-2 border-b border-secondary-100 px-6">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-white">
          <Sparkles className="h-4 w-4" />
        </span>
        <span className="font-heading text-base font-bold">CareerPilot</span>
      </div>
      <nav className="flex flex-col gap-0.5 p-3">
        {navItems.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted",
              "transition hover:bg-primary-50 hover:text-primary",
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}

function Topbar() {
  return (
    <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-secondary-100 bg-white/80 px-6 backdrop-blur md:px-8">
      <div>
        <p className="text-xs font-medium uppercase tracking-wider text-muted">
          Workspace
        </p>
        <p className="font-heading text-sm font-semibold text-secondary">
          Welcome back
        </p>
      </div>
      <Link
        href={"/sign-up" as Route}
        className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-[#111111] shadow-card transition hover:bg-accent-600"
      >
        Upgrade
      </Link>
    </header>
  );
}
