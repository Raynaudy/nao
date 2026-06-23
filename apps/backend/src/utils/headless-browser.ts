import { execSync } from 'child_process';
import { existsSync } from 'fs';
import type { Browser } from 'puppeteer-core';

/**
 * Shared headless Chromium instance (via puppeteer-core) used for server-side
 * rendering tasks such as story PDF export and custom chart image generation.
 *
 * The browser is launched lazily, reused across calls, and closed on process
 * exit. puppeteer-core is imported dynamically so the rest of the backend keeps
 * working when Chrome/Chromium is not installed.
 */

let browserPromise: Promise<Browser> | null = null;

async function loadPuppeteer() {
	try {
		return await import('puppeteer-core');
	} catch {
		throw new Error(
			'puppeteer-core is not available. Headless rendering requires puppeteer-core and a Chrome/Chromium installation.',
		);
	}
}

export async function getBrowser(): Promise<Browser> {
	if (browserPromise) {
		const browser = await browserPromise;
		if (browser.connected) {
			return browser;
		}
		await browser.close().catch(() => {});
	}
	const puppeteer = await loadPuppeteer();
	browserPromise = puppeteer.default.launch({
		headless: true,
		executablePath: findChromePath(),
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
	});
	return browserPromise;
}

function findChromePath(): string {
	const candidates = [
		process.env.CHROME_PATH,
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
		'/usr/bin/google-chrome',
	];

	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) {
			return candidate;
		}
	}

	try {
		return execSync('which chromium || which chromium-browser || which google-chrome', {
			encoding: 'utf-8',
		}).trim();
	} catch {
		throw new Error('Chrome/Chromium not found. Install chromium or set the CHROME_PATH environment variable.');
	}
}

export async function closeBrowser(): Promise<void> {
	if (!browserPromise) {
		return;
	}
	const browser = await browserPromise.catch(() => null);
	browserPromise = null;
	await browser?.close().catch(() => {});
}

for (const signal of ['SIGINT', 'SIGTERM', 'exit'] as const) {
	process.on(signal, () => void closeBrowser());
}
