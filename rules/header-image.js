import {Buffer} from 'node:buffer';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import got from 'got';
import {imageDimensionsFromData} from 'image-dimensions';
import {parseEntities} from 'parse-entities';
import {lintRule} from 'unified-lint-rule';
import {visit, EXIT, SKIP} from 'unist-util-visit';

const message = 'Header image must be SVG or high-DPI (at least 2× its display size)';

const isBadge = url => url.hostname === 'shields.io'
	|| url.hostname.endsWith('.shields.io')
	|| /\/badges?(?:[./_-]|$)/i.test(url.pathname);

const pixelSize = value => {
	const text = String(value ?? '').trim();
	return /^\d+(?:\.\d+)?(?:px)?$/i.test(text) && Number.parseFloat(text) > 0
		? Number.parseFloat(text)
		: undefined;
};

const displaySize = properties => {
	const dimensions = {width: properties.width, height: properties.height};

	for (const match of (properties.style ?? '').matchAll(/(?:^|;)\s*(width|height)\s*:\s*([^;]+)/gi)) {
		dimensions[match[1].toLowerCase()] = match[2].trim().replace(/\s*!important$/i, '');
	}

	return {
		width: pixelSize(dimensions.width),
		height: pixelSize(dimensions.height),
		unknownSize: Object.values(dimensions).some(value => value !== undefined && value !== 'auto' && !pixelSize(value)),
		highDpi: [...(properties.srcset ?? properties.srcSet ?? '').matchAll(/(?:^|,)\s*\S+\s+(\d+(?:\.\d+)?)x\s*(?=,|$)/gi)]
			.some(match => Number(match[1]) >= 2),
	};
};

const readDimensions = async url => {
	try {
		let data;
		switch (url.protocol) {
			case 'file:': {
				data = await readFile(fileURLToPath(url));
				break;
			}

			case 'https:':
			case 'http:': {
				data = await got(url, {timeout: {request: 5000}, retry: {limit: 0}}).buffer();
				break;
			}

			case 'data:': {
				const match = url.href.match(/^data:image\/[^;,]+;base64,([\s\S]+)$/i);
				if (match) {
					data = Buffer.from(match[1], 'base64');
				}

				break;
			}

			default:
		}

		return data && imageDimensionsFromData(data);
	} catch {
		// Missing, unsupported, or unavailable images do not establish a resolution violation.
	}
};

function * htmlElements(node) {
	// Skip comments and code samples, and allow quotes (including `>`) in attributes.
	const tags = /<!--[\s\S]*?(?:-->|$)|<(pre|code|script|style|blockquote)\b[^>]*>[\s\S]*?<\/\1\s*>|<(img|h[1-6]|hr|ul|ol|table)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
	for (const match of node.value.matchAll(tags)) {
		const tag = match[2]?.toLowerCase();
		if (!tag) {
			continue;
		}

		const properties = {};
		for (const attribute of match[0].matchAll(/\s+([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
			properties[attribute[1].toLowerCase()] = parseEntities(attribute[2] ?? attribute[3] ?? attribute[4], {attribute: true});
		}

		const lines = node.value.slice(0, match.index).split('\n');
		yield {
			tag,
			src: properties.src,
			...displaySize(properties),
			position: {
				line: node.position.start.line + lines.length - 1,
				column: lines.at(-1).length + (lines.length === 1 ? node.position.start.column : 1),
			},
		};
	}
}

const headerImageRule = lintRule('remark-lint:awesome-header-image', async (ast, file) => {
	const base = pathToFileURL(file.path ?? path.join(file.cwd, 'readme.md'));
	const definitions = new Map();
	visit(ast, 'definition', node => {
		if (!definitions.has(node.identifier)) {
			definitions.set(node.identifier, node.url);
		}
	});

	const images = [];
	let hasHeading = false;
	const addImage = image => {
		if (!image.src) {
			return;
		}

		try {
			const url = new URL(image.src.startsWith('//') ? `https:${image.src}` : image.src, base);
			if (!isBadge(url)) {
				images.push({...image, url});
			}
		} catch {
			// Ignore invalid image URLs.
		}
	};

	visit(ast, (node, index, parent) => {
		// Restrict header detection to the first 20 lines and stop at body content.
		if (node.position?.start.line > 20) {
			return EXIT;
		}

		if (parent === ast) {
			// Later image blocks can be screenshots or sponsor logos, rather than the header.
			if (images.length > 0) {
				return EXIT;
			}

			if (['definition', 'blockquote'].includes(node.type)) {
				return SKIP;
			}

			// Only inspect the introduction, before sections, lists, tables, and examples.
			if (node.type === 'heading') {
				if (node.depth !== 1 || hasHeading) {
					return EXIT;
				}

				hasHeading = true;
			} else if (!['paragraph', 'html'].includes(node.type)) {
				return EXIT;
			}
		}

		if (['image', 'imageReference'].includes(node.type)) {
			addImage({
				src: node.url ?? definitions.get(node.identifier),
				...displaySize(node.data?.hProperties ?? {}),
				position: node.position.start,
			});
		} else if (node.type === 'html') {
			for (const image of htmlElements(node)) {
				if (image.position.line > 20) {
					return EXIT;
				}

				if (image.tag !== 'img') {
					if (image.tag !== 'h1' || hasHeading) {
						return EXIT;
					}

					hasHeading = true;
					continue;
				}

				addImage(image);
			}
		}
	});

	const invalidImages = await Promise.all(images.map(async image => {
		if (image.unknownSize || image.highDpi) {
			return;
		}

		const {url} = image;
		try {
			const filename = path.posix.basename(decodeURIComponent(url.pathname));
			if (/\.svg$/i.test(filename) || /^data:image\/svg\+xml[;,]/i.test(image.src) || /(?:^|\D)2x(?=[._-]|$)/i.test(filename)) {
				return;
			}
		} catch {
			return;
		}

		const dimensions = await readDimensions(url);
		if (!dimensions) {
			return;
		}

		// A single display dimension preserves the aspect ratio. Without sizing, Markdown
		// and HTML render at the image's intrinsic size.
		const width = image.width ?? (image.height ? image.height * dimensions.width / dimensions.height : dimensions.width);
		const height = image.height ?? (image.width ? image.width * dimensions.height / dimensions.width : dimensions.height);
		if (dimensions.width < width * 2 || dimensions.height < height * 2) {
			return image;
		}
	}));

	for (const image of invalidImages) {
		if (image) {
			file.message(message, image.position);
		}
	}
});

export default headerImageRule;
