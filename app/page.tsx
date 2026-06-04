import Link from "next/link";
import type { Route } from "next";
import {
  Sparkles,
  Target,
  Compass,
  Bot,
  CheckCircle2,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

const heroHeadlines = [
  "Put Your Job Search on Autopilot with CareerPilot.",
  "Meet the AI Co-Pilot That Hunts, Scores, and Applies for You.",
  "Stop Searching. Let AI Build Your Ultimate Career Roadmap.",
];

const pillars = [
  {
    icon: Bot,
    title: "AI Job Hunter",
    body: "Searches live boards and surfaces roles that fit your CV — automatically.",
  },
  {
    icon: Target,
    title: "Fit Score",
    body: "Every job gets a transparent match percentage with a clear breakdown.",
  },
  {
    icon: Sparkles,
    title: "RAG Assistant",
    body: "Answers grounded in your real CV, with sources you can verify.",
  },
  {
    icon: Compass,
    title: "Career Roadmap",
    body: "Skills, deadlines, and progress — all in one plan.",
  },
];

export default function HomePage() {
  return (
    <main className="relative overflow-hidden">
      <BackgroundGlow />
      <Header />
      <Hero />
      <Pillars />
      <ClosingCTA />
      <Footer />
    </main>
  );
}

function BackgroundGlow() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(0,56,147,0.08),transparent_70%)]"
    />
  );
}

function Header() {
  return (
    <header className="container-wide flex items-center justify-between py-6">
      <Link
        href="/"
        className="flex items-center gap-2 font-heading text-lg font-bold text-secondary"
      >
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-white">
          <Sparkles className="h-4 w-4" />
        </span>
        CareerPilot
      </Link>
      <nav className="hidden items-center gap-8 md:flex">
        <Link href="#pillars" className="text-sm font-medium text-secondary-600 hover:text-primary">
          Features
        </Link>
        <Link href="/pricing" className="text-sm font-medium text-secondary-600 hover:text-primary">
          Pricing
        </Link>
        <Link href="/about" className="text-sm font-medium text-secondary-600 hover:text-primary">
          About
        </Link>
      </nav>
      <div className="flex items-center gap-3">
        <Link
          href={"/sign-in" as Route}
          className="hidden text-sm font-medium text-secondary-600 hover:text-primary sm:inline-block"
        >
          Sign in
        </Link>
        <Link
          href={"/sign-up" as Route}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card transition hover:bg-primary-600"
        >
          Get Started
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="container-wide pt-16 pb-24 md:pt-24 md:pb-32">
      <div className="mx-auto max-w-3xl text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary-100 bg-primary-50 px-3 py-1 text-xs font-semibold text-primary">
          <Sparkles className="h-3 w-3" />
          For Dhaka founders &amp; job seekers
        </span>
        <h1 className="font-heading mt-6 text-balance text-4xl font-extrabold tracking-tight md:text-6xl">
          {heroHeadlines[0]}
        </h1>
        <p className="text-pretty mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-secondary-500 md:text-xl">
          CareerPilot is your AI co-pilot for the job search. It reads your CV,
          hunts live roles, scores every match, and tracks every application —
          so you can focus on closing offers.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
<<<<<<< Updated upstream
          <Link
            href={"/sign-up" as Route}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-base font-semibold text-white shadow-card transition hover:bg-primary-600 hover:shadow-cardHover sm:w-auto"
          >
            Get Started
            <ArrowRight className="h-4 w-4" />
          </Link>
=======
>>>>>>> Stashed changes
          <Link
            href="#pillars"
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-secondary-200 bg-white px-6 py-3 text-base font-semibold text-secondary transition hover:border-primary hover:text-primary sm:w-auto"
          >
            See how it works
          </Link>
        </div>
        <ul className="mx-auto mt-8 grid max-w-xl grid-cols-1 gap-2 text-left text-sm text-secondary-500 sm:grid-cols-3">
          {["No credit card", "RAG-grounded answers", "Live job feeds"].map(
            (item) => (
              <li key={item} className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                {item}
              </li>
            ),
          )}
        </ul>
      </div>
    </section>
  );
}

function Pillars() {
  return (
    <section id="pillars" className="container-wide py-20 md:py-28">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="font-heading text-3xl font-bold tracking-tight md:text-4xl">
          Four pillars. One autopilot.
        </h2>
        <p className="text-pretty mt-4 text-secondary-500">
          Built for the Dhaka founders ecosystem — every feature moves you
          from searching to hired.
        </p>
      </div>
      <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {pillars.map(({ icon: Icon, title, body }) => (
          <article
            key={title}
            className={cn(
              "group rounded-2xl border border-secondary-100 bg-white p-6 shadow-card transition",
              "hover:-translate-y-0.5 hover:border-primary-100 hover:shadow-cardHover",
            )}
          >
            <span className="inline-grid h-10 w-10 place-items-center rounded-lg bg-primary-50 text-primary transition group-hover:bg-primary group-hover:text-white">
              <Icon className="h-5 w-5" />
            </span>
            <h3 className="font-heading mt-4 text-lg font-semibold">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-secondary-500">
              {body}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ClosingCTA() {
  return (
    <section className="container-wide pb-24">
      <div className="overflow-hidden rounded-2xl bg-primary px-8 py-12 text-center text-white md:px-16 md:py-16">
        <h2 className="font-heading text-balance text-3xl font-bold tracking-tight md:text-4xl">
          {heroHeadlines[2]}
        </h2>
        <p className="text-pretty mx-auto mt-4 max-w-xl text-white/85">
          Upload your CV. Get your roadmap. Let CareerPilot handle the hunt.
        </p>
        <Link
          href={"/sign-up" as Route}
          className="mt-8 inline-flex items-center gap-2 rounded-lg bg-white px-6 py-3 text-base font-semibold text-primary shadow-card transition hover:bg-secondary-50"
        >
          Get Started
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-secondary-100 bg-white">
      <div className="container-wide flex flex-col items-center justify-between gap-4 py-8 text-sm text-secondary-500 md:flex-row">
        <p>© {new Date().getFullYear()} CareerPilot. All rights reserved.</p>
        <p>
          Built for the{" "}
          <span className="font-semibold text-primary">Dhaka Founders</span> ecosystem.
        </p>
      </div>
    </footer>
  );
}
