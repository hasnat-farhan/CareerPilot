"use client";

import {
  SignInButton,
  SignUpButton,
  UserButton,
  useUser,
} from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";

type Variant = "header" | "hero" | "closing";

const basePrimary =
  "inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card transition hover:bg-primary-600";
const heroPrimary =
  "inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-base font-semibold text-white shadow-card transition hover:bg-primary-600 hover:shadow-cardHover sm:w-auto";
const closingPrimary =
  "mt-8 inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3 text-base font-semibold text-primary shadow-card transition hover:bg-secondary-50";
const headerSecondary =
  "hidden text-sm font-medium text-secondary-600 hover:text-primary sm:inline-block";

/**
 * Auth-aware CTA. Renders Clerk's sign-in/sign-up modals when the user is
 * signed out, and a UserButton (header) or "Go to dashboard" link (hero /
 * closing) when signed in. Gating on `useUser().isSignedIn` means the
 * modal-trigger JSX is never instantiated while a session exists, so
 * Clerk's `cannot_render_single_session_enabled` dev warning cannot fire.
 */
export function AuthCTA({
  variant,
  label = "Get Started",
}: {
  variant: Variant;
  label?: string;
}) {
  const { isSignedIn, isLoaded } = useUser();

  // Render a neutral placeholder of the same size until Clerk has hydrated
  // the user state, so the layout doesn't shift on first paint.
  if (!isLoaded) {
    return <span aria-hidden className="inline-block h-9 w-24" />;
  }

  if (isSignedIn) {
    if (variant === "header") {
      return (
        <UserButton
          appearance={{ elements: { avatarBox: "h-8 w-8" } }}
        />
      );
    }
    return (
      <a
        href="/dashboard"
        className={variant === "closing" ? closingPrimary : heroPrimary}
      >
        Go to dashboard
        <ArrowRight className="h-4 w-4" />
      </a>
    );
  }

  if (variant === "header") {
    return (
      <>
        <SignInButton mode="modal">
          <button type="button" className={headerSecondary}>
            Sign in
          </button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button type="button" className={basePrimary}>
            {label}
            <ArrowRight className="h-4 w-4" />
          </button>
        </SignUpButton>
      </>
    );
  }

  return (
    <SignUpButton mode="modal">
      <button type="button" className={heroPrimary}>
        {label}
        <ArrowRight className="h-4 w-4" />
      </button>
    </SignUpButton>
  );
}
