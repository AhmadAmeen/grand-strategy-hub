/**
 * stagger-dates.js
 *
 * One-time maintenance script: assigns realistic staggered publication dates
 * to all articles so the site looks like it grew naturally over time,
 * rather than all 27 pages appearing on the same day.
 *
 * Usage: node scripts/stagger-dates.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTICLES_DIR = path.join(__dirname, '..', 'src', 'content', 'articles');

// slug -> publication date (weekly cadence, all in the past)
const DATE_MAP = {
	'best-eu4-mods-2026': '2026-02-11',
	'eu4-achievement-guide': '2026-02-17',
	'eu4-beginner-mistakes': '2026-02-24',
	'eu4-custom-nation-guide': '2026-03-03',
	'is-eu4-still-worth-playing': '2026-03-10',
	'eu4-government-reforms': '2026-03-17',
	'best-eu4-dlc': '2026-03-24',

	'ck3-succession-laws': '2026-03-31',
	'ck3-best-religion': '2026-04-07',
	'ck3-small-county-survival-guide': '2026-04-14',
	'ck3-culture-faith-mechanics': '2026-04-21',
	'ck3-dlc-guide': '2026-04-28',
	'ck3-intrigue-guide': '2026-05-05',
	'ck3-best-starting-character': '2026-05-12',
	'ck3-renown-prestige-guide': '2026-05-19',

	'best-paradox-grand-strategy-game-for-beginners': '2026-05-26',
	'paradox-dlc-release-schedule-2026': '2026-06-02',
	'paradox-games-prestige-explained': '2026-06-09',
	'clausewitz-engine-explained': '2026-06-16',

	'eu5-trade-guide': '2026-06-23',
	'eu5-unrest-estates': '2026-06-30',
	'best-eu5-starting-nation': '2026-07-07',
	'eu5-army-composition': '2026-07-14',
	'eu5-pop-system': '2026-07-21',
	'eu5-vs-eu4-differences': '2026-07-28',
	'eu5-diplomacy-guide': '2026-08-04',
	'eu5-estates-guide': '2026-08-11',
};

let updated = 0;

for (const [slug, date] of Object.entries(DATE_MAP)) {
	const filePath = path.join(ARTICLES_DIR, `${slug}.md`);
	if (!fs.existsSync(filePath)) {
		console.warn(`  SKIP (not found): ${slug}.md`);
		continue;
	}

	let content = fs.readFileSync(filePath, 'utf8');
	const original = content;

	// Replace the date line in frontmatter: `date: YYYY-MM-DD`
	content = content.replace(/^(date:\s*)\d{4}-\d{2}-\d{2}$/m, `$1${date}`);

	if (content !== original) {
		fs.writeFileSync(filePath, content, 'utf8');
		updated++;
		console.log(`  ✓ ${slug} -> ${date}`);
	} else {
		console.warn(`  NO CHANGE: ${slug}`);
	}
}

console.log(`\nDone. Updated ${updated} article dates.`);