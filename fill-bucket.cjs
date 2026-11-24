#!/usr/bin/env node
// #region fill the bucket
// Sends the site's bucket files to its R2 bucket, for files too large for Cloudflare Pages:
// - R2 speaks the S3 protocol, where the token's id is the access key and the SHA-256 hash of the token is the secret key, and each request is signed with AWS's Signature Version 4.
// - The bucket remembers each file's MD5 hash as its ETag. A file whose hash already matches is skipped.
// - Before any upload, the account's R2 steward weighs every file that would be uploaded, against its line at 80% of R2's free monthly allowance. One no holds the whole publish, nothing is uploaded nor published, and the steward pings its owner.
// - A failed upload gives back the steward's yeses of the files after it.
// Reads its settings from environment variables, and uses only Node's own modules.
// #endregion




// #region dependencies
const {createHash, createHmac}
	= require('node:crypto');
const {createReadStream, readFileSync, statSync}
	= require('node:fs');
// #endregion


// #region settings
const CLOUDFLARE_API_TOKEN
	= process.env.CLOUDFLARE_API_TOKEN;

const CLOUDFLARE_ACCOUNT_ID
	= process.env.CLOUDFLARE_ACCOUNT_ID;

const PROJECT_NAME
	= process.env.PROJECT_NAME;

const SITE_FOLDER
	= process.env.SITE_FOLDER || '.';

const BUCKET
	= process.env.BUCKET;

// - The files that go to the bucket, one per line.
const BUCKET_FILES
	= (process.env.BUCKET_FILES ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '');

const R2_STEWARD_URL
	= process.env.R2_STEWARD_URL ?? '';

const R2_STEWARD_SECRET
	= process.env.R2_STEWARD_SECRET ?? '';

// - How long each steward request may take, as `curl --max-time 30` gave it.
const STEWARD_TIMEOUT_MILLISECONDS
	= 30_000;

// - R2 takes every request in its one region, `auto`.
const REGION
	= 'auto';
// #endregion


// #region signing
function sha256Hex(data)
{
	return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data)
{
	return createHmac('sha256', key).update(data).digest();
}

// - Encodes a key's path the way S3 signs it: each part between slashes, with every character but the unreserved ones escaped.
function encodeKeyPath(key)
{
	return key.split('/').map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

// - Gives back the headers that sign one request to the bucket. The body goes unsigned, which R2 accepts.
function signedHeaders(method, path, credentials)
{
	const host
		= `${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
	const amzDate
		= new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
	const dateStamp
		= amzDate.slice(0, 8);
	const payloadHash
		= 'UNSIGNED-PAYLOAD';
	const headers
		= {host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate};
	const headerNames
		= Object.keys(headers).map((name) => name.toLowerCase()).sort();
	const canonicalHeaders
		= headerNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('');
	const signedHeaderList
		= headerNames.join(';');
	const canonicalRequest
		= [method, path, '', canonicalHeaders, signedHeaderList, payloadHash].join('\n');
	const scope
		= `${dateStamp}/${REGION}/s3/aws4_request`;
	const stringToSign
		= ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
	const signingKey
		= hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, dateStamp), REGION), 's3'), 'aws4_request');
	const signature
		= createHmac('sha256', signingKey).update(stringToSign).digest('hex');
	const {host: _host, ...sentHeaders}
		= headers;
	return {...sentHeaders, Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`};
}
// #endregion


// #region the bucket
function objectAddress(key)
{
	return {path: `/${encodeURIComponent(BUCKET)}/${encodeKeyPath(key)}`, url: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${encodeURIComponent(BUCKET)}/${encodeKeyPath(key)}`};
}

// - Gives back the bucket's MD5 hash of an object, or an empty string when the bucket does not hold it yet.
async function bucketHashOf(key, credentials)
{
	const {path, url}
		= objectAddress(key);
	try
	{
		const response
			= await fetch(url, {method: 'HEAD', headers: signedHeaders('HEAD', path, credentials)});
		return response.ok ? (response.headers.get('etag') ?? '').replaceAll('"', '') : '';
	}
	catch
	{
		return '';
	}
}

// - Sends one file to the bucket, read whole, so its length goes with it, as R2 asks of every upload.
async function putObject(key, localPath, credentials)
{
	const {path, url}
		= objectAddress(key);
	const response
		= await fetch(url, {method: 'PUT', headers: signedHeaders('PUT', path, credentials), body: readFileSync(localPath)});
	if (!response.ok)
	{
		throw new Error(`The bucket refused ${key} (${response.status}): ${(await response.text()).slice(0, 500)}`);
	}
}

function md5OfFile(localPath)
{
	return new Promise((resolve, reject) =>	{
												const hash
													= createHash('md5');
												createReadStream(localPath).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
											});
}
// #endregion


// #region the steward
async function askSteward(path, body)
{
	const response
		= await fetch(`${R2_STEWARD_URL}${path}`, {method: 'POST', headers: {Authorization: `Bearer ${R2_STEWARD_SECRET}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(STEWARD_TIMEOUT_MILLISECONDS)});
	return response.json();
}

// - Gives back yeses whose uploads never happened.
async function releaseReservations(reservations)
{
	for (const reservationId of reservations)
	{
		try
		{
			await askSteward('/release', {reservationId});
		}
		catch
		{
			// - A release that fails leaves the steward's reservation to lapse on its own.
		}
	}
}
// #endregion


// #region run
async function main()
{
	const verifyResponse
		= await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/tokens/verify`, {headers: {Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`}});
	if (!verifyResponse.ok)
	{
		throw new Error(`Cloudflare did not verify the token (${verifyResponse.status}).`);
	}
	const credentials
		= {accessKeyId: (await verifyResponse.json()).result.id, secretAccessKey: sha256Hex(CLOUDFLARE_API_TOKEN)};
	console.log(`::add-mask::${credentials.secretAccessKey}`);

	// - First, the files whose content differs from the bucket's copy.
	const uploads
		= [];
	for (const bucketFile of BUCKET_FILES)
	{
		const repositoryHash
			= await md5OfFile(`${SITE_FOLDER}/${bucketFile}`);
		const bucketHash
			= await bucketHashOf(bucketFile, credentials);
		if (repositoryHash === bucketHash)
		{
			console.log(`The bucket already holds ${bucketFile} (${repositoryHash}).`);
		}
		else
		{
			console.log(`The bucket's copy of ${bucketFile} (${bucketHash || 'none'}) differs from ${repositoryHash}.`);
			uploads.push(bucketFile);
		}
	}

	// - Then the steward weighs every upload, before any is made.
	if (uploads.length > 0 && (R2_STEWARD_URL === '' || R2_STEWARD_SECRET === ''))
	{
		console.log('::error::Uploading to the bucket asks the R2 steward first, so pass r2-steward-url and r2-steward-secret. Nothing was uploaded nor published.');
		process.exit(1);
	}
	const reservations
		= [];
	for (const bucketFile of uploads)
	{
		let answer;
		try
		{
			answer
				= await askSteward('/ask', {app: `The ${PROJECT_NAME} site`, what: `the bucket file ${bucketFile}`, bytes: statSync(`${SITE_FOLDER}/${bucketFile}`).size, fallback: `the ${PROJECT_NAME} publish stops, holding back this file, and the site keeps its last published version`});
		}
		catch
		{
			answer
				= undefined;
		}
		if (answer?.isAllowed !== true)
		{
			await releaseReservations(reservations);
			console.log(`::error::The R2 steward held ${bucketFile} (${answer?.reason || answer?.error || 'no answer'}), so nothing was uploaded nor published. At its line, 80% of R2's free monthly allowance, it pings its owner.`);
			process.exit(1);
		}
		reservations.push(answer.reservationId);
	}

	// - Last, the uploads themselves. A failed upload gives back the yeses of the files after it.
	for (const [index, bucketFile] of uploads.entries())
	{
		console.log(`Uploading ${bucketFile}.`);
		try
		{
			await putObject(bucketFile, `${SITE_FOLDER}/${bucketFile}`, credentials);
		}
		catch (error)
		{
			console.log(error.message);
			await releaseReservations(reservations.slice(index + 1));
			process.exit(1);
		}
	}
}

main().catch((error) =>	{
							console.log(`::error::${error.message}`);
							process.exit(1);
						});
// #endregion