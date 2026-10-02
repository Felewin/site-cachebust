// #region with cache bust
// Gives back a site file's address with its stamp, "?v=<hash>", for an address a page builds while it runs.
// - The deploy writes `CACHE_BUST` and `FILE_HASHES` just above this function: the commit being deployed, and every served file's own content hash, keyed by its path from the site's root.
// - A file listed there gets its own hash, so it keeps its address until its content changes. Any other address gets the commit.
// - A path can arrive URL-encoded, such as "audio/Blue%20(3).mp3", and the table is keyed by plain names, so the path is decoded before the lookup.
// - A leading "/" or "./" is dropped before the lookup, since the table's paths start at the site's root.
function withCacheBust(path)
{
	var key
		= path.split('#')[0].split('?')[0].replace(/^\.?\//, '');

	try
	{
		key
			= decodeURIComponent(key);
	}
	catch (error)
	{
		// A path that cannot be decoded is looked up as written.
	}

	var stamp
		= FILE_HASHES[key] || CACHE_BUST;

	return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + stamp;
}
// #endregion