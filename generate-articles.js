/**
 * generate-articles.js
 *
 * Reads topics from topics.json, calls the DeepSeek API for each topic,
 * and saves the generated article as a Markdown file in src/content/articles/.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=your_key_here node generate-articles.js
 *
 * The API key is read from the DEEPSEEK_API_KEY environment variable.
 * Never hardcode API keys in this file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-chat';
const DELAY_MS = 2000; // Delay between requests to avoid rate limits
const MAX_RETRIES = 3;

const ARTICLES_DIR = path.join(__dirname, 'src', 'content', 'articles');

// If a .env file exists, load it (Node 20.12+). This lets you put
// DEEPSEEK_API_KEY=sk-... in a .env file instead of setting it in the terminal.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
	try {
		process.loadEnvFile(envPath);
		console.log('Loaded API key from .env file.');
	} catch (error) {
		console.error(`WARNING: Could not load .env file: ${error.message}`);
	}
}

// Read the API key from the environment. Never hardcode it.
const API_KEY = process.env.DEEPSEEK_API_KEY;
if (!API_KEY) {
	console.error('ERROR: DEEPSEEK_API_KEY environment variable is not set.');
	console.error('Set it before running:  DEEPSEEK_API_KEY=your_key_here node generate-articles.js');
	process.exit(1);
}

// Make sure the articles directory exists
fs.mkdirSync(ARTICLES_DIR, { recursive: true });

/**
 * Convert a title into a URL-friendly slug.
 * Example: "EU5 Beginner's Guide: Trade and Merchants Explained"
 *   -> "eu5-beginners-guide-trade-and-merchants-explained"
 */
function slugify(title) {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '') // Remove punctuation
		.replace(/\s+/g, '-') // Replace spaces with hyphens
		.replace(/-+/g, '-') // Collapse multiple hyphens
		.replace(/^-|-$/g, ''); // Trim leading/trailing hyphens
}

/**
 * Build the prompt sent to DeepSeek for a given topic.
 * The prompt is carefully worded to produce useful, accurate, SEO-friendly content.
 */
function buildPrompt(topic) {
	return `Write a comprehensive, SEO-friendly guide article for players of Paradox Interactive grand strategy games.

Title: ${topic.title}
Target keyword: ${topic.targetKeyword}
Category: ${topic.category}

Requirements:
- Write approximately 1000 words.
- Use the target keyword naturally in the title, first paragraph, and at least two subheadings.
- Write in clear, practical, helpful language aimed at players who want to understand game mechanics or improve their gameplay.
- Be factually accurate about game mechanics. If you are unsure about a specific mechanic, describe it in general terms rather than inventing specific numbers.
- Structure the article with an introduction, 4-6 subheadings (using ## for subheadings), and a short conclusion.
- Use bullet points or numbered lists where they help readability.
- Do NOT include a title line at the top (the title is added separately).
- Do NOT include any meta description, keywords, or frontmatter — only the article body in Markdown.
- Do NOT mention that you are an AI or that this article was AI-generated.
- Write for an audience that already plays grand strategy games but may be new to this specific game or mechanic.

Return ONLY the article body in Markdown format.`;
}

/**
 * Call the DeepSeek API with retry logic.
 * Returns the article body text.
 */
async function generateArticle(topic) {
	const prompt = buildPrompt(topic);

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		try {
			const response = await fetch(API_URL, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${API_KEY}`,
				},
				body: JSON.stringify({
					model: MODEL,
					messages: [
						{
							role: 'system',
							content:
								'You are a professional game guide writer specializing in Paradox Interactive grand strategy games (Europa Universalis IV, Europa Universalis V, Crusader Kings III). You write clear, accurate, practical guides for players.',
						},
						{ role: 'user', content: prompt },
					],
					max_tokens: 2000,
					temperature: 0.7,
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`API request failed (${response.status}): ${errorText}`);
			}

			const data = await response.json();
			const content = data.choices?.[0]?.message?.content?.trim();

			if (!content) {
				throw new Error('API response contained no content');
			}

			return content;
		} catch (error) {
			console.error(`  Attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}`);
			if (attempt < MAX_RETRIES) {
				// Wait longer between retries
				await sleep(DELAY_MS * attempt);
			} else {
				throw error;
			}
		}
	}
}

/**
 * Generate a meta description from the article body.
 * Takes the first sentence, truncated to ~155 characters.
 */
function generateDescription(articleBody) {
	// Strip Markdown formatting for the description
	const plainText = articleBody
		.replace(/[#*`>_~]/g, '')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();

	// Take the first sentence
	const firstSentence = plainText.split(/[.!?]/)[0]?.trim() ?? plainText;

	// Truncate to ~155 characters
	if (firstSentence.length <= 155) {
		return firstSentence;
	}
	return firstSentence.slice(0, 152).trimEnd() + '...';
}

/**
 * Build the full Markdown file content with frontmatter.
 */
function buildMarkdownFile(topic, articleBody, slug) {
	const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
	const description = generateDescription(articleBody);

	return `---
title: "${topic.title.replace(/"/g, '\\"')}"
description: "${description.replace(/"/g, '\\"')}"
keywords: "${topic.targetKeyword}"
date: ${today}
category: "${topic.category}"
slug: "${slug}"
---

${articleBody}
`;
}

/**
 * Simple sleep helper.
 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Main entry point.
 */
async function main() {
	// Read topics.json
	const topicsPath = path.join(__dirname, 'topics.json');
	let topics;
	try {
		topics = JSON.parse(fs.readFileSync(topicsPath, 'utf8'));
	} catch (error) {
		console.error(`ERROR: Could not read topics.json: ${error.message}`);
		process.exit(1);
	}

	if (!Array.isArray(topics) || topics.length === 0) {
		console.error('ERROR: topics.json must contain a non-empty array of topics.');
		process.exit(1);
	}

	console.log(`Found ${topics.length} topics. Starting generation...\n`);

	let successCount = 0;
	let failCount = 0;

	for (let i = 0; i < topics.length; i++) {
		const topic = topics[i];
		const slug = slugify(topic.title);
		const filePath = path.join(ARTICLES_DIR, `${slug}.md`);

		console.log(`[${i + 1}/${topics.length}] Generating: ${topic.title}`);

		try {
			const articleBody = await generateArticle(topic);
			const markdown = buildMarkdownFile(topic, articleBody, slug);
			fs.writeFileSync(filePath, markdown, 'utf8');
			console.log(`  ✓ Saved to ${path.relative(__dirname, filePath)}`);
			successCount++;
		} catch (error) {
			console.error(`  ✗ FAILED: ${error.message}`);
			failCount++;
		}

		// Delay between requests (but not after the last one)
		if (i < topics.length - 1) {
			await sleep(DELAY_MS);
		}
	}

	console.log(`\nDone. ${successCount} articles generated, ${failCount} failed.`);
	if (failCount > 0) {
		console.log('Re-run the script to retry failed articles (existing files will be overwritten).');
		process.exit(1);
	}
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});