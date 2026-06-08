// Shared TS types for Pillar 4 — Productivity & Progress Tracker.
// These mirror the columns in supabase/migrations/20260607_productivity.sql.

export type ApplicationStatus = "applied" | "interviewing" | "offer" | "rejected";

export const APPLICATION_STATUSES: readonly ApplicationStatus[] = [
  "applied",
  "interviewing",
  "offer",
  "rejected",
] as const;

export interface ApplicationHistoryEntry {
  status: ApplicationStatus;
  at: string; // ISO timestamp
}

export interface Application {
  id: string;
  user_id: string;
  source_id: string | null;
  company: string;
  role: string;
  url: string | null;
  location: string | null;
  salary: string | null;
  deadline: string | null; // ISO date
  status: ApplicationStatus;
  notes: string | null;
  applied_at: string; // ISO date
  status_updated_at: string; // ISO timestamptz
  history: ApplicationHistoryEntry[];
  created_at: string;
}

export interface Todo {
  id: string;
  user_id: string;
  goal_id: string | null;
  application_id: string | null;
  title: string;
  due_date: string; // ISO date
  done: boolean;
  done_at: string | null;
  created_at: string;
}

export interface WeeklyStats {
  user_id: string;
  week_start: string; // ISO timestamptz
  apps_sent: number;
  todos_done: number;
  goals_total: number;
  goals_done: number;
  roadmap_pct: number;
}
