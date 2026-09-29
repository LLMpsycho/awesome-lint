import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {remark} from 'remark';
import remarkLint from 'remark-lint';
import esmock from 'esmock';
import lint from '../_lint.js';
import headerImageRule from '../../rules/header-image.js';
import {createRules} from '../../rules/index.js';

const expectedMessage = line => ({
	line,
	ruleId: 'awesome-header-image',
	message: 'Header image must be SVG or high-DPI (at least 2× its display size)',
});

describe('rules › header-image', () => {
	const config = {
		plugins: [
			remarkLint,
			headerImageRule,
		],
	};

	for (const fixture of ['no-image', 'svg', 'hidpi-filenames', 'hidpi-html', 'badges', 'body-images', 'comments', 'unknown-size']) {
		it(`header-image - ${fixture}`, async () => {
			const messages = await lint({config, filename: `test/fixtures/header-image/${fixture}.md`});
			assert.deepEqual(messages, []);
		});
	}

	it('header-image - raster Markdown image', async () => {
		const messages = await lint({config, filename: 'test/fixtures/header-image/raster.md'});
		assert.deepEqual(messages, [expectedMessage(3)]);
	});

	it('header-image - raster reference image', async () => {
		const messages = await lint({config, filename: 'test/fixtures/header-image/reference.md'});
		assert.deepEqual(messages, [expectedMessage(3)]);
	});

	it('header-image - both raster dimensions must be at least twice the display size', async () => {
		const messages = await lint({config, filename: 'test/fixtures/header-image/raster-html.md'});
		assert.deepEqual(messages, [expectedMessage(2), expectedMessage(3)]);
	});

	it('header-image - registered as an error', () => {
		assert.deepEqual(createRules().find(([rule]) => rule === headerImageRule), [headerImageRule, ['error']]);
	});

	const processMarkdown = async (markdown, rule = headerImageRule) => remark()
		.use(remarkLint)
		.use(rule)
		.process({path: 'test/fixtures/header-image/readme.md', value: markdown});

	for (const markdown of [
		'![Logo](logo.png)\n\n# Awesome Example',
		'# Awesome Example ![Logo](logo.png)',
		'# Awesome Example <img src="logo.png" width="200" height="100">',
		'# Awesome Example\n\n<img src="logo.png" width="101">',
		'# Awesome Example\n\n<img src="logo.png" height="51">',
	]) {
		it(`header-image - detects ${markdown.split('\n').join(' ')}`, async () => {
			const file = await processMarkdown(markdown);
			assert.equal(file.messages.length, 1);
			assert.equal(file.messages[0].reason, expectedMessage(1).message);
		});
	}

	for (const markdown of [
		'# Awesome Example\n\n- ![Example](logo.png)',
		'# Awesome Example\n\n> ![Example](logo.png)',
		'# Awesome Example\n\n---\n\n![Example](logo.png)',
		'# Awesome Example\n\n```html\n<img src="logo.png">\n```',
		'# Awesome Example\n\n<!--\n<img src="logo.png">',
		'# Awesome Example\n\n<blockquote><img src="logo.png"></blockquote>',
		'<h1>Awesome Example</h1>\n<h2>Examples</h2>\n<img src="logo.png">',
		'<h1>Awesome Example</h1>\n<hr>\n<img src="logo.png">',
		'# Awesome Example ![Logo](logo.svg)\n\n![Screenshot](logo.png)',
		'<h1><img src="logo.svg"></h1>\n\nA curated list.\n\n![Screenshot](logo.png)',
		`# Awesome Example\n\n${'Example paragraph.\n\n'.repeat(10)}![Example](logo.png)`,
	]) {
		it(`header-image - ignores body content ${JSON.stringify(markdown)}`, async () => {
			const file = await processMarkdown(markdown);
			assert.deepEqual(file.messages, []);
		});
	}

	for (const src of ['logo.svg', 'logo.SVG?raw=true#logo', 'logo@2x.png', 'logo%402x.png', 'logo-2x.jpg', 'logo.2x.gif', 'logo2x.webp']) {
		it(`header-image - accepts ${src}`, async () => {
			const data = await readFile('test/fixtures/header-image/logo.png');
			const rule = await esmock('../../rules/header-image.js', {
				got: () => ({buffer: async () => data}),
			});
			const file = await processMarkdown(`# Awesome Example\n\n![Logo](https://example.com/${src})`, rule);
			assert.deepEqual(file.messages, []);
		});
	}

	it('header-image - HiDPI markers must be in the filename', async () => {
		const data = await readFile('test/fixtures/header-image/logo.png');
		const rule = await esmock('../../rules/header-image.js', {
			got: () => ({buffer: async () => data}),
		});
		const file = await processMarkdown('# Awesome Example\n\n![Logo](https://example.com/@2x/logo.png?scale=2x)', rule);
		assert.equal(file.messages.length, 1);
		assert.equal(file.messages[0].line, 3);
	});

	for (const attributes of [
		'width="100" height="50"',
		'width=100 height=50',
		'width="80" height="40"',
		'width="100"',
		'height="50"',
		'width="100" height="auto"',
		'width="200" height="100" style="width: 100px; height: 50px !important"',
		'srcset="logo.png 1x, logo-large.png 2x"',
	]) {
		it(`header-image - accepts HTML sizing ${attributes}`, async () => {
			const file = await processMarkdown(`# Awesome Example\n\n<img src="logo.png" ${attributes}>`);
			assert.deepEqual(file.messages, []);
		});
	}

	for (const width of [100, 101]) {
		it(`header-image - Markdown display width ${width} from rendering properties`, async () => {
			function displayDimensions() {
				return tree => {
					const image = tree.children[1].children[0];
					image.data = {hProperties: {width, height: 50}};
				};
			}

			const file = await remark().use(displayDimensions).use(config).process({
				path: 'test/fixtures/header-image/readme.md',
				value: '# Awesome Example\n\n![Logo](logo.png)',
			});
			assert.equal(file.messages.length, width === 100 ? 0 : 1);
		});
	}

	it('header-image - inline raster data', async () => {
		const data = await readFile('test/fixtures/header-image/logo.png');
		const src = `data:image/png;base64,${data.toString('base64')}`;
		const file = await processMarkdown(`# Awesome Example\n\n<img src="${src}" width="100" height="50">\n<img src="${src}" width="100" height="51">`);
		assert.equal(file.messages.length, 1);
		assert.equal(file.messages[0].line, 4);
	});

	it('header-image - image metadata determines the raster format', async () => {
		const src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
		const file = await processMarkdown(`# Awesome Example\n\n<img src="${src}" width="0.5" height="0.5">\n<img src="${src}" width="1" height="1">`);
		assert.equal(file.messages.length, 1);
		assert.equal(file.messages[0].line, 4);
	});

	it('header-image - remote raster dimensions and decoded HTML attributes', async () => {
		const data = await readFile('test/fixtures/header-image/logo.png');
		const requests = [];
		const rule = await esmock('../../rules/header-image.js', {
			got(url, options) {
				requests.push(url.href);
				assert.deepEqual(options, {timeout: {request: 5000}, retry: {limit: 0}});
				return {buffer: async () => data};
			},
		});

		const file = await processMarkdown('# Awesome Example\n\n<img src="//example.com/logo.png?a=1&amp;b=2" width="100" height="50">\n<img src="https://example.com/logo.png" width="101" height="50">', rule);
		assert.deepEqual(requests, ['https://example.com/logo.png?a=1&b=2', 'https://example.com/logo.png']);
		assert.equal(file.messages.length, 1);
		assert.equal(file.messages[0].line, 4);
	});

	it('header-image - does not download badges, SVGs, or HiDPI filenames', async () => {
		let requests = 0;
		const rule = await esmock('../../rules/header-image.js', {
			got() {
				requests++;
				throw new Error('Unexpected download');
			},
		});

		await Promise.all(['svg', 'hidpi-filenames', 'badges'].map(async fixture => {
			const markdown = await readFile(`test/fixtures/header-image/${fixture}.md`, 'utf8');
			const file = await processMarkdown(markdown, rule);
			assert.deepEqual(file.messages, []);
		}));

		assert.equal(requests, 0);
	});

	it('header-image - ignores unavailable or invalid image data', async () => {
		const rule = await esmock('../../rules/header-image.js', {
			got: url => ({
				async buffer() {
					if (url.pathname === '/unavailable.png') {
						throw new Error('Network unavailable');
					}

					return new TextEncoder().encode('Not an image');
				},
			}),
		});

		const file = await processMarkdown('# Awesome Example\n\n<img src="https://example.com/unavailable.png" width="100" height="50">\n<img src="https://example.com/invalid.png" width="100" height="50">', rule);
		assert.deepEqual(file.messages, []);
	});
});
