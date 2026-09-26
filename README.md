# swandavid.com

Personal site: portfolio and an interactive rover path-planning demo (`/rover`).
Built with Astro, React islands, Tailwind CSS 4 and TypeScript. Deployed on Netlify.

## Run locally

```bash
bun install
bun run dev        # http://localhost:4321
```

## Checks

```bash
bun run lint       # ESLint (flat config, TS + Astro + React hooks + a11y)
bun run test       # Vitest
bun run build      # astro check (types) + astro build
bun run check      # all three, same as CI
bun run preview    # serve the built site
```

## Environment

`VIEWS_SALT` (any long random string) must be set in Netlify's environment
variables. Without it the view counter records nothing in production.

## Where things live

| Path                    | What                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/pages/`            | Routes: `index.astro` (portfolio), `rover.astro`, `404.astro`, and on-demand `api/views.ts`, `api/weather.ts`. |
| `src/layouts/`          | `BaseLayout` (head, theme script, fonts, OG tags) and `PageLayout` (narrow column with top nav).               |
| `src/components/`       | Static `.astro` sections incl. `TravelMap` and `MarathonCourse`; React islands `Sidebar` and `LiveConditions`. |
| `src/data/`             | Résumé data (`*.json`) rendered by the portfolio sections, and contact links (`contact.ts`).                   |
| `src/lib/`              | Pure TypeScript with unit tests: view counter, weather, map geometry, and the rover simulation (`rover/`).     |
| `src/styles/global.css` | Tailwind 4 entry, theme tokens, `.card` / `.tag` / `.prose-note` utilities.                                    |
| `scripts/snapshots.mjs` | Screenshots each project's live site into `src/assets/snapshots/`.                                             |
| `scripts/og-image.mjs`  | Renders `public/og.png`, the link preview shown on LinkedIn/Slack. Run `bun run og-image`.                     |
| `scripts/rover-*.mjs`   | Rover media: placeholder stills and the home-page loop. Need `bun run dev`; the loop also needs ffmpeg.        |
| `resume/resume.html`    | Résumé source. `bun run resume` renders it to `public/David_Swan_Resume.pdf`; keep it one column for ATS.      |
| `public/`               | Served as-is: favicon, `David_Swan_Resume.pdf`, `og.png`, `media/rover-loop.mp4`.                              |

## Project snapshots

Each project in `src/data/projects.json` with a `snapshotUrl` gets a fresh
screenshot every Monday from the **Project snapshots** GitHub Action. It
commits any image that differs from the one on disk, which for a site showing
live data is most weeks, and that push redeploys the site.
The capture date shown under each image comes from `src/data/snapshots.json`.

To refresh by hand:

```bash
bunx playwright install chromium   # once
bun run snapshots                  # all projects, or: bun run snapshots nexusodds
```

The Action can also be run on demand from the repo's Actions tab.

## Theme

Dark/light is a class on `<html>`. An inline script in `BaseLayout` sets it before first paint from `localStorage` or the OS preference, and the toggle in `Sidebar` flips it. Colors are CSS variables in `global.css` under `@theme`, overridden in `.dark`.
