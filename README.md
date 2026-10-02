# site-cachebust

A GitHub Action that publishes a static site to Cloudflare Pages with long-lived, always-fresh caching.

Every file the site serves gets a short hash of its own content, and every address that names the file carries it as `?v=<hash>`. A changed file gets a new address, so browsers fetch it at once. An unchanged file keeps its address, so browsers keep their copy. That lets every stamped file be cached for a year, while pages are checked on every visit.

## Use

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: <owner>/site-cachebust@main
        with:
          project-name: my-site
          cloudflare-api-token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          cloudflare-account-id: <your account id>
          exclude: |
            README.md
```

## Inputs

| Input | Required | What it is |
| --- | --- | --- |
| `project-name` | yes | The Cloudflare Pages project to publish to. |
| `cloudflare-api-token` | yes | A token that can publish to Cloudflare Pages, and write items in the bucket when one is used. |
| `cloudflare-account-id` | yes | The Cloudflare account that holds the project. |
| `site-folder` | no | The folder that holds the site. The repository root by default. |
| `exclude` | no | Paths that are not part of the site, one per line. Names that start with `.` are always left out. |
| `bucket` | no | An R2 bucket for files over Cloudflare Pages' 25 MiB limit. The site's own worker serves them. |
| `bucket-files` | no | The files that go to the bucket instead of to Pages, one per line. |
| `branch` | no | The Pages branch to publish. `main` by default. |

## What it does

The action works on a stamped copy of the site, and the repository's own files stay as they are.
1. It hashes every file the site serves.
2. It writes `cachebust.js`, which holds those hashes and `withCacheBust(path)`.
3. It stamps every `src`, `href`, and `poster` in each page that names one of the site's files, and each Open Graph and Twitter image. Links to other pages stay unstamped, since pages are checked on every visit.
4. It stamps icon paths in a web app manifest, and each `url(...)` in a stylesheet.
5. It adds `_headers` rules that let browsers keep every stamped kind of file for a year, after any rules the site wrote itself.
6. It warns about a script that loads a site file by a bare address, outside `withCacheBust`.
7. It uploads bucket files whose content changed, then publishes the stamped copy to Cloudflare Pages.

## Addresses a page builds while it runs

A page that builds a file address in a script loads `cachebust.js` first, and wraps each such address:
```html
<script src="cachebust.js"></script>
<script>
  new Audio(withCacheBust('sounds/' + name + '.mp3')).play();
</script>
```

Keep a `cachebust.js` in the repository for local runs. The published copy replaces it with the real one. This stand-in stamps every file with the time the page loaded, so local files are never stale:
```js
var CACHE_BUST = String(Date.now());
var FILE_HASHES = {};
function withCacheBust(path)
{
	return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'v=' + CACHE_BUST;
}
```

## A site's own wrangler.toml

The stamped copy is written to `.site-cachebust-published` in the workspace. A site with its own `wrangler.toml`, such as one with an R2 binding for its worker, names that folder:
```toml
pages_build_output_dir = ".site-cachebust-published"
```