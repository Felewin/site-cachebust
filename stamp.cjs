#!/usr/bin/env node
// #region stamp a site
// Prepares a static site for publishing with long-lived caching:
// - Copies the site into a staging folder, leaving out what is not part of the site.
// - Gives every served file a short hash of its own content, and a version: the folder its copy is published under, as `/_v/<version>/<path>`.
// - A file keeps the version it has on the live site for as long as its content is unchanged, so a browser keeps its copy across deploys; a changed file takes this deploy's version.
// - Writes `cachebust.js`, which holds those hashes and versions and `withCacheBust(path)`, for addresses a page builds while it runs.
// - Points every address a page, a stylesheet, or a web app manifest names at its versioned copy.
// - Gives each page that runs module scripts an import map, so the modules those scripts import load versioned too.
// - Adds one `_headers` rule for each version folder, letting browsers keep everything in it for a year.
// - Warns about a script that names a site file in a load without `withCacheBust`, since that address would carry no version.
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

// - The commit being deployed. It is the version of every file this deploy changes, and stamps any file that has no hash of its own.
const COMMIT
	= (process.env.COMMIT || 'local').slice(0, 10);

// - The live site's own `cachebust.js`, fetched before stamping, which names each file's hash and version on the live site. When it is missing, every file takes this deploy's version.
const LIVE_RUNTIME_FILE
	= process.env.LIVE_RUNTIME_FILE || '';

// - Paths in the site folder that are not part of the site, one per line.
const EXCLUDED_PATHS
	= listFromLines(process.env.EXCLUDE);

// - Files that are published to a storage bucket instead of with the site, one per line. They are still hashed, so their addresses carry `?v=<hash>` stamps, and the site's own worker serves them at their plain addresses.
const BUCKET_FILES
	= listFromLines(process.env.BUCKET_FILES);

// - The folder each versioned copy is published under, as `/_v/<version>/<path>`.
const VERSION_FOLDER
	= '_v';

// - The most `_headers` rules Cloudflare Pages takes; the version folders share them with the site's own rules.
const HEADER_RULE_LIMIT
	= 100;

// - How long a browser may keep a versioned file: one year, in seconds.
const STAMPED_FILE_LIFETIME_SECONDS
	= 31536000;

// - How long Cloudflare's own edge may keep a versioned file: five minutes, in seconds, so any copy the edge takes in a deploy's first seconds heals on its own.
const STAMPED_FILE_EDGE_LIFETIME_SECONDS
	= 300;

// - Names Cloudflare Pages reads as settings rather than serving as files, so they carry no version.
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

// Splits an address into its path, its query without any old `v=` stamp, and its part after "#", each without its leading mark.
function partsOfAddress(address)
{
	const [beforeHash, ...afterHash]
		= address.split('#');

	const [path, ...queryParts]
		= beforeHash.split('?');

	const query
		= queryParts.join('?').split('&').filter((part) => part !== '' && !part.startsWith('v=')).join('&');

	return {path, query, fragment: afterHash.join('#')};
}

// Gives an address with a `?v=<hash>` stamp, keeping the rest of its query and any part after "#", for a file the site's worker serves from its bucket.
function stampedAddress(address, hash)
{
	const {path, query, fragment}
		= partsOfAddress(address);

	return `${path}?${query ? query + '&' : ''}v=${hash}${fragment ? '#' + fragment : ''}`;
}

// Gives a site path as an address from the site's root, each folder and name encoded the way a browser asks for it.
function rootAddressOf(sitePath)
{
	return '/' + sitePath.split('/').map(encodeURIComponent).join('/');
}

// Gives the address of a file's versioned copy, `/_v/<version>/<path>`, keeping the rest of the written address's query and any part after "#".
function versionedAddress(sitePath, version, address = '')
{
	const {query, fragment}
		= partsOfAddress(address);

	return `/${VERSION_FOLDER}/${version}${rootAddressOf(sitePath)}${query ? '?' + query : ''}${fragment ? '#' + fragment : ''}`;
}

// Reads one table the live site's `cachebust.js` holds, such as `FILE_VERSIONS`, or `empty` when the live site has none.
function readLiveTable(name, empty)
{
	if (LIVE_RUNTIME_FILE === '' || !existsSync(LIVE_RUNTIME_FILE))
	{
		return empty;
	}

	const line
		= readFileSync(LIVE_RUNTIME_FILE, 'utf8').match(new RegExp(`^var ${name} = (.*);$`, 'm'));

	try
	{
		return line ? JSON.parse(line[1]) : empty;
	}
	catch
	{
		return empty;
	}
}

// Counts the rules a `_headers` file holds: each line that starts a path, rather than a header beneath one or a comment.
function countHeaderRules(text)
{
	return text.split(/\r?\n/).filter((line) => /^\S/.test(line) && !line.startsWith('#')).length;
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

if (servedPaths.some((sitePath) => sitePath.split('/')[0] === VERSION_FOLDER))
{
	throw new Error(`The site holds a folder named ${VERSION_FOLDER}, which the versioned copies are published under.`);
}

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

const isScript
	= (sitePath) => sitePath.endsWith('.js') || sitePath.endsWith('.mjs');

const fileHashes
	= {};

const fileVersions
	= {};

const liveHashes
	= readLiveTable('FILE_HASHES', {});

// - A version read from the live site becomes a folder name, so only a plain name of letters and digits is taken, such as a commit's short hash.
const isVersionName
	= (value) => typeof value === 'string' && /^[0-9a-z]{1,40}$/i.test(value);

const liveVersions
	= Object.fromEntries(Object.entries(readLiveTable('FILE_VERSIONS', {})).filter(([, version]) => isVersionName(version)));

const liveVersionOrder
	= [].concat(readLiveTable('VERSION_ORDER', [])).filter(isVersionName);

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

// The version a file keeps from the live site while its content is unchanged, or this deploy's version.
function keptVersionOf(sitePath)
{
	const liveVersion
		= liveVersions[sitePath];

	return liveVersion && liveHashes[sitePath] === fileHashes[sitePath] && !foldedVersions.has(liveVersion) ? liveVersion : COMMIT;
}

// Every file whose address can carry a stamp: everything served except pages, Pages settings files, and the runtime file.
const stampableHashedPaths
	= [...servedPaths, ...BUCKET_FILES]
		.filter((sitePath) => !sitePath.endsWith('.html') && !PAGES_SETTINGS_FILES.includes(sitePath) && sitePath !== RUNTIME_FILE);

// Every file published in a version folder: the stampable files the site serves itself.
const versionedPaths
	= stampableHashedPaths.filter((sitePath) => !BUCKET_FILES.includes(sitePath));

// Rewrites one staged text file, pointing each address a pattern finds at its versioned copy.
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
			if (BUCKET_FILES.includes(target))
			{
				stampedReferenceCount++;
				return stampedAddress(address, fileHashes[target]);
			}
			if (fileVersions[target] === undefined)
			{
				if (!servedPaths.includes(target) && target !== RUNTIME_FILE)
				{
					warnings.push(`${sitePath} names ${address}, which is not a file of the site.`);
				}
				return address;
			}

			stampedReferenceCount++;
			return versionedAddress(target, fileVersions[target], address);
		});

	writeFileSync(stagedPath, stampedText);
}

// 1. Every file that names no other file is hashed first, manifests and stylesheets waiting until the files they name have their versions.
for (const sitePath of stampableHashedPaths.filter((path) => !manifestPaths.includes(path) && !stylesheetPaths.includes(path)))
{
	hashSitePath(sitePath);
}

// 2. Each file keeps its live version while unchanged. The scripts move together: when any one of them changed, every one takes this deploy's version, so a module's relative imports stay within one folder.
// - When the versions would outnumber the `_headers` rules left beside the site's own, the files of the oldest versions take this deploy's version too.
const siteHeadersText
	= existsSync(join(stageFolder, '_headers')) ? readFileSync(join(stageFolder, '_headers'), 'utf8') : '';

const versionLimit
	= Math.max(1, HEADER_RULE_LIMIT - countHeaderRules(siteHeadersText));

const foldedVersions
	= new Set();

const scriptPaths
	= versionedPaths.filter(isScript);

const scriptLiveVersions
	= [...new Set(scriptPaths.map((sitePath) => liveVersions[sitePath]))];

const scriptsUnchanged
	= scriptPaths.length > 0 && scriptLiveVersions.length === 1 && scriptLiveVersions[0] !== undefined && scriptPaths.every((sitePath) => liveHashes[sitePath] === fileHashes[sitePath]);

const versionsLikelyKept
	= new Set([...versionedPaths.filter((sitePath) => !isScript(sitePath) && !manifestPaths.includes(sitePath) && !stylesheetPaths.includes(sitePath)).map(keptVersionOf), ...(scriptsUnchanged ? scriptLiveVersions : []), ...[...manifestPaths, ...stylesheetPaths].map((sitePath) => liveVersions[sitePath]).filter(Boolean), COMMIT]);

const keptOldVersions
	= [...liveVersionOrder.filter((version) => versionsLikelyKept.has(version)), ...[...versionsLikelyKept].filter((version) => !liveVersionOrder.includes(version) && version !== COMMIT)];

for (const version of keptOldVersions.slice(0, Math.max(0, keptOldVersions.length + 1 - versionLimit)))
{
	foldedVersions.add(version);
}

for (const sitePath of versionedPaths.filter((path) => !manifestPaths.includes(path) && !stylesheetPaths.includes(path)))
{
	fileVersions[sitePath]
		= isScript(sitePath)
			? (scriptsUnchanged && !foldedVersions.has(scriptLiveVersions[0]) ? scriptLiveVersions[0] : COMMIT)
			: keptVersionOf(sitePath);
}

// 3. Manifests and stylesheets name other files, so they are stamped before their own hashes and versions are taken.
for (const sitePath of manifestPaths)
{
	stampFile(sitePath, (text, stamp) => text.replace(/("src"\s*:\s*")([^"]+)(")/g, (match, before, address, after) => before + stamp(address) + after));
	hashSitePath(sitePath);
	fileVersions[sitePath]
		= keptVersionOf(sitePath);
}

for (const sitePath of stylesheetPaths)
{
	stampFile(sitePath, (text, stamp) => text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, address) => `url(${quote}${stamp(address)}${quote})`));
	hashSitePath(sitePath);
	fileVersions[sitePath]
		= keptVersionOf(sitePath);
}

// 4. The runtime file holds the tables, so it is written once every other file has its hash and version, and it always takes this deploy's version, since it names this deploy's commit.
fileVersions[RUNTIME_FILE]
	= COMMIT;

// - Every version in use, oldest first as the live site ordered them, any the live order missed next, and this deploy's last, so each gets its rule.
const versionsInUse
	= [...new Set(Object.values(fileVersions))].filter((version) => version !== COMMIT);

const versionOrder
	= [...liveVersionOrder.filter((version) => versionsInUse.includes(version)), ...versionsInUse.filter((version) => !liveVersionOrder.includes(version)), COMMIT];

const runtimeTemplate
	= readFileSync(join(__dirname, 'cachebust-runtime.js'), 'utf8');

writeFileSync
(
	join(stageFolder, RUNTIME_FILE),
	`var CACHE_BUST = ${JSON.stringify(COMMIT)};\nvar VERSION_FOLDER = ${JSON.stringify(VERSION_FOLDER)};\nvar FILE_HASHES = ${JSON.stringify(fileHashes)};\nvar FILE_VERSIONS = ${JSON.stringify(Object.fromEntries(Object.entries(fileVersions).filter(([sitePath]) => sitePath !== RUNTIME_FILE)))};\nvar VERSION_ORDER = ${JSON.stringify(versionOrder)};\n${runtimeTemplate}`,
);

fileHashes[RUNTIME_FILE]
	= hashOfFile(join(stageFolder, RUNTIME_FILE));

// 5. Each versioned file is published again in its version folder, beside its copy at its plain address.
for (const [sitePath, version] of Object.entries(fileVersions))
{
	const versionedPath
		= join(stageFolder, VERSION_FOLDER, version, sitePath);

	mkdirSync(dirname(versionedPath), {recursive: true});
	copyFileSync(join(stageFolder, sitePath), versionedPath);
}

// 6. Pages are stamped last, since they name everything else, the runtime file included.
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

// - Where a tag first appears in a page's text, leaving out any inside an HTML comment, since a commented-out tag never runs; -1 when it never appears.
function findFirstTag(text, tagPattern)
{
	const comments
		= [...text.matchAll(/<!--[\s\S]*?(-->|$)/g)].map((comment) => [comment.index, comment.index + comment[0].length]);

	for (const tag of text.matchAll(new RegExp(tagPattern.source, 'gi')))
	{
		if (!comments.some(([start, end]) => tag.index >= start && tag.index < end))
		{
			return tag.index;
		}
	}
	return -1;
}

// Gives a page that runs module scripts an import map, which points every script the site serves at its versioned copy.
// - A module names the modules it imports inside its own code, such as `import {x} from './y.js'`, where no page attribute carries a version.
// - The browser looks each imported address up in the page's import map, so an import by a plain address loads the versioned file, and a module the page also loads by its versioned `src` stays one module. A relative import from inside a versioned module already stays in its version folder, since the scripts share one version.
// - The map goes just before the first thing on the page that can start loading a module: its first script of any kind, since a script can preload or import a module as it runs, or its first module preload. A browser that reads only one import map, such as Firefox, ignores a map that arrives after a module has started loading.
// - A page that already has an import map keeps its own, with a warning, since the browser takes the first map it meets.
function addModuleImportMap(sitePath)
{
	const stagedPath
		= join(stageFolder, sitePath);

	const text
		= readFileSync(stagedPath, 'utf8');

	if (findFirstTag(text, /<script\b[^>]*\btype=["']module["']/) === -1)
	{
		return;
	}
	if (/<script\b[^>]*\btype=["']importmap["']/i.test(text))
	{
		warnings.push(`${sitePath} has an import map of its own, so the modules it imports carry no versions.`);
		return;
	}

	// - Each key is a script's address from the site's root, and each value is the address of its versioned copy.
	const imports
		= {};

	for (const [scriptPath, version] of Object.entries(fileVersions).filter(([path]) => isScript(path)))
	{
		imports[rootAddressOf(scriptPath)]
			= versionedAddress(scriptPath, version);
	}

	// - The map takes the line and indentation of the first script or module preload, which moves to the next line.
	const scriptOrPreload
		= [findFirstTag(text, /<script\b/), findFirstTag(text, /<link\b[^>]*\brel=["']?modulepreload\b/)].filter((index) => index !== -1);

	const mapPlace
		= Math.min(...scriptOrPreload);

	const lineStart
		= text.lastIndexOf('\n', mapPlace) + 1;

	const leadingText
		= text.slice(lineStart, mapPlace);

	const indentation
		= /^[ \t]*$/.test(leadingText) ? leadingText : '';

	const importMap
		= `<script type="importmap">${JSON.stringify({imports})}</script>\n${indentation}`;

	writeFileSync(stagedPath, text.slice(0, mapPlace) + importMap + text.slice(mapPlace));
}

// 7. Cache lifetimes for each version folder, after any rules the site wrote itself.
// - Cloudflare applies a rule by its path even to a file the deployment does not hold, answering with the site's home page; a rule for each version folder this deploy holds, rather than for every file of a kind, keeps such an answer out of a browser's year-long cache, since an older deployment has no rule for a newer folder.
const siteHeaders
	= siteHeadersText.trim() !== '' ? siteHeadersText.trimEnd() + '\n\n' : '';

const versionHeaders
	= versionOrder.map((version) => `/${VERSION_FOLDER}/${version}/*\n  Cache-Control: public, max-age=${STAMPED_FILE_LIFETIME_SECONDS}, immutable\n  CDN-Cache-Control: public, max-age=${STAMPED_FILE_EDGE_LIFETIME_SECONDS}`).join('\n\n');

writeFileSync(join(stageFolder, '_headers'), `${siteHeaders}# Versioned files: each lives at /${VERSION_FOLDER}/<version>/<path>, which changes whenever its content does, so browsers can keep it for a year, while Cloudflare's edge keeps it for minutes, healing any copy taken mid-deploy. A file at its plain address keeps only the short lifetime Cloudflare gives a file no rule names.\n${versionHeaders}\n`);

// 8. Scripts that load a site file by a bare address would load it at its plain address, which keeps only a short lifetime.
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
				warnings.push(`${sitePath}:${index + 1} loads ${address} without withCacheBust, so it misses the year a version gives it.`);
			}
		}
	});
}
// #endregion




// #region report
const keptCount
	= Object.values(fileVersions).filter((version) => version !== COMMIT).length;

console.log(`Stamped ${Object.keys(fileHashes).length} files and ${stampedReferenceCount} references with commit ${COMMIT}: ${keptCount} kept their live versions, ${Object.keys(fileVersions).length - keptCount} took this deploy's, across ${versionOrder.length} version folders${foldedVersions.size > 0 ? `, after folding ${foldedVersions.size} of the oldest into this deploy's` : ''}.`);
for (const warning of warnings)
{
	console.log(`::warning::${warning}`);
}
// #endregion