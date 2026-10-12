# Image search setup

Image and wholesale search are currently paused. Retail search uses only TinyFish Search and Fetch and needs no Blob store. The setup below is retained for a future image-search phase; its cleanup cron is disabled while uploads are paused.

1. In the Vercel dashboard, open Storage and create a public Blob store. Connect it to qalara-price-estimate for Production and Preview.
2. Confirm the project has BLOB_READ_WRITE_TOKEN. This stays server-side; never add it to GitHub.
3. Add CRON_SECRET as a long random secret in the project's environment variables. This protects the scheduled cleanup route.
4. Upload the changed app/page.tsx, app/api/search-products/route.ts, package.json, pnpm-lock.yaml and vercel.json. Also add lib/temporary-images.ts and app/api/image-cleanup/route.ts.
5. Redeploy. Test with a JPEG, PNG or WebP smaller than 2 MB.

The retail stage uploads the actual image to Blob, then asks TinyFish to submit its URL through Google Lens's image search. Text fields refine the visual matches. Two retail results appear before a separate wholesale lookup starts.

Images are deleted on the completion webhook or final status check. A daily cleanup deletes temporary images older than one hour, covering interrupted searches and failed callbacks. An interrupted upload can therefore remain until the next daily sweep (up to roughly 25 hours). Deletion from Blob does not control copies or caches held by Google or TinyFish.

The public Blob store and secrets must be configured before image search works. Google Lens automation and callback delivery still require verification on the deployed application. If visual search is blocked, the retail search returns an error instead of silently using only text.
