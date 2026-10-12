import { createHmac, timingSafeEqual } from "node:crypto";
import { del, list, put } from "@vercel/blob";

const PREFIX = "temporary-search-images/";

function signingKey() {
  const key = process.env.BLOB_READ_WRITE_TOKEN;
  if (!key) throw new Error("Image search needs a connected public Vercel Blob store with BLOB_READ_WRITE_TOKEN.");
  return key;
}

export async function uploadReference(dataUrl: string) {
  signingKey();
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("Upload a JPEG, PNG or WebP image.");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) throw new Error("Reference images must be smaller than 2 MB.");
  const blob = await put(`${PREFIX}${Date.now()}.${match[1]}`, bytes, {
    access: "public", addRandomSuffix: true, contentType: `image/${match[1]}`, cacheControlMaxAge: 60,
  });
  const payload = Buffer.from(JSON.stringify({ url: blob.url })).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(payload).digest("base64url");
  return { url: blob.url, receipt: `${payload}.${signature}` };
}

export async function deleteReference(receipt: string) {
  const [payload, signature] = receipt.split(".");
  if (!payload || !signature) throw new Error("Invalid image cleanup receipt.");
  const expected = createHmac("sha256", signingKey()).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("Invalid image cleanup receipt.");
  const { url } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { url: string };
  await del(url);
}

export async function sweepReferences() {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 100 });
    const stale = page.blobs.filter((blob) => Date.now() - blob.uploadedAt.getTime() > 60 * 60_000);
    if (stale.length) await del(stale.map((blob) => blob.url));
    deleted += stale.length;
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}
