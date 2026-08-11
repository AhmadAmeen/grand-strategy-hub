import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const articles = defineCollection({
	// Load Markdown files in the `src/content/articles/` directory.
	loader: glob({ base: './src/content/articles', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: z.object({
		title: z.string(),
		description: z.string(),
		keywords: z.string(),
		// Transform string to Date object
		date: z.coerce.date(),
		category: z.enum(['EU4', 'EU5', 'CK3', 'Comparisons']),
		slug: z.string(),
	}),
});

export const collections = { articles };