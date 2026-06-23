import { DEFAULT_COLORS } from '@nao/shared';
import type { displayChart } from '@nao/shared/tools';

import { chartPluginService } from '../services/chart-plugin.service';
import { getBrowser } from './headless-browser';

export interface RenderCustomChartInput {
	config: Pick<displayChart.Input, 'chart_type' | 'x_axis_key' | 'x_axis_type' | 'series' | 'title'>;
	data: Record<string, unknown>[];
	width?: number;
	height?: number;
}

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 500;
const RENDER_TIMEOUT_MS = 15000;

/**
 * Renders a custom chart plugin ("vibe coded chart") to a PNG for headless
 * contexts (automations, Slack, Telegram, ...).
 *
 * Custom plugins are browser-only ES modules with no server-side SVG path, so
 * we execute them in a headless Chromium page — mirroring the frontend's
 * `CustomChart` render context — and screenshot the result.
 */
export async function renderCustomChartImage(input: RenderCustomChartInput): Promise<Buffer> {
	const source = chartPluginService.getPluginSource(input.config.chart_type);
	if (!source) {
		throw new Error(`Custom chart plugin "${input.config.chart_type}" was not found.`);
	}

	const width = input.width ?? DEFAULT_WIDTH;
	const height = input.height ?? DEFAULT_HEIGHT;
	const html = buildChartHtml(source, input, width, height);

	const browser = await getBrowser();
	const page = await browser.newPage();
	try {
		await page.setViewport({ width, height, deviceScaleFactor: 2 });
		await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: RENDER_TIMEOUT_MS });
		// The page sets `data-rendered` only after the plugin (and its CDN imports) finish.
		const element = await page.waitForSelector('#chart[data-rendered="true"]', { timeout: RENDER_TIMEOUT_MS });
		if (!element) {
			throw new Error('Custom chart did not finish rendering.');
		}
		const error = await page.$eval('#chart', (el) => el.getAttribute('data-error'));
		if (error) {
			throw new Error(`Custom chart render failed: ${error}`);
		}
		const screenshot = await element.screenshot({ type: 'png' });
		return Buffer.from(screenshot);
	} finally {
		await page.close().catch(() => {});
	}
}

function buildChartHtml(source: string, input: RenderCustomChartInput, width: number, height: number): string {
	const context = {
		data: input.data,
		config: {
			chartType: input.config.chart_type,
			xAxisKey: input.config.x_axis_key,
			xAxisType: input.config.x_axis_type ?? null,
			series: input.config.series,
			title: input.config.title,
		},
		theme: 'light',
		colors: DEFAULT_COLORS,
	};

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
	html, body { margin: 0; padding: 0; background: #ffffff; }
	#chart { width: ${width}px; height: ${height}px; background: #ffffff; }
</style>
</head>
<body>
<div id="chart"></div>
<script type="module">
import * as React from 'https://esm.sh/react@19.2.0';
import * as ReactDOM from 'https://esm.sh/react-dom@19.2.0/client';
import * as Recharts from 'https://esm.sh/recharts@2.15.4?deps=react@19.2.0,react-dom@19.2.0';

const element = document.getElementById('chart');
try {
	const context = ${js(context)};
	context.libs = { React, ReactDOM, Recharts };
	const blob = new Blob([${js(source)}], { type: 'text/javascript' });
	const module = await import(URL.createObjectURL(blob));
	if (typeof module.render !== 'function') {
		throw new Error('Plugin does not export a render function.');
	}
	await module.render(element, context);
	// Let async work and Recharts' ResponsiveContainer layout settle before the screenshot.
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	await new Promise((resolve) => setTimeout(resolve, 200));
} catch (err) {
	element.setAttribute('data-error', String((err && err.message) || err));
}
element.setAttribute('data-rendered', 'true');
</script>
</body>
</html>`;
}

/** Serializes a value into a script-safe JS literal (escapes `<` and line separators). */
function js(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}
