import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { createRuntime } from "./runtime.ts";
import { BlobStore } from "./blob-store.ts";

const documentPath = () =>
  process.env.VERCEL_ENV === "production"
    ? "desk/v1.json"
    : "preview/desk-v1.json";

function cloudStore() {
  return new BlobStore({
    async read() {
      try {
        const result = await get(documentPath(), {
          access: "private",
          useCache: false,
          abortSignal: AbortSignal.timeout(10_000),
        });
        if (!result) return null;
        if (!result.stream) throw new Error("Missing private Blob body.");
        return {
          content: await new Response(result.stream).text(),
          etag: result.blob.etag,
        };
      } catch (cause) {
        throw new Error("Database read failed.", { cause });
      }
    },
    async write(content, etag) {
      try {
        await put(documentPath(), content, {
          access: "private",
          contentType: "application/json",
          allowOverwrite: Boolean(etag),
          ifMatch: etag,
          abortSignal: AbortSignal.timeout(10_000),
        });
        return true;
      } catch (cause) {
        if (cause instanceof BlobPreconditionFailedError) return false;
        if (
          !etag &&
          (await get(documentPath(), {
            access: "private",
            useCache: false,
            abortSignal: AbortSignal.timeout(10_000),
          }))
        )
          return false;
        throw new Error("Database write failed.", { cause });
      }
    },
  });
}

export async function cloudStorageReady() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return false;
  await cloudStore().check();
  return true;
}

export function cloudConfigured(): boolean {
  return [
    "BLOB_READ_WRITE_TOKEN",
    "OPERATOR_PASSWORD",
    "SESSION_SECRET",
    "RESIDENT_ACCESS_CODE",
  ].every((key) => Boolean(process.env[key]));
}

export function cloudRuntime(workflow?: Parameters<typeof createRuntime>[1]) {
  if (!cloudConfigured())
    throw new Error("The incident desk is not configured.");
  return createRuntime(cloudStore(), workflow);
}
