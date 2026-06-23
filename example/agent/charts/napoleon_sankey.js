/**
 * Custom chart plugin: a d3 Sankey (flow) diagram.
 *
 * Renders flows between nodes using `d3` + `d3-sankey`, both pulled from a CDN
 * as ES modules (no bundler at runtime). Map your data with the standard tool
 * inputs:
 *   - config.xAxisKey   -> source column
 *   - config.series[0]  -> target column
 *   - config.series[1]  -> value column (flow magnitude)
 *
 * With no matching data it falls back to the canonical example of a Sankey-style
 * flow: Charles Minard's 1812 Russian campaign, where Napoleon's Grande Armée
 * dwindles stage by stage and the losses peel off in red.
 */

export const meta = {
	name: 'Napoleon Sankey',
	description:
		'Sankey / flow diagram showing how quantities split and flow between stages. Pass the source column as x_axis_key, the target column as the first series, and the value column as the second series. With no matching data it illustrates Napoleon\'s 1812 Russian campaign (Minard).',
};

// Charles Minard's 1812 campaign as a directed acyclic flow. Each stage keeps
// a "survivors" spine moving right while a red branch peels off the losses.
// Troop counts are conserved at every node (in == out).
const NAPOLEON_1812 = {
	nodes: [
		{ name: 'Niemen — 422,000' },
		{ name: 'Vilnius — 400,000' },
		{ name: 'Smolensk — 145,000' },
		{ name: 'Moscow — 100,000' },
		{ name: 'Smolensk (retreat) — 37,000' },
		{ name: 'Berezina — 28,000' },
		{ name: 'Survivors — 10,000' },
		{ name: 'Lost: advance to Vilnius' },
		{ name: 'Lost: advance to Smolensk' },
		{ name: 'Lost: advance to Moscow' },
		{ name: 'Lost: retreat to Smolensk' },
		{ name: 'Lost: march to Berezina' },
		{ name: 'Lost: Berezina crossing' },
	],
	links: [
		{ source: 'Niemen — 422,000', target: 'Vilnius — 400,000', value: 400000 },
		{ source: 'Niemen — 422,000', target: 'Lost: advance to Vilnius', value: 22000 },
		{ source: 'Vilnius — 400,000', target: 'Smolensk — 145,000', value: 145000 },
		{ source: 'Vilnius — 400,000', target: 'Lost: advance to Smolensk', value: 255000 },
		{ source: 'Smolensk — 145,000', target: 'Moscow — 100,000', value: 100000 },
		{ source: 'Smolensk — 145,000', target: 'Lost: advance to Moscow', value: 45000 },
		{ source: 'Moscow — 100,000', target: 'Smolensk (retreat) — 37,000', value: 37000 },
		{ source: 'Moscow — 100,000', target: 'Lost: retreat to Smolensk', value: 63000 },
		{ source: 'Smolensk (retreat) — 37,000', target: 'Berezina — 28,000', value: 28000 },
		{ source: 'Smolensk (retreat) — 37,000', target: 'Lost: march to Berezina', value: 9000 },
		{ source: 'Berezina — 28,000', target: 'Survivors — 10,000', value: 10000 },
		{ source: 'Berezina — 28,000', target: 'Lost: Berezina crossing', value: 18000 },
	],
};

export async function render(element, ctx) {
	const { config, theme, colors } = ctx;
	const [d3, d3Sankey] = await Promise.all([
		import('https://esm.sh/d3@7'),
		import('https://esm.sh/d3-sankey@0.12.3'),
	]);

	const graph = buildGraph(ctx);
	const isDark = theme === 'dark';
	const textColor = isDark ? '#e5e7eb' : '#1f2937';
	const mutedColor = isDark ? '#9ca3af' : '#6b7280';
	const strokeColor = isDark ? '#111827' : '#ffffff';
	const survivorColor = '#c89b3c';
	const lossColor = isDark ? '#e06b60' : '#c0392b';
	const title = (config && config.title) || (graph.custom ? '' : "Napoleon's 1812 Russian Campaign");

	const isLoss = (name) => String(name || '').startsWith('Lost');
	const nodeColor = (node) =>
		graph.custom ? colors[node.index % colors.length] : isLoss(node.name) ? lossColor : survivorColor;
	const linkColor = (link) =>
		graph.custom ? colors[link.source.index % colors.length] : isLoss(link.target.name) ? lossColor : survivorColor;

	const format = (value) => Number(value).toLocaleString();

	let lastWidth = 0;
	let lastHeight = 0;

	function draw() {
		const width = Math.max(360, Math.floor(element.clientWidth) || 800);
		const height = Math.max(280, Math.floor(element.clientHeight) || 500);
		lastWidth = width;
		lastHeight = height;

		element.replaceChildren();

		const margin = { top: title ? 34 : 14, right: 12, bottom: 22, left: 12 };

		const svg = d3
			.select(element)
			.append('svg')
			.attr('width', width)
			.attr('height', height)
			.attr('viewBox', `0 0 ${width} ${height}`)
			.style('display', 'block')
			.style('width', '100%')
			.style('height', '100%')
			.style('font-family', 'ui-sans-serif, system-ui, -apple-system, sans-serif');

		if (title) {
			svg
				.append('text')
				.attr('x', width / 2)
				.attr('y', 20)
				.attr('text-anchor', 'middle')
				.style('font-size', '14px')
				.style('font-weight', '600')
				.style('fill', textColor)
				.text(title);
		}

		const layout = d3Sankey
			.sankey()
			.nodeId((d) => d.name)
			.nodeAlign(d3Sankey.sankeyLeft)
			.nodeSort(null)
			.nodeWidth(14)
			.nodePadding(16)
			.extent([
				[margin.left, margin.top],
				[width - margin.right, height - margin.bottom],
			]);

		const { nodes, links } = layout({
			nodes: graph.nodes.map((d) => ({ ...d })),
			links: graph.links.map((d) => ({ ...d })),
		});

		svg
			.append('g')
			.attr('fill', 'none')
			.selectAll('path')
			.data(links)
			.join('path')
			.attr('d', d3Sankey.sankeyLinkHorizontal())
			.attr('stroke', (d) => linkColor(d))
			.attr('stroke-width', (d) => Math.max(1, d.width))
			.attr('stroke-opacity', 0.45)
			.style('transition', 'stroke-opacity 0.15s ease')
			.on('mouseover', function () {
				d3.select(this).attr('stroke-opacity', 0.75);
			})
			.on('mouseout', function () {
				d3.select(this).attr('stroke-opacity', 0.45);
			})
			.append('title')
			.text((d) => `${d.source.name} → ${d.target.name}\n${format(d.value)}`);

		const node = svg.append('g').selectAll('g').data(nodes).join('g');

		node
			.append('rect')
			.attr('x', (d) => d.x0)
			.attr('y', (d) => d.y0)
			.attr('width', (d) => Math.max(1, d.x1 - d.x0))
			.attr('height', (d) => Math.max(1, d.y1 - d.y0))
			.attr('rx', 2)
			.attr('fill', (d) => nodeColor(d))
			.attr('stroke', strokeColor)
			.attr('stroke-width', 0.75)
			.append('title')
			.text((d) => `${d.name}\n${format(d.value)}`);

		node
			.append('text')
			.attr('x', (d) => (d.x0 < width / 2 ? d.x1 + 6 : d.x0 - 6))
			.attr('y', (d) => (d.y0 + d.y1) / 2)
			.attr('dy', '0.35em')
			.attr('text-anchor', (d) => (d.x0 < width / 2 ? 'start' : 'end'))
			.style('font-size', '11px')
			.style('fill', textColor)
			.style('paint-order', 'stroke')
			.style('stroke', strokeColor)
			.style('stroke-width', '3px')
			.style('stroke-linejoin', 'round')
			.text((d) => d.name);

		if (!graph.custom) {
			svg
				.append('text')
				.attr('x', width / 2)
				.attr('y', height - 6)
				.attr('text-anchor', 'middle')
				.style('font-size', '10px')
				.style('fill', mutedColor)
				.text('After Charles Minard (1869) — troop strength of the Grande Armée');
		}
	}

	draw();

	let frame = 0;
	const observer = new ResizeObserver(() => {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(() => {
			if (element.clientWidth === lastWidth && element.clientHeight === lastHeight) {
				return;
			}
			draw();
		});
	});
	observer.observe(element);

	return () => {
		observer.disconnect();
		cancelAnimationFrame(frame);
		element.replaceChildren();
	};
}

/**
 * Builds the Sankey graph from the agent-provided data when source/target/value
 * columns are configured, otherwise falls back to the Napoleon 1812 dataset.
 */
function buildGraph(ctx) {
	const { config, data } = ctx;
	const sourceKey = config && config.xAxisKey;
	const targetKey = config && config.series && config.series[0] && config.series[0].data_key;
	const valueKey = config && config.series && config.series[1] && config.series[1].data_key;

	const rows = Array.isArray(data) ? data : [];
	const usable =
		sourceKey &&
		targetKey &&
		valueKey &&
		rows.some((row) => row[sourceKey] != null && row[targetKey] != null && Number(row[valueKey]) > 0);

	if (!usable) {
		return {
			custom: false,
			nodes: NAPOLEON_1812.nodes.map((d) => ({ ...d })),
			links: NAPOLEON_1812.links.map((d) => ({ ...d })),
		};
	}

	const names = new Set();
	const links = [];
	for (const row of rows) {
		const source = row[sourceKey];
		const target = row[targetKey];
		const value = Number(row[valueKey]);
		if (source == null || target == null || !(value > 0) || source === target) {
			continue;
		}
		names.add(String(source));
		names.add(String(target));
		links.push({ source: String(source), target: String(target), value });
	}

	return {
		custom: true,
		nodes: [...names].map((name) => ({ name })),
		links,
	};
}
