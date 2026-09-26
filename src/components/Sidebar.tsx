import { useEffect, useState, useSyncExternalStore } from "react";
import { FileText, Mail, Moon, Sun } from "lucide-react";
import LiveConditions from "./LiveConditions";
import { EMAIL, GITHUB_URL, LINKEDIN_URL } from "@/data/contact";

const SECTIONS = [
  { id: "about", label: "About" },
  { id: "experience", label: "Experience" },
  { id: "projects", label: "Projects" },
  { id: "education", label: "Education" },
  { id: "outside-work", label: "Outside work" },
] as const;

type Theme = "dark" | "light";

// The <html> class is the single source of truth for the theme. It is set
// before paint by the inline script in BaseLayout, so we read it rather than
// duplicating that logic in React state.
function subscribeToTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}
const getTheme = (): Theme =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";
const getServerTheme = (): Theme => "dark";

function useTheme(): Theme {
  return useSyncExternalStore(subscribeToTheme, getTheme, getServerTheme);
}

function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useTheme();

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Storage blocked; the toggle still applies for this page view.
    }
  };

  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={`focus-visible:ring-accent dark:bg-surface relative h-7 w-14 rounded-full bg-gray-200 transition-colors duration-300 focus:outline-none focus-visible:ring-2 ${className}`}
    >
      <span
        className={`absolute top-1 left-1 flex h-5 w-5 items-center justify-center rounded-full transition-transform duration-300 ${
          isDark ? "bg-canvas translate-x-7" : "translate-x-0 bg-white"
        }`}
      >
        <Sun
          className={`absolute h-4 w-4 text-yellow-500 transition-all duration-300 ${isDark ? "scale-0 opacity-0" : "scale-100 opacity-100"}`}
          style={{ filter: "drop-shadow(0 0 8px rgba(234, 179, 8, 0.5))" }}
        />
        <Moon
          className={`absolute h-4 w-4 text-blue-100 transition-all duration-300 ${isDark ? "scale-100 opacity-100" : "scale-0 opacity-0"}`}
          style={{ filter: "drop-shadow(0 0 8px rgba(147, 197, 253, 0.8))" }}
        />
      </span>
    </button>
  );
}

function SocialLinks({ size }: { size: string }) {
  return (
    <div className="flex gap-6">
      <a
        href={`mailto:${EMAIL}`}
        aria-label="Email"
        className="text-ink-faint hover:text-ink transition-colors"
      >
        <Mail className={size} aria-hidden="true" />
      </a>
      <a
        href={GITHUB_URL}
        aria-label="GitHub"
        className="text-ink-faint hover:text-ink transition-colors"
      >
        <svg
          viewBox="0 0 24 24"
          className={size}
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3z" />
        </svg>
      </a>
      <a
        href={LINKEDIN_URL}
        aria-label="LinkedIn"
        className="text-ink-faint hover:text-ink transition-colors"
      >
        <svg
          viewBox="0 0 24 24"
          className={size}
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M20.4 20.5h-3.6v-5.6c0-1.3 0-3-1.8-3s-2.1 1.4-2.1 2.9v5.7H9.3V9h3.4v1.6c.5-.9 1.7-1.8 3.4-1.8 3.6 0 4.3 2.4 4.3 5.5v6.2zM5.3 7.4a2.1 2.1 0 1 1 0-4.2 2.1 2.1 0 0 1 0 4.2zM7.1 20.5H3.5V9h3.6v11.5zM22.2 0H1.8C.8 0 0 .8 0 1.7v20.6c0 .9.8 1.7 1.8 1.7h20.4c1 0 1.8-.8 1.8-1.7V1.7C24 .8 23.2 0 22.2 0z" />
        </svg>
      </a>
    </div>
  );
}

/** Kept above the fold. */
function ResumeButton() {
  return (
    <a
      href="/David_Swan_Resume.pdf"
      target="_blank"
      rel="noopener noreferrer"
      className="border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 focus-visible:ring-accent inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition-colors"
    >
      <FileText className="size-4" aria-hidden="true" />
      Résumé
    </a>
  );
}

/**
 * Left column on the home page. React island so the theme toggle and
 * scroll-spy nav can hold state; everything else on the page is static HTML.
 */
export default function Sidebar({ photo }: { photo: string }) {
  const [active, setActive] = useState<string>("about");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        const top = visible.reduce((a, b) =>
          a.boundingClientRect.top > b.boundingClientRect.top ? b : a,
        );
        setActive(top.target.id);
      },
      { rootMargin: "-20% 0px -75%", threshold: 0 },
    );
    document
      .querySelectorAll("section[id]")
      .forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  const navClass = (id: string) =>
    `transition-colors ${active === id ? "text-ink" : "text-ink-faint hover:text-ink"}`;

  return (
    <aside className="border-edge bg-canvas relative top-0 z-10 flex h-auto w-full flex-col border-b p-4 md:fixed md:left-0 md:h-screen md:w-[33.33vw] md:border-r md:border-b-0 md:p-12">
      <div className="flex-1">
        {/* Centred on phones (the toggle sits in the corner), left-aligned in
            the desktop sidebar. */}
        <header className="relative mb-8 pt-10 text-center md:mb-16 md:pt-0 md:text-left">
          <div className="absolute top-0 right-4 md:hidden">
            <ThemeToggle />
          </div>
          <img
            src={photo}
            alt="David Swan"
            width={96}
            height={96}
            className="border-edge mx-auto mb-4 size-20 rounded-full border object-cover md:mx-0 md:mb-6 md:size-24"
          />
          <h1 className="text-ink mb-2 text-2xl font-bold md:mb-4 md:text-5xl">
            David Swan
          </h1>
          <p className="text-ink-muted mb-3 text-lg text-balance md:mb-6 md:text-2xl">
            Software Engineer · Autonomy, Robotics & Edge ML
          </p>
          <div className="flex flex-col items-center gap-4 px-4 md:items-start md:px-0">
            <p className="text-ink-faint text-sm text-balance md:text-lg md:text-pretty">
              I build software across the whole stack: robots, models, edge
              hardware, and the web apps and pipelines that tie them together.
            </p>
            <p className="text-ink-muted text-sm text-balance md:text-base">
              Open to software roles in autonomy, robotics and edge inference in
              the San Francisco Bay Area.
            </p>
            <LiveConditions />
            <div className="flex items-center gap-6 md:hidden">
              <ResumeButton />
              <SocialLinks size="h-5 w-5" />
            </div>
            <div className="hidden md:block">
              <ResumeButton />
            </div>
          </div>
        </header>

        <nav className="mb-4 hidden md:mb-16 md:block" aria-label="Sections">
          <ul className="label space-y-4">
            {SECTIONS.map(({ id, label }) => (
              <li key={id}>
                <a href={`#${id}`} className={navClass(id)}>
                  {label.toUpperCase()}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="hidden flex-col gap-8 md:flex">
        <ThemeToggle />
        <footer>
          <SocialLinks size="h-6 w-6" />
        </footer>
      </div>
    </aside>
  );
}
