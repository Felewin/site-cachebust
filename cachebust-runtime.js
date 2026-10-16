// #region with cache bust
// Gives back the address of a site file's versioned copy, "/_v/<version>/<path>", for an address a page builds while it runs.
// - The deploy writes `CACHE_BUST`, `VERSION_FOLDER`, `FILE_HASHES`, `FILE_VERSIONS`, and `VERSION_ORDER` just above this function: the commit being deployed, the folder versioned copies live under, every served file's own content hash and version keyed by its path from the site's root, and the versions from oldest to newest, which the next deploy reads to keep each unchanged file's version.
// - A file listed with a version keeps its address until its content changes. A file the site's worker serves from its bucket gets "?v=<hash>" instead, and any other address gets "?v=<commit>".
// - A path can arrive URL-encoded, such as "audio/Blue%20(3).mp3", and the tables are keyed by plain names, so the path is decoded before the lookup.
// - A leading "/" or "./" is dropped before the lookup, since the tables' paths start at the site's root.
function withCacheBust(path)
{
	var pieces
		= path.split('#');

	var queryStart
		= pieces[0].indexOf('?');

	var key
		= (queryStart >= 0 ? pieces[0].slice(0, queryStart) : pieces[0]).replace(/^\.?\//, '');

	try
	{
		key
			= decodeURIComponent(key);
	}
	catch (error)
	{
		// A path that cannot be decoded is looked up as written.
	}

	var version
		= FILE_VERSIONS[key];

	if (version)
	{
		return '/' + VERSION_FOLDER + '/' + version + '/' + key.split('/').map(encodeURIComponent).join('/') + (queryStart >= 0 ? pieces[0].slice(queryStart) : '') + (pieces.length > 1 ? '#' + pieces.slice(1).join('#') : '');
	}

	var stamp
		= FILE_HASHES[key] || CACHE_BUST;

	return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + stamp;
}
// #endregion