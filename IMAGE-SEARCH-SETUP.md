# Image search setup

Image search is active and required. SerpApi Google Lens is the default image-search provider; SearchAPI remains in the code but is disabled unless `IMAGE_SEARCH_PROVIDER=searchapi` is explicitly configured.

1. In the Vercel dashboard, open Storage and create a public Blob store. Connect it to qalara-price-estimate for Production and Preview.
2. Confirm the project has BLOB_READ_WRITE_TOKEN. This stays server-side; never add it to GitHub.
3. Add `SERPAPI_API_KEY` to the project's Production and Preview environment variables.
4. Add CRON_SECRET as a long random secret. This protects the scheduled cleanup route.
5. Redeploy. Test with a JPEG, PNG or WebP smaller than 2 MB.

The retail stage uploads the image to Blob, then submits its temporary URL to SerpApi Google Lens using `type=visual_matches`. Product name, description, material, dimensions and region refine the search. TinyFish separately performs text discovery and reads candidate PDPs.

Images are deleted in the search route's cleanup whether the request succeeds or fails. A scheduled cleanup deletes temporary images older than one hour if a request is interrupted. Deletion from Blob does not control copies or caches held by Google or the visual-search provider.

The public Blob store and secrets must be configured before image search works. If visual search fails, the retail search returns an error instead of silently using only text.
