/**
 * indexing-agent.js
 *
 * Monitoring agent: reads all URLs from the site's sitemap and checks their
 * indexing status via Google's URL Inspection API. Logs which pages are
 * indexed and which aren't, so you can track indexing progress over time.
 *
 * NOTE: Google's Indexing API is restricted to JobPosting/BroadcastEvent
 * content only. For regular blog articles, the sitemap submission (already
 * done in Search Console) is what drives indexing. This agent is for
 * monitoring/logging purposes only.
 *
 * Requirements:
 *   - Google service account JSON key file (path in GOOGLE_SERVICE_ACCOUNT_CREDENTIALS)
 *   - Sitemap URL (defaults to the site's sitemap-index.xml)
 *
 * Usage:
 *   GOOGLE_SERVICE_ACCOUNT_CREDENTIALS=path/to/key.json node indexing-agent.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
	try {
		process.loadEnvFile(envPath);
	} catch (error) {
		console.error(`WARNING: Could not load .env file: ${error.message}`);
	}
}

const SITE_URL = 'https://grand-strategy-hub.pages.dev';
const SITEMAP_URL = `${SITE_URL}/sitemap-index.xml`;
const DAILY_QUOTA = 200; // Google's URL Inspection API daily limit

// Google APIs
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const INSPECT_API_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

// Google service account key. Can be either:
//   - A file path to the JSON key file (local development)
//   - The JSON content itself (GitHub Actions secret)
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_CREDENTIALS;
if (!SERVICE_ACCOUNT_JSON) {
	console.error('ERROR: GOOGLE_SERVICE_ACCOUNT_CREDENTIALS environment variable is not set.');
	console.error('Set it before running:  GOOGLE_SERVICE_ACCOUNT_CREDENTIALS=path/to/key.json node indexing-agent.js');
	process.exit(1);
}

function loadServiceAccount() {
	// If the value is a file path that exists, read the file
	if (fs.existsSync(SERVICE_ACCOUNT_JSON)) {
		return JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_JSON, 'utf8'));
	}
	// Otherwise, treat the value as the JSON content itself
	return JSON.parse(SERVICE_ACCOUNT_JSON);
}

async function getAccessToken() {
	const keyFile = loadServiceAccount();
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: 'RS256', typ: 'JWT' };
	const claim = {
		iss: keyFile.client_email,
		scope: 'https://www.googleapis.com/auth/webmasters.readonly',
		aud: OAUTH_TOKEN_URL,
		iat: now,
		exp: now + 3600,
	};

	// Base64url encode
	const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
	const signingInput = `${b64(header)}.${b64(claim)}`;

	// Sign with RSA-SHA256 using the private key
	const crypto = await import('node:crypto');
	const signature = crypto
		.createSign('RSA-SHA256')
		.update(signingInput)
		.sign(keyFile.private_key);

	const jwt = `${signingInput}.${signature.toString('base64url')}`;

	const response = await fetch(OAUTH_TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
			assertion: jwt,
		}),
	});

	if (!response.ok) {
		throw new Error(`OAuth token request failed (${response.status}): ${await response.text()}`);
	}

	const data = await response.json();
	return data.access_token;
}

/**
 * Fetch all page URLs from the sitemap.
 * Handles both:
 *   - A sitemap index (points to sub-sitemaps)
 *   - A regular sitemap (lists pages directly)
 */
async function getSitemapUrls() {
	const response = await fetch(SITEMAP_URL);
	if (!response.ok) {
		throw new Error(`Could not fetch sitemap (${response.status})`);
	}
	const xml = await response.text();

	// Check if this is a sitemap index (contains <sitemap> entries)
	const subSitemaps = [...xml.matchAll(/<sitemap>\s*<loc>(.*?)<\/loc>/g)].map((m) => m[1]);

	if (subSitemaps.length > 0) {
		console.log(`  Sitemap index found with ${subSitemaps.length} sub-sitemap(s)`);
		const allUrls = [];
		for (const subSitemap of subSitemaps) {
			const subResponse = await fetch(subSitemap);
			if (!subResponse.ok) {
				console.warn(`  ⚠ Could not fetch sub-sitemap: ${subSitemap} (${subResponse.status})`);
				continue;
			}
			const subXml = await subResponse.text();
			const urls = [...subXml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
			allUrls.push(...urls);
			console.log(`  ✓ ${subSitemap}: ${urls.length} URLs`);
		}
		return allUrls.filter((url) => url.startsWith(SITE_URL));
	}

	// Regular sitemap — extract URLs directly
	const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
	return urls.filter((url) => url.startsWith(SITE_URL));
}

async function checkIndexingStatus(accessToken, url) {
	const response = await fetch(INSPECT_API_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({
			inspectionUrl: url,
			siteUrl: SITE_URL,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Inspection API failed (${response.status}): ${errorText}`);
	}

	const data = await response.json();
	return data.inspectionResult?.indexStatusResult?.coverageState;
}

async function main() {
	console.log('Starting indexing monitoring agent...\n');

	// 1. Authenticate
	console.log('Authenticating with Google...');
	const accessToken = await getAccessToken();
	console.log('  ✓ Authenticated\n');

	// 2. Get all URLs from sitemap
	console.log(`Fetching sitemap: ${SITEMAP_URL}`);
	const urls = await getSitemapUrls();
	console.log(`  ✓ Found ${urls.length} page URLs\n`);

	// 3. Check each URL
	let checked = 0;
	let indexed = 0;
	let notIndexed = 0;
	let quotaExceeded = false;
	const notIndexedUrls = [];

	for (const url of urls) {
		if (checked >= DAILY_QUOTA) {
			console.log(`\n⚠ Quota reached (${DAILY_QUOTA} requests). Stopping gracefully.`);
			quotaExceeded = true;
			break;
		}

		checked++;
		process.stdout.write(`[${checked}/${urls.length}] Checking: ${url} ... `);

		try {
			const status = await checkIndexingStatus(accessToken, url);

			if (status === 'APPROVED' || status === 'URL_IS_CRAWLABLE' || status === 'CRAWLABLE') {
				console.log('✓ indexed');
				indexed++;
			} else {
				console.log(`✗ not indexed (${status || 'unknown'})`);
				notIndexed++;
				notIndexedUrls.push(url);
			}
		} catch (error) {
			console.log(`  ✗ Error: ${error.message}`);
		}

		// Small delay to avoid rate limiting
		await new Promise((resolve) => setTimeout(resolve, 250));
	}

	// 4. Summary
	console.log('\n=== SUMMARY ===');
	console.log(`URLs checked: ${checked}`);
	console.log(`Indexed: ${indexed}`);
	console.log(`Not indexed: ${notIndexed}`);
	if (notIndexedUrls.length > 0) {
		console.log('\nPages not yet indexed:');
		for (const url of notIndexedUrls) {
			console.log(`  - ${url}`);
		}
	}
	if (quotaExceeded) {
		console.log('Note: Daily quota reached — remaining URLs will be checked tomorrow.');
	}
	console.log('\nNote: Indexing is driven by the sitemap submission in Search Console.');
	console.log('This agent monitors indexing status only. Google crawls at its own pace.');
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});