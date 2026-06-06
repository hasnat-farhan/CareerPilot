import type { ReactNode } from "react";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  // The global <AppHeader /> (rendered by app/layout.tsx) shows the in-app
  // nav when the user is signed in, so this layout is intentionally a
  // pass-through — no sidebar, no second topbar.
  return <>{children}</>;
}
