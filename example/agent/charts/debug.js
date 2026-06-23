/**
 * Debug chart plugin: renders the parameters nao passes to a plugin.
 *
 * It does not visualise the data — it pretty-prints the full render context
 * (config, data rows, theme, colors, available libs) so you can inspect exactly
 * what the agent and the host provide. Handy when building other plugins.
 */

export const meta = {
	name: 'Debug',
	description:
		'Diagnostic chart that displays the raw parameters passed to a chart plugin (config, data rows, theme, color palette and injected libraries). Use it to inspect what the agent sent rather than to visualise data.',
};

export function render(element, ctx) {
	const { data, config, colors, theme, libs } = ctx;
	const isDark = theme === 'dark';
	const textColor = isDark ? '#e5e7eb' : '#111827';
	const mutedColor = isDark ? '#9ca3af' : '#6b7280';
	const borderColor = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
	const panelBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';

	const wrapper = document.createElement('div');
	wrapper.style.cssText = `display:flex;flex-direction:column;gap:16px;width:100%;height:100%;overflow:auto;padding:12px;box-sizing:border-box;color:${textColor};font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;`;

	const section = (title, body) => {
		const block = document.createElement('div');
		block.style.cssText = `border:1px solid ${borderColor};border-radius:8px;background:${panelBg};overflow:hidden;`;

		const head = document.createElement('div');
		head.style.cssText = `padding:6px 10px;font-weight:600;border-bottom:1px solid ${borderColor};letter-spacing:.02em;`;
		head.textContent = title;

		const content = document.createElement('pre');
		content.style.cssText = 'margin:0;padding:10px;white-space:pre-wrap;word-break:break-word;line-height:1.5;';
		content.textContent = body;

		block.appendChild(head);
		block.appendChild(content);
		return block;
	};

	const stringify = (value) => {
		try {
			return JSON.stringify(value, null, 2);
		} catch (error) {
			return String(value);
		}
	};

	const rows = Array.isArray(data) ? data : [];
	const libNames = libs ? Object.keys(libs) : [];

	wrapper.appendChild(section('theme', String(theme)));
	wrapper.appendChild(section('config', stringify(config)));
	wrapper.appendChild(section('colors (' + (colors ? colors.length : 0) + ')', stringify(colors)));
	wrapper.appendChild(section('libs', libNames.length ? libNames.join(', ') : '(none)'));
	wrapper.appendChild(section('data (' + rows.length + ' rows)', stringify(rows)));

	element.appendChild(wrapper);
	// No cleanup needed — nao clears the container before the next render.
}
