import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { file } from "astro/loaders";

const experience = defineCollection({
  loader: file("src/data/experience.json"),
  schema: z.object({
    company: z.string(),
    companyUrl: z.url(),
    /** Newest first; the first entry is the current role. */
    roles: z.array(z.object({ title: z.string(), period: z.string() })),
    /** Résumé-style bullets for the current role; earlier roles live in the PDF. */
    highlights: z.array(z.string()).optional(),
    technologies: z.array(z.string()).optional(),
  }),
});

const projects = defineCollection({
  loader: file("src/data/projects.json"),
  schema: ({ image }) =>
    z.object({
      name: z.string(),
      /** Your part in it, e.g. "Co-founder". Shown next to the name. */
      role: z.string().optional(),
      /** Omit for a project with nothing public to link to. */
      projectUrl: z.string().optional(),
      sourceUrl: z.url().optional(),
      /** Live page to screenshot on a schedule (scripts/snapshots.mjs). */
      snapshotUrl: z.url().optional(),
      description: z.string().optional(),
      technologies: z.array(z.string()).optional(),
      image: image(),
      /** Silent loop under public/ (scripts/rover-video.mjs); `image` is its poster. */
      video: z.string().optional(),
    }),
});

const education = defineCollection({
  loader: file("src/data/education.json"),
  schema: z.object({
    period: z.string(),
    degree: z.string(),
    minor: z.string().optional(),
    institution: z.string(),
    description: z.string().optional(),
  }),
});

export const collections = { experience, projects, education };
