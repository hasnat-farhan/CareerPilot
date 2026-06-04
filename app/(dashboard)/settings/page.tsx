export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight md:text-3xl">
          Settings
        </h1>
        <p className="mt-1 text-sm text-secondary-500">
          Manage your profile, integrations, and data.
        </p>
      </div>

      <div className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card">
        <h2 className="font-heading text-base font-semibold">Profile</h2>
        <p className="mt-1 text-sm text-secondary-500">
          Synced from Clerk. Edit it from your account portal.
        </p>
      </div>

      <div className="rounded-2xl border border-secondary-100 bg-white p-5 shadow-card">
        <h2 className="font-heading text-base font-semibold">Integrations</h2>
        <p className="mt-1 text-sm text-secondary-500">
          Connect Supabase, Gemini, Tavily, and Adzuna via{" "}
          <code className="rounded bg-secondary-50 px-1.5 py-0.5 text-xs">
            .env.local
          </code>
          .
        </p>
      </div>
    </div>
  );
}
