# Hosting slopespy.com on Cloudflare Pages

The site is static: everything lives in `docs/`, with no build step.

1. In the Cloudflare dashboard, open **Workers & Pages** → **Create** → **Pages** → **Connect to Git**, and pick `clv/slopespy`.
2. Production branch: `main`. Framework preset: **None**. Build command: leave empty. Build output directory: `docs`.
3. Click **Save and Deploy**.
4. In the project's **Custom domains** tab, add `slopespy.com` (and `www.slopespy.com` if wanted) and accept the DNS records it proposes.

Every push to `main` redeploys. `docs/` has about 13,000 files (the limit is 20,000), the largest about 6 MB (limit 25 MB).

Every page declares `https://slopespy.com/...` as its canonical URL. Once the domain is live, submit
`https://slopespy.com/sitemap.xml` in Google Search Console.

Terrain tiles load straight from the public AWS Terrain Tiles bucket and are cached in the visitor's
browser (Cache Storage, up to about 4,000 tiles), so repeat visits don't download them again.

`wrangler.jsonc` at the repo root tells Workers Builds to serve `docs/` as static assets. Its empty
`previews` block lets non-main branches build a preview (`npx wrangler preview`).
