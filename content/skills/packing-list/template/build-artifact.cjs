// Builds the single-page Claude artifact from index.html: inline CSS and JS, photos as data URIs (the artifact cannot
// load files next to it), Google Fonts instead of the local ones, and no print button (the artifact frame cannot print).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = __dirname;
const output = path.join(source, 'dist', 'packing-list.html');
const read = (name) => fs.readFileSync(path.join(source, name), 'utf8');

const sandbox = { window: {} };
vm.runInNewContext(read('packing-data.js'), sandbox);
const trip = sandbox.window.PACKING_TRIP;

// Every photo is embedded, including those of items added on the page, which packing-data.js does not list.
const imagesDirectory = path.join(source, 'images');
const photos = {};
for (const file of fs.existsSync(imagesDirectory) ? fs.readdirSync(imagesDirectory) : []) {
	if (file.endsWith('.webp')) photos[path.basename(file, '.webp')] = `data:image/webp;base64,${fs.readFileSync(path.join(imagesDirectory, file)).toString('base64')}`;
}
const missingPhotos = trip.categories.flatMap((category) => category.items).map((item) => item.id).filter((id) => !photos[id]);

const markup = read('index.html').match(/<div data-app><\/div>/)[0];
// A closing script tag inside the code would end the inline script early.
const inlineScript = (code) => `<script>\n${code.replace(/<\/script/gi, '<\\/script')}</script>`;
const scripts = [`window.PACKING_ARTIFACT = true;\nwindow.PACKING_PHOTOS = ${JSON.stringify(photos)};\n`, read('packing-data.js'), read('packing-app.js')]
	.map(inlineScript)
	.join('\n');
const title = trip.pageTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const page = `<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DynaPuff:wght@400..700&family=Geist:wght@400..700&display=swap">
<style>
${read('packing-list.css')}
</style>
${inlineScript(read('packing-theme.js'))}
${markup}
${scripts}
`;

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, page);
console.log(`${output} ${Math.round(page.length / 1024)} KB`);
if (missingPhotos.length) console.log(`No photo (emoji shown): ${missingPhotos.join(', ')}`);
