import { toPng } from 'html-to-image';

/**
 * Marks a DOM subtree to be excluded from client-side PNG export. Put this
 * attribute on elements (e.g. action buttons) that should not appear in the
 * downloaded image.
 */
export const CHART_EXPORT_IGNORE_ATTR = 'data-chart-export-ignore';

/**
 * Renders a DOM element to a PNG and triggers a browser download.
 *
 * Used for custom chart plugins ("vibe coded charts") which only render in the
 * browser and therefore have no server-side image path. We snapshot the live
 * DOM (works for vanilla DOM, canvas and Recharts SVG plugins alike).
 */
export async function downloadElementAsPng(element: HTMLElement, fileName: string): Promise<void> {
	const dataUrl = await toPng(element, {
		pixelRatio: 2,
		backgroundColor: resolveBackgroundColor(element),
		filter: (node) => !(node instanceof HTMLElement && node.hasAttribute(CHART_EXPORT_IGNORE_ATTR)),
	});
	triggerImageDownload(dataUrl, fileName);
}

/** Triggers a download for an image data URL or base64 PNG href. */
export function triggerImageDownload(href: string, fileName: string): void {
	const link = document.createElement('a');
	link.download = fileName.endsWith('.png') ? fileName : `${fileName}.png`;
	link.href = href;
	link.click();
}

/**
 * Finds the nearest opaque background color so the exported PNG matches what the
 * user sees instead of rendering on transparency (which breaks dark-theme charts
 * with light-colored content).
 */
function resolveBackgroundColor(element: HTMLElement): string {
	let node: HTMLElement | null = element;
	while (node) {
		const color = getComputedStyle(node).backgroundColor;
		if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') {
			return color;
		}
		node = node.parentElement;
	}
	return '#ffffff';
}
