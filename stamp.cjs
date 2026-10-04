#!/usr/bin/env node
// #region stamp a site
// Prepares a static site for publishing with long-lived caching:
// - Copies the site into a staging folder, leaving out what is not part of the site.
// - Gives every served file a short hash of its own content, so a changed file gets a new address and an unchanged file keeps its old one.
// - Writes `cachebust.js`, which holds those hashes and `withCacheBust(path)`, for addresses a page builds while it runs.
// - Stamps every address a page, a stylesheet, or a web app manifest names with `?v=<hash>`.
// - Gives each page that runs module scripts an import map, so the modules those scripts import load stamped too.
// - Adds `_headers` rules that let browsers keep every stamped kind of file for a year.
// - Warns about a script that names a site file in a load without `withCacheBust`, since that address would carry no stamp.
// Reads its settings from environment variables (see the settings region), and uses only Node's own modules.
// #endregion




// #region dependencies
const {createHash}
	= require('node:crypto');
const {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync}
	= require('node:fs');
const {dirname, join, posix}
	= require('node:path');
// #endregion




// #region settings
// - The folder that holds the site, as given to the action.
const SITE_FOLDER
	= process.env.SITE_FOLDER || '.';

// - The folder the stamped copy is written to, which is what gets published.
const STAGE_FOLDER
	= process.env.STAGE_FOLDER;

// - The commit being deployed. It stamps any file that has no hash of its own.
const COMMIT
	= (process.env.COMMIT || 'local').slice(0, 10);

// - Paths in the site folder that are not part of the site, one per line.
const EXCLUDED_PATHS
	= listFromLines(process.env.EXCLUDE);

// - Files that are published to a storage bucket instead of with the site, one per line. They are still hashed, so their addresses carry stamps.
const BUCKET_FILES
	= listFromLines(process.env.BUCKET_FILES);

// - How long a browser may keep a stamped file: one year, in seconds.
const STAMPED_FILE_LIFETIME_SECONDS
	= 31536000;

// - Names Cloudflare Pages reads as settings rather than serving as files, so they carry no stamp.
const PAGES_SETTINGS_FILES
	= ['_headers', '_redirects', '_routes.json', '_worker.js'];

// - The file this script writes into the staged site for the pages to load.
const RUNTIME_FILE
	= 'cachebust.js';

// - Script calls that load a file from an address, for the bare-address warning.
const LOADING_CALL_PATTERN
	= /new Audio\(|new Image\(|\.src\s*=|fetch\(|import\(|src=|href=/;
// #endregion




// #region helpers
// Splits a multi-line setting into its trimmed, non-empty lines, with forward slashes and no leading "./" or "/".
function listFromLines(text)
{
	return (text || '')
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/\\/g, '/').replace(/^\.?\//, ''))
		.filter((line) => line !== '');
}

// Gives a short hash of one file's content. The same content always gives the same hash.
function hashOfFile(path)
{
	return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 10);
}

// Tells whether a site path is left out of the published copy.
// - Names that start with "." are never part of a site, such as `.git`, `.github`, and `.gitignore`.
function isExcluded(sitePath)
{
	const firstSegment
		= sitePath.split('/')[0];

	if (firstSegment.startsWith('.'))
	{
		return true;
	}

	return EXCLUDED_PATHS.some((excluded) => sitePath === excluded || sitePath.startsWith(excluded + '/'))
		|| BUCKET_FILES.includes(sitePath);
}

// Lists every file under a folder, as site paths with forward slashes, such as "sprites/banana.png".
function listFiles(folder, prefix = '')
{
	return readdirSync(folder, {withFileTypes: true}).flatMap((entry) =>
	{
		const sitePath
			= prefix ? `${prefix}/${entry.name}` : entry.name;

		return entry.isDirectory()
			? listFiles(join(folder, entry.name), sitePath)
			: [sitePath];
	});
}

// Turns an address written in a file into the site path it names, or nothing when it names no local file.
// - `fromFile` is the site path of the file the address is written in, so a relative address resolves from that file's folder.
function sitePathOf(address, fromFile)
{
	if (address === '' || /^[a-z][a-z0-9+.-]*:/i.test(address) || address.startsWith('//') || address.startsWith('#') || /[${}<>]/.test(address))
	{
		return undefined;
	}

	const pathPart
		= address.split(/[?#]/)[0];

	let decodedPath;
	try
	{
		decodedPath
			= decodeURIComponent(pathPart);
	}
	catch
	{
		return undefined;
	}

	const resolved
		= decodedPath.startsWith('/')
			? posix.normalize(decodedPath).slice(1)
			: posix.normalize(posix.join(posix.dirname(fromFile), decodedPath));

	// - A folder address, such as "/" or "about/", names a page rather than a file.
	if (resolved.startsWith('..') || resolved === '' || resolved === '.' || resolved.endsWith('/'))
	{
		return undefined;
	}

	return resolved;
}

// Gives an address with its stamp, keeping any part after "#".
function stampedAddress(address, hash)
{
	const [beforeHash, ...afterHash]
		= address.split('#');

	const withoutStamp
		= beforeHash.replace(/([?&])v=[^&]*(&|$)/, (match, before, after) => (after === '&' ? before : '')).replace(/[?&]$/, '');

	const joiner
		= withoutStamp.includes('?') ? '&' : '?';

	return withoutStamp + joiner + 'v=' + hash + (afterHash.length > 0 ? '#' + afterHash.join('#') : '');
}
// #endregion




// #region stamping
if (!STAGE_FOLDER)
{
	throw new Error('STAGE_FOLDER is not set.');
}

const siteFolder
	= SITE_FOLDER;

const stageFolder
	= STAGE_FOLDER;

// - The staged copy starts empty, so nothing from an earlier run rides along.
rmSync(stageFolder, {recursive: true, force: true});
mkdirSync(stageFolder, {recursive: true});

const stageFolderName
	= posix.normalize(stageFolder.replace(/\\/g, '/')).split('/').pop();

const servedPaths
	= listFiles(siteFolder).filter((sitePath) => !isExcluded(sitePath) && sitePath.split('/')[0] !== stageFolderName);

for (const sitePath of servedPaths)
{
	mkdirSync(dirname(join(stageFolder, sitePath)), {recursive: true});
	copyFileSync(join(siteFolder, sitePath), join(stageFolder, sitePath));
}

// - The site's own stand-in `cachebust.js`, for local runs, is replaced by the real one below.
const pagePaths
	= servedPaths.filter((sitePath) => sitePath.endsWith('.html'));

const manifestPaths
	= servedPaths.filter((sitePath) => sitePath.endsWith('.webmanifest') || posix.basename(sitePath) === 'manifest.json');

const stylesheetPaths
	= servedPaths.filter((sitePath) => sitePath.endsWith('.css'));

const fileHashes
	= {};

let stampedReferenceCount
	= 0;

const warnings
	= [];

// Hashes one served file as it stands in the staged copy, or in the site folder for a bucket file.
function hashSitePath(sitePath)
{
	const stagedPath
		= join(stageFolder, sitePath);

	fileHashes[sitePath]
		= hashOfFile(existsSync(stagedPath) ? stagedPath : join(siteFolder, sitePath));
}

// Every file whose address can carry a stamp: everything served except pages, Pages settings files, and the runtime file.
const stampableHashedPaths
	= [...servedPaths, ...BUCKET_FILES]
		.filter((sitePath) => !sitePath.endsWith('.html') && !PAGES_SETTINGS_FILES.includes(sitePath) && sitePath !== RUNTIME_FILE);

// Rewrites one staged text file, stamping each address a pattern finds.
// - `findAddresses` gives back the text with each address replaced through the `stamp` callback.
function stampFile(sitePath, findAddresses)
{
	const stagedPath
		= join(stageFolder, sitePath);

	const text
		= readFileSync(stagedPath, 'utf8');

	const stampedText
		= findAddresses(text, (address) =>
		{
			const target
				= sitePathOf(address, sitePath);

			if (target === undefined || target.endsWith('.html') || PAGES_SETTINGS_FILES.includes(target))
			{
				return address;
			}
			if (fileHashes[target] === undefined)
			{
				if (!servedPaths.includes(target) && !BUCKET_FILES.includes(target) && target !== RUNTIME_FILE)
				{
					warnings.push(`${sitePath} names ${address}, which is not a file of the site.`);
				}
				return address;
			}

			stampedReferenceCount++;
			return stampedAddress(address, fileHashes[target]);
		});

	writeFileSync(stagedPath, stampedText);
}

// 1. Manifests and stylesheets name other files, so they are stamped before their own hashes are taken.
for (const sitePath of stampableHashedPaths.filter((path) => !manifestPaths.includes(path) && !stylesheetPaths.includes(path)))
{
	hashSitePath(sitePath);
}

for (const sitePath of manifestPaths)
{
	stampFile(sitePath, (text, stamp) => text.replace(/("src"\s*:\s*")([^"]+)(")/g, (match, before, address, after) => before + stamp(address) + after));
	hashSitePath(sitePath);
}

for (const sitePath of stylesheetPaths)
{
	stampFile(sitePath, (text, stamp) => text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, address) => `url(${quote}${stamp(address)}${quote})`));
	hashSitePath(sitePath);
}

// 2. The runtime file holds the table, so it is written once every other file has its hash.
const runtimeTemplate
	= readFileSync(join(__dirname, 'cachebust-runtime.js'), 'utf8');

writeFileSync
(
	join(stageFolder, RUNTIME_FILE),
	`var CACHE_BUST = ${JSON.stringify(COMMIT)};\nvar FILE_HASHES = ${JSON.stringify(fileHashes)};\n${runtimeTemplate}`,
);

fileHashes[RUNTIME_FILE]
	= hashOfFile(join(stageFolder, RUNTIME_FILE));

// 3. Pages are stamped last, since they name everything else, the runtime file included.
for (const sitePath of pagePaths)
{
	stampFile(sitePath, (text, stamp) => text
		.replace(/\b(src|href|poster)=(["'])([^"']*)\2/g, (match, attribute, quote, address) => `${attribute}=${quote}${stamp(address)}${quote}`)
		.replace(/<meta\b[^>]*>/gi, (tag) =>
		{
			if (!/(property|name)=["'](og:image|twitter:image)["']/i.test(tag))
			{
				return tag;
			}

			return tag.replace(/\bcontent=(["'])(https?:\/\/[^/"']+)(\/[^"']*)\1/i, (match, quote, origin, address) => `content=${quote}${origin}${stamp(address)}${quote}`);
		}));

	addModuleImportMap(sitePath);
}

// Gives a page that runs module scripts an import map, which points every script the site serves at its stamped address.
// - A module names the modules it imports inside its own code, such as `import {x} from './y.js'`, where no page attribute carries a stamp.
// - The browser looks each imported address up in the page's import map, so every import loads the stamped file, and a module the page also loads by its stamped `src` stays one module.
// - The map goes just before the page's first module script, since the browser reads an import map only before any module starts loading.
// - A page that already has an import map keeps its own, with a warning, since the browser takes the first map it meets.
function addModuleImportMap(sitePath)
{
	const stagedPath
		= join(stageFolder, sitePath);

	const text
		= readFileSync(stagedPath, 'utf8');

	const firstModuleScript
		= text.search(/<script\b[^>]*\btype=["']module["']/i);

	if (firstModuleScript === -1)
	{
		return;
	}
	if (/<script\b[^>]*\btype=["']importmap["']/i.test(text))
	{
		warnings.push(`${sitePath} has an import map of its own, so the modules it imports carry no stamps.`);
		return;
	}

	// - Each key is a script's address from the site's root, and each value is that address with its stamp.
	const imports
		= {};

	for (const [scriptPath, hash] of Object.entries(fileHashes).filter(([path]) => path.endsWith('.js') || path.endsWith('.mjs')))
	{
		const address
			= '/' + scriptPath.split('/').map(encodeURIComponent).join('/');

		imports[address]
			= stampedAddress(address, hash);
	}

	// - The map takes the module script's own line and indentation, and the module script moves to the next line.
	const lineStart
		= text.lastIndexOf('\n', firstModuleScript) + 1;

	const leadingText
		= text.slice(lineStart, firstModuleScript);

	const indentation
		= /^[ \t]*$/.test(leadingText) ? leadingText : '';

	const importMap
		= `<script type="importmap">${JSON.stringify({imports})}</script>\n${indentation}`;

	writeFileSync(stagedPath, text.slice(0, firstModuleScript) + importMap + text.slice(firstModuleScript));
}

// 4. Cache lifetimes for every stamped kind of file, after any rules the site wrote itself.
const stampedExtensions
	= [...new Set(Object.keys(fileHashes).map((sitePath) => posix.extname(sitePath).toLowerCase()).filter((extension) => extension !== ''))].sort();

const headersPath
	= join(stageFolder, '_headers');

const siteHeaders
	= existsSync(headersPath) ? readFileSync(headersPath, 'utf8').trimEnd() + '\n\n' : '';

const stampedHeaders
	= stampedExtensions.map((extension) => `/*${extension}\n  Cache-Control: public, max-age=${STAMPED_FILE_LIFETIME_SECONDS}, immutable`).join('\n\n');

writeFileSync(headersPath, `${siteHeaders}# Stamped files: every address carries ?v=<hash of the file>, so each one can be kept for a year.\n${stampedHeaders}\n`);

// 5. Scripts that load a site file by a bare address would load it without its stamp.
for (const sitePath of servedPaths.filter((path) => path.endsWith('.js') || path.endsWith('.html')))
{
	const lines
		= readFileSync(join(siteFolder, sitePath), 'utf8').split(/\r?\n/);

	lines.forEach((line, index) =>
	{
		if (!LOADING_CALL_PATTERN.test(line) || line.includes('withCacheBust('))
		{
			return;
		}

		for (const [, address] of line.matchAll(/['"`]([^'"`\s]+\.[a-z0-9]{2,5})['"`]/gi))
		{
			const target
				= sitePathOf(address, sitePath);

			// - An HTML attribute such as `src="..."` is stamped above, so only addresses in script code are bare.
			const isMarkupAttribute
				= new RegExp(`(src|href|poster)=["']${address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(line);

			if (target !== undefined && fileHashes[target] !== undefined && !isMarkupAttribute)
			{
				warnings.push(`${sitePath}:${index + 1} loads ${address} without withCacheBust, so its address carries no stamp.`);
			}
		}
	});
}
// #endregion




// #region report
console.log(`Stamped ${Object.keys(fileHashes).length} files and ${stampedReferenceCount} references with commit ${COMMIT}.`);
for (const warning of warnings)
{
	console.log(`::warning::${warning}`);
}
// #endregion