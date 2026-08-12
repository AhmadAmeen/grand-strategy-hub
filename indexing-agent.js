/**
 * indexing-agent.js
 *
 * Reads all URLs from the site's sitemap, checks their indexing status via
 * Google's URL Inspection API, and requests indexing for any URL that isn't
 * indexed. Respects Google's daily quota (~200 requests/day) and stops
 * gracefully when the limit is reached.
 *
 * Requirements:
 *   - Google service account JSON key file (path in GOOGLE_SERVICE_ACCOUNT_JSON)
 *   - Sitemap URL (defaults to the site's sitemap-index.xml)
 *
 * Usage:
 *   GOOGLE_SERVICE_ACCOUNT_JSON=path/to/key.json node indexing-agent.js
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
const DAILY_QUOTA = 200; // Google's Indexing API daily limit

// Google APIs
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const INDEXING_API_URL = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const INSPECT_API_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

// Google service account key file path
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!SERVICE_ACCOUNT_JSON) {
	console.error('ERROR: GOOGLE_SERVICE_ACCOUNT_JSON environment variable is not set.');
	console.error('Set it before running:  GOOGLE_SERVICE_ACCOUNT_JSON=path/to/key.json node indexing-agent.js');
	process.exit(1);
}

async function getAccessToken() {
	const keyFile = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_JSON, 'utf8'));
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: 'RS256', typ: 'JWT' };
	const claim = {
		iss: keyFile.client_email,
		scope: 'https://www.googleapis.com/auth/indexing',
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

async function getSitemapUrls() {
	const response = await fetch(SITEMAP_URL);
	if (!response.ok) {
		throw new Error(`Could not fetch sitemap (${response.status})`);
	}
	const xml = await response.text();
	// Extract all <loc> URLs
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

async function requestIndexing(accessToken, url) {
	const response = await fetch(INDEXING_API_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({
			url,
			type: 'URL_UPDATED',
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Indexing API failed (${response.status}): ${errorText}`);
	}

	return response.json();
}

async function main() {
	console.log('Starting indexing agent...\n');

	// 1. Authenticate
	console.log('Authenticating with Google...');
	const accessToken = await getAccessToken();
	console.log('  ✓ Authenticated\n');

	// 2. Get all URLs from sitemap
	console.log(`Fetching sitemap: ${SITEMAP_URL}`);
	const urls = await getSitemapUrls();
	console.log(`  ✓ Found ${urls.length} URLs\n`);

	// 3. Check each URL
	let checked = 0;
	let indexed = 0;
	let notIndexed = 0;
	let submitted = 0;
	let quotaExceeded = false;

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
				console.log('indexed');
				indexed++;
			} else {
				// Not indexed or not crawlable — request indexing
				console.log(`not indexed (${status || 'unknown'}), requesting indexing...`);
				try {
					await requestIndexing(accessToken, url);
					console.log('  ✓ Submitted');
					submitted++;
				} catch (error) {
					if (error.message.includes('429') || error.message.includes('quota')) {
						console.log('  ⚠ Quota exceeded, stopping.');
						quotaExceeded = true;
						break;
					}
					console.log(`  ✗ Failed: ${error.message}`);
				}
				notIndexed++;
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
	console.log(`Already indexed: ${indexed}`);
	console.log(`Not indexed: ${notIndexed}`);
	console.log(`Indexing requested: ${submitted}`);
	if (quotaExceeded) {
		console.log('Note: Daily quota reached — remaining URLs will be checked tomorrow.');
	}
}

main().catch((error) => {
	console.error('Fatal error:', error);
	process.exit(1);
});