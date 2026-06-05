// CareerPilot — Role benchmark profile types.
//
// A benchmark is a static description of what a given role "looks like" — the
// skills it expects, the experience bar, and the language it tends to use.
// The fit-score engine compares a user's CV (and a JD, when one is provided)
// against one of these to produce a coverage report and a verdict.
//
// We keep benchmarks as TypeScript constants (not a DB table) for v1. Reasons:
//   1. Profiles are stable, hand-curated, and rarely change.
//   2. Inlining them removes a Supabase roundtrip on every chat turn.
//   3. The next iteration can lift these into a `role_benchmarks` table
//      (Supabase + admin UI) without changing the fit-score API.

/** A single skill the user may or may not have. */
export interface Skill {
  /** Canonical id used everywhere in the app, e.g. "react", "sql", "kafka". */
  id: string;
  /** Human-friendly display name, e.g. "React", "SQL", "Apache Kafka". */
  label: string;
  /**
   * Aliases the fit-score engine should treat as the same skill.
   * Example: { id: "k8s", aliases: ["kubernetes", "kube", "k8s"] }.
   * Case-insensitive; matched on token boundaries.
   */
  aliases?: string[];
  /**
   * Optional weight 0..1 used in coverage scoring. Defaults to 1.
   * Use this to mark critical skills (e.g. "python" for data eng = 1.0)
   * vs. nice-to-haves (e.g. "airflow" = 0.4).
   */
  weight?: number;
  /** Group label for UI rendering, e.g. "Languages", "Cloud", "Data". */
  category?: string;
}

export type EducationLevel = "high_school" | "associate" | "bachelor" | "master" | "phd";

export interface RoleBenchmark {
  /** Stable key used in URLs and chat intent routing. */
  key: string;
  /** Display name shown in the UI. */
  title: string;
  /** One-sentence description of the role. */
  summary: string;
  /** Domain grouping for the UI filter (e.g. "Engineering", "Data"). */
  domain: string;
  /** Skills we treat as required. Each contributes to the core score. */
  mustHave: Skill[];
  /** Skills that boost the score but aren't deal-breakers. */
  niceToHave: Skill[];
  /** Minimum years of relevant experience expected. */
  minExperienceYears: number;
  /** Minimum education level expected. PhD/Master are over-qualifiers. */
  minEducation: EducationLevel;
  /**
   * Recurring phrases the JD parser can look for as quick signals
   * (e.g. "distributed systems", "ETL"). Matched case-insensitive, substring.
   */
  keywords: string[];
  /**
   * Free-text notes the assistant can use to colour its reasoning. Example:
   * "Internship programs are GPA-sensitive and value demonstrated curiosity
   * over years of experience."
   */
  notes?: string;
}

/** The full registry, exported as a const map for O(1) lookup. */
export const BENCHMARKS: Record<string, RoleBenchmark> = {
  "google-swe-intern": {
    key: "google-swe-intern",
    title: "Google SWE Intern",
    summary: "Software Engineering Intern at Google (undergrad summer role).",
    domain: "Engineering",
    mustHave: [
      { id: "data-structures", label: "Data Structures & Algorithms", aliases: ["dsa", "algorithms", "data structures"], weight: 1, category: "CS Core" },
      { id: "python", label: "Python", aliases: ["py"], weight: 1, category: "Languages" },
      { id: "java", label: "Java", aliases: [], weight: 0.8, category: "Languages" },
      { id: "cpp", label: "C++", aliases: ["c plus plus", "c/c++"], weight: 0.8, category: "Languages" },
      { id: "go", label: "Go", aliases: ["golang"], weight: 0.6, category: "Languages" },
      { id: "sql", label: "SQL", aliases: [], weight: 0.7, category: "Data" },
      { id: "linux", label: "Linux / Unix", aliases: ["unix", "bash"], weight: 0.6, category: "Systems" },
      { id: "git", label: "Git", aliases: [], weight: 0.7, category: "Tooling" },
    ],
    niceToHave: [
      { id: "distributed-systems", label: "Distributed Systems", aliases: ["distributed"], weight: 0.5, category: "Systems" },
      { id: "cloud", label: "Cloud (GCP/AWS/Azure)", aliases: ["gcp", "aws", "azure"], weight: 0.5, category: "Cloud" },
      { id: "docker", label: "Docker", aliases: ["containers"], weight: 0.4, category: "Cloud" },
      { id: "react", label: "React", aliases: ["reactjs"], weight: 0.3, category: "Frontend" },
      { id: "system-design", label: "System Design", aliases: [], weight: 0.5, category: "CS Core" },
    ],
    minExperienceYears: 0,
    minEducation: "bachelor",
    keywords: [
      "google",
      "intern",
      "software engineer",
      "swe",
      "data structures",
      "algorithms",
      "coding interview",
    ],
    notes:
      "GPA-sensitive (3.5+ preferred). Demonstrated curiosity (side projects, " +
      "open source, hackathons) matters more than years of experience. " +
      "Coding interview is heavy on DSA, not frameworks.",
  },

  "data-engineer": {
    key: "data-engineer",
    title: "Data Engineer",
    summary: "Mid-level Data Engineer building production data pipelines and warehouses.",
    domain: "Data",
    mustHave: [
      { id: "python", label: "Python", aliases: ["py"], weight: 1, category: "Languages" },
      { id: "sql", label: "SQL (advanced)", aliases: [], weight: 1, category: "Data" },
      { id: "spark", label: "Apache Spark", aliases: ["pyspark"], weight: 1, category: "Data" },
      { id: "etl", label: "ETL / ELT pipelines", aliases: ["elt", "data pipeline", "pipelines"], weight: 1, category: "Data" },
      { id: "data-warehouse", label: "Data Warehousing (Snowflake/BigQuery/Redshift)", aliases: ["snowflake", "bigquery", "redshift", "warehouse"], weight: 0.9, category: "Data" },
      { id: "airflow", label: "Apache Airflow", aliases: [], weight: 0.7, category: "Data" },
      { id: "kafka", label: "Apache Kafka", aliases: [], weight: 0.7, category: "Data" },
      { id: "cloud", label: "Cloud (AWS/GCP/Azure)", aliases: ["aws", "gcp", "azure"], weight: 0.9, category: "Cloud" },
    ],
    niceToHave: [
      { id: "dbt", label: "dbt", aliases: ["data build tool"], weight: 0.5, category: "Data" },
      { id: "kubernetes", label: "Kubernetes", aliases: ["k8s", "kube"], weight: 0.5, category: "Cloud" },
      { id: "terraform", label: "Terraform", aliases: ["iac"], weight: 0.5, category: "Cloud" },
      { id: "java", label: "Java", aliases: [], weight: 0.4, category: "Languages" },
      { id: "scala", label: "Scala", aliases: [], weight: 0.4, category: "Languages" },
      { id: "data-modeling", label: "Data Modeling", aliases: ["dimensional modeling", "star schema"], weight: 0.5, category: "Data" },
    ],
    minExperienceYears: 2,
    minEducation: "bachelor",
    keywords: [
      "data engineer",
      "pipeline",
      "etl",
      "elt",
      "warehouse",
      "spark",
      "kafka",
      "production data",
    ],
    notes:
      "Heavy on SQL, Python, and distributed data tools. Strong portfolio " +
      "projects on GitHub (a public dbt project, a Spark job with a README) " +
      "often substitute for traditional experience.",
  },

  "frontend-engineer": {
    key: "frontend-engineer",
    title: "Frontend Engineer",
    summary: "Mid-level Frontend Engineer shipping production React/Next.js apps.",
    domain: "Engineering",
    mustHave: [
      { id: "javascript", label: "JavaScript (ES2022+)", aliases: ["js", "ecmascript"], weight: 1, category: "Languages" },
      { id: "typescript", label: "TypeScript", aliases: ["ts"], weight: 1, category: "Languages" },
      { id: "react", label: "React", aliases: ["reactjs"], weight: 1, category: "Frontend" },
      { id: "nextjs", label: "Next.js (App Router)", aliases: ["next.js", "next"], weight: 0.8, category: "Frontend" },
      { id: "css", label: "CSS (modern)", aliases: ["css3", "flexbox", "grid"], weight: 0.9, category: "Frontend" },
      { id: "tailwind", label: "Tailwind CSS", aliases: [], weight: 0.6, category: "Frontend" },
      { id: "html", label: "Semantic HTML", aliases: ["html5"], weight: 0.8, category: "Frontend" },
      { id: "git", label: "Git", aliases: [], weight: 0.7, category: "Tooling" },
    ],
    niceToHave: [
      { id: "nodejs", label: "Node.js", aliases: ["node"], weight: 0.5, category: "Backend" },
      { id: "graphql", label: "GraphQL", aliases: [], weight: 0.4, category: "Backend" },
      { id: "testing", label: "Testing (Jest/Playwright/Vitest)", aliases: ["jest", "playwright", "vitest", "cypress"], weight: 0.5, category: "Quality" },
      { id: "accessibility", label: "Web Accessibility (a11y/WCAG)", aliases: ["a11y", "wcag", "aria"], weight: 0.5, category: "Quality" },
      { id: "design-systems", label: "Design Systems", aliases: ["storybook", "figma"], weight: 0.4, category: "Frontend" },
      { id: "performance", label: "Web Performance / Core Web Vitals", aliases: ["core web vitals", "lighthouse"], weight: 0.4, category: "Frontend" },
    ],
    minExperienceYears: 2,
    minEducation: "bachelor",
    keywords: [
      "frontend",
      "react",
      "next.js",
      "typescript",
      "ui",
      "ux",
    ],
    notes:
      "Portfolio beats résumé. A live deployed Next.js app with a clean " +
      "GitHub history and Lighthouse 90+ scores will outrank 2 years of " +
      "maintenance work at a non-tech company.",
  },

  "ml-engineer": {
    key: "ml-engineer",
    title: "ML Engineer",
    summary: "Machine Learning Engineer shipping models to production (research-to-prod).",
    domain: "ML/AI",
    mustHave: [
      { id: "python", label: "Python", aliases: ["py"], weight: 1, category: "Languages" },
      { id: "pytorch", label: "PyTorch", aliases: [], weight: 1, category: "ML" },
      { id: "tensorflow", label: "TensorFlow", aliases: ["tf"], weight: 0.7, category: "ML" },
      { id: "ml-fundamentals", label: "ML Fundamentals (training/eval/overfitting)", aliases: ["machine learning basics", "ml basics"], weight: 1, category: "ML" },
      { id: "sql", label: "SQL", aliases: [], weight: 0.7, category: "Data" },
      { id: "cloud", label: "Cloud (AWS/GCP/Azure)", aliases: ["aws", "gcp", "azure"], weight: 0.8, category: "Cloud" },
      { id: "docker", label: "Docker", aliases: ["containers"], weight: 0.6, category: "Cloud" },
      { id: "statistics", label: "Statistics & Probability", aliases: ["stats", "probability"], weight: 0.9, category: "Math" },
    ],
    niceToHave: [
      { id: "llm", label: "LLMs / RAG / Prompt Engineering", aliases: ["llms", "rag", "prompt engineering", "transformer"], weight: 0.6, category: "ML" },
      { id: "mlops", label: "MLOps (MLflow/Kubeflow/SageMaker)", aliases: ["mlflow", "kubeflow", "sagemaker"], weight: 0.6, category: "ML" },
      { id: "kubernetes", label: "Kubernetes", aliases: ["k8s"], weight: 0.5, category: "Cloud" },
      { id: "spark", label: "Apache Spark", aliases: ["pyspark"], weight: 0.4, category: "Data" },
      { id: "nlp", label: "NLP", aliases: ["natural language processing"], weight: 0.5, category: "ML" },
      { id: "cv", label: "Computer Vision", aliases: ["computer vision"], weight: 0.5, category: "ML" },
    ],
    minExperienceYears: 1,
    minEducation: "master",
    keywords: [
      "machine learning",
      "ml engineer",
      "pytorch",
      "tensorflow",
      "model deployment",
      "mlops",
    ],
    notes:
      "A published paper or a strong Kaggle/OSS portfolio substitutes for " +
      "production experience at the junior end. PhD is common but not required.",
  },
};

/** Ordered list of benchmarks for UI pickers. */
export const BENCHMARK_LIST: RoleBenchmark[] = Object.values(BENCHMARKS);

/** Lookup helper that throws a clean error if the key is unknown. */
export function getBenchmark(key: string): RoleBenchmark {
  const b = BENCHMARKS[key];
  if (!b) {
    const known = BENCHMARK_LIST.map((b) => b.key).join(", ");
    throw new Error(`Unknown benchmark "${key}". Known: ${known}`);
  }
  return b;
}

/** All skill tokens (id + aliases) for tokenising free-text JDs and CVs. */
export function buildSkillVocabulary(): Map<string, Skill> {
  const vocab = new Map<string, Skill>();
  for (const b of BENCHMARK_LIST) {
    for (const s of [...b.mustHave, ...b.niceToHave]) {
      vocab.set(s.id, s);
      for (const alias of s.aliases ?? []) vocab.set(alias.toLowerCase(), s);
    }
  }
  return vocab;
}
