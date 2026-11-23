#!/usr/bin/env node
// #region read the live versions
// Fetches the live site's own `cachebust.js`, which names each file's hash and version there, so an unchanged file keeps its version and browsers keep their copy across the deploy:
// - The project's own address comes from Cloudflare, since a project whose name was taken lives at a pages.dev address of its own; the fresh query reaches past any copy the edge holds.
// - A live address that answers with no tables, such as one behind a sign-in, gives way to the last publish's copy; with neither, every file takes this deploy's version.
// Reads its settings from environment variables, and uses only Node's own modules.
// #endregion




// #region dependencies
const {copyFileSync, existsSync, rmSync, writeFileSync}
	= require('node:fs');
// #endregion




// #region settings
const CLOUDFLARE_API_TOKEN
	= process.env.CLOUDFLARE_API_TOKEN;

const CLOUDFLARE_ACCOUNT_ID
	= process.env.CLOUDFLARE_ACCOUNT_ID;

const PROJECT_NAME
	= process.env.PROJECT_NAME;

// - Where the live `cachebust.js` is written, for the stamping to read.
const LIVE_RUNTIME_FILE
	= process.env.LIVE_RUNTIME_FILE;

// - The last publish's kept copy of `cachebust.js`.
const LAST_RUNTIME_FILE
	= process.env.LAST_RUNTIME_FILE;

// - How long each request may take, as `curl --max-time 30` gave it.
const REQUEST_TIMEOUT_MILLISECONDS
	= 30_000;
// #endregion




// #region reading
// - Gives back the project's own pages.dev subdomain, or an empty string when Cloudflare does not answer with one.
async function readProjectSubdomain()
{
	try
	{
		const response
			= await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${PROJECT_NAME}`, {headers: {Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`}, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)});
		if (!response.ok)
		{
			return '';
		}
		const body
			= await response.json();
		return body?.result?.subdomain ?? '';
	}
	catch
	{
		return '';
	}
}

// - Gives back the live `cachebust.js`, or nothing when the address does not answer with one that holds the version table.
async function readLiveRuntime(address)
{
	try
	{
		const response
			= await fetch(`https://${address}/cachebust.js?fresh=${Math.floor(Date.now() / 1000)}`, {signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)});
		if (!response.ok)
		{
			return undefined;
		}
		const text
			= await response.text();
		return /^var FILE_VERSIONS = /m.test(text) ? text : undefined;
	}
	catch
	{
		return undefined;
	}
}
// #endregion




// #region run
async function main()
{
	const address
		= (await readProjectSubdomain()) || `${PROJECT_NAME}.pages.dev`;
	const liveRuntime
		= await readLiveRuntime(address);
	if (liveRuntime !== undefined)
	{
		writeFileSync(LIVE_RUNTIME_FILE, liveRuntime);
		return;
	}

	rmSync(LIVE_RUNTIME_FILE, {force: true});
	if (existsSync(LAST_RUNTIME_FILE))
	{
		copyFileSync(LAST_RUNTIME_FILE, LIVE_RUNTIME_FILE);
		console.log(`https://${address} answers with no versions, so the versions come from the last publish's copy.`);
	}
	else
	{
		console.log(`https://${address} answers with no versions, and no publish's copy is kept, so every file takes this deploy's version.`);
	}
}

main().catch((error) =>
{
	console.log(`::error::${error.message}`);
	process.exit(1);
});
// #endregion