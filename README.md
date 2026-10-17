# site-cachebust

A GitHub Action that publishes a static site to Cloudflare Pages with long-lived, always-fresh caching.

Every file the site serves gets a short hash of its own content and a version, and is published again in its version folder, as `/_v/<version>/<path>`, which every address that names the file points at. A changed file takes the deploy's version, so browsers fetch it at once. An unchanged file keeps the version it has on the live site, so browsers keep their copy across deploys. That lets every versioned file be cached for a year, while pages are checked on every visit, and files at their plain addresses keep only the short lifetime Cloudflare gives a file no rule names.

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
| `r2-steward-url` | with bucket uploads | The address of the R2 steward the account's apps ask before every save to R2. |
| `r2-steward-secret` | with bucket uploads | The R2 steward's secret, kept as a repository secret. |
| `branch` | no | The Pages branch to publish. `main` by default. |

## What it does

The action works on a stamped copy of the site, and the repository's own files stay as they are.
1. It hashes every file the site serves.
2. It gives each file a version. A file keeps the version it has on the live site for as long as its hash is unchanged, read from the live site's own `cachebust.js` at the project's `pages.dev` address, or, when that address answers only behind a sign-in, from the last publish's copy, which the action keeps in the repository's Actions cache. A changed or new file takes the deploy's commit as its version. The site's scripts move together: when any one of them changed, every one takes the deploy's version, so a module's relative imports stay within one folder. When the versions would outnumber the 100 `_headers` rules Cloudflare Pages allows, the files of the oldest versions take the deploy's version too. Each file is published again in its version folder, beside its copy at its plain address.
3. It writes `cachebust.js`, which holds those hashes and versions and `withCacheBust(path)`.
4. It points every `src`, `href`, and `poster` in each page that names one of the site's files at its versioned copy, and each Open Graph and Twitter image too. Links to other pages stay as they are, since pages are checked on every visit.
5. It gives each page that runs module scripts an import map, which points every script at its versioned copy, so a module imported by its plain address loads versioned too. The map goes before the page's first script or module preload, since a browser that reads only one import map ignores a map that arrives after a module has started loading. A page with an import map of its own keeps it, with a warning.
6. It points icon paths in a web app manifest, and each `url(...)` in a stylesheet, at their versioned copies.
7. It adds one `_headers` rule for each version folder, after any rules the site wrote itself, letting browsers keep everything in it for a year, while Cloudflare's edge keeps it for five minutes. Cloudflare applies a rule by its path even to a file the deployment does not hold, answering with the home page, so in the few seconds a deploy rolls out, a request that still reaches the deployment before, for a version folder it never held, matches none of its rules, so it keeps only the short lifetime Cloudflare gives a file no rule names, rather than a year.
8. It warns about a script that loads a site file by a bare address, outside `withCacheBust`.
9. It asks the account's R2 steward about every bucket file whose content changed. One no, at the steward's line of 80% of R2's free monthly allowance, stops the publish before anything is uploaded, and the steward pings its owner.
10. It uploads those bucket files, then publishes the stamped copy to Cloudflare Pages. A bucket file keeps a `?v=<hash>` stamp rather than a version folder, since the site's worker serves it at its plain address.

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