import { createReadStream, createWriteStream } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { copyFile, mkdir, readFile, rm, stat, writeFile, open } from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env";
import { hmac } from "../crypto";

export interface StorageAdapter {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Inclusive byte range [start, end]. */
  getRange(key: string, start: number, end: number): Promise<Buffer>;
  size(key: string): Promise<number>;
  remove(key: string): Promise<void>;
  /** Time-limited URL that a third party (e.g. Instagram) can fetch without a session. */
  publicUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Signed URL the browser can PUT the file to directly (bypasses serverless body limits). Null if unsupported. */
  createUploadUrl(key: string): Promise<{ url: string; token: string } | null>;
  /** Copy an object to a local file path, streaming (never buffers large videos in memory). */
  downloadToFile(key: string, dest: string): Promise<void>;
  /** Upload a local file. */
  putFile(key: string, file: string, contentType: string): Promise<void>;
  /** Stream an object (or an inclusive byte range of it) without loading it into memory. */
  stream(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>>;
}

function safeKey(key: string) {
  if (key.includes("..") || path.isAbsolute(key)) throw new Error("Invalid storage key");
  return key;
}

type TokenPurpose = "media" | "upload";

function signToken(purpose: TokenPurpose, key: string, expiresAt: number) {
  const payload = Buffer.from(JSON.stringify({ k: key, e: expiresAt })).toString("base64url");
  return `${payload}.${hmac(`${purpose}:${payload}`)}`;
}

/** Constant-time signature check; returns the key or null for tampered, malformed or expired tokens. */
function verifyToken(purpose: TokenPurpose, token: string): string | null {
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(hmac(`${purpose}:${payload}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { k, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { k: unknown; e: unknown };
    if (typeof k !== "string" || typeof e !== "number" || Date.now() > e) return null;
    return k;
  } catch {
    return null;
  }
}

export const signMediaToken = (key: string, expiresAt: number) => signToken("media", key, expiresAt);
export const verifyMediaToken = (token: string) => verifyToken("media", token);
/** Signed, short-lived permission to PUT one object (local storage direct uploads). */
export const signUploadToken = (key: string, expiresAt: number) => signToken("upload", key, expiresAt);
export const verifyUploadToken = (token: string) => verifyToken("upload", token);

export class UploadTooLargeError extends Error {}

class LocalStorage implements StorageAdapter {
  constructor(private root: string) {}
  private p(key: string) {
    return path.resolve(this.root, safeKey(key));
  }
  async put(key: string, data: Buffer) {
    const file = this.p(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }
  get(key: string) {
    return readFile(this.p(key));
  }
  async getRange(key: string, start: number, end: number) {
    const fh = await open(this.p(key), "r");
    try {
      const len = end - start + 1;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }
  async size(key: string) {
    return (await stat(this.p(key))).size;
  }
  async remove(key: string) {
    await rm(this.p(key), { force: true });
  }
  async publicUrl(key: string, ttlSeconds: number) {
    const token = signMediaToken(key, Date.now() + ttlSeconds * 1000);
    return `${env().APP_URL}/api/media/public/${token}`;
  }
  async stream(key: string, range?: { start: number; end: number }) {
    const file = this.p(key);
    await stat(file); // fail before streaming if missing
    return Readable.toWeb(createReadStream(file, range ? { start: range.start, end: range.end } : {})) as ReadableStream<Uint8Array>;
  }
  /** Direct upload to local disk through our own signed, streaming endpoint (never buffered in memory). */
  async createUploadUrl(key: string) {
    const token = signUploadToken(safeKey(key), Date.now() + 3600_000);
    return { url: `/api/v1/media/local-upload/${token}`, token };
  }
  /** Stream a request body to disk, stopping at maxBytes. Partial files are removed on failure. */
  async putStream(key: string, body: ReadableStream<Uint8Array>, maxBytes: number) {
    const target = this.p(key);
    await mkdir(path.dirname(target), { recursive: true });
    let bytes = 0;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) controller.error(new UploadTooLargeError(`Upload exceeds ${maxBytes} bytes`));
        else controller.enqueue(chunk);
      },
    });
    // "wx": never overwrite an existing object (a reused upload link fails with EEXIST).
    const out = createWriteStream(target, { flags: "wx" });
    let created = false;
    out.once("open", () => (created = true));
    try {
      await pipeline(Readable.fromWeb(body.pipeThrough(limiter) as import("node:stream/web").ReadableStream), out);
    } catch (err) {
      if (created) await rm(target, { force: true }); // only remove a partial file this call created
      throw err;
    }
    return bytes;
  }
  async downloadToFile(key: string, dest: string) {
    await copyFile(this.p(key), dest);
  }
  async putFile(key: string, file: string) {
    const target = this.p(key);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(file, target);
  }
}

class SupabaseStorage implements StorageAdapter {
  private client: SupabaseClient;
  constructor(url: string, serviceKey: string, private bucket: string) {
    this.client = createClient(url, serviceKey, { auth: { persistSession: false } });
  }
  async put(key: string, data: Buffer, contentType: string) {
    const { error } = await this.client.storage.from(this.bucket).upload(safeKey(key), data, { contentType, upsert: true });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }
  async get(key: string) {
    const { data, error } = await this.client.storage.from(this.bucket).download(safeKey(key));
    if (error || !data) throw new Error(`Storage download failed: ${error?.message}`);
    return Buffer.from(await data.arrayBuffer());
  }
  async getRange(key: string, start: number, end: number) {
    const url = await this.publicUrl(key, 600);
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!res.ok && res.status !== 206) throw new Error(`Storage range read failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  async size(key: string) {
    const dir = path.posix.dirname(safeKey(key));
    const name = path.posix.basename(key);
    const { data, error } = await this.client.storage.from(this.bucket).list(dir, { search: name });
    const item = data?.find((f) => f.name === name);
    if (error || !item) throw new Error("Storage object not found");
    return Number((item.metadata as { size?: number })?.size ?? 0);
  }
  async remove(key: string) {
    await this.client.storage.from(this.bucket).remove([safeKey(key)]);
  }
  async downloadToFile(key: string, dest: string) {
    const res = await fetch(await this.publicUrl(key, 3600));
    if (!res.ok || !res.body) throw new Error(`Storage download failed: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(dest));
  }
  async putFile(key: string, file: string, contentType: string) {
    await this.put(key, await readFile(file), contentType);
  }
  async stream(key: string, range?: { start: number; end: number }) {
    const res = await fetch(await this.publicUrl(key, 600), range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {});
    if ((!res.ok && res.status !== 206) || !res.body) throw new Error(`Storage read failed: ${res.status}`);
    return res.body;
  }
  async createUploadUrl(key: string) {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUploadUrl(safeKey(key));
    if (error || !data) throw new Error(`Could not create upload URL: ${error?.message}`);
    return { url: data.signedUrl, token: data.token };
  }
  async publicUrl(key: string, ttlSeconds: number) {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrl(safeKey(key), ttlSeconds);
    if (error || !data) throw new Error(`Could not sign storage URL: ${error?.message}`);
    return data.signedUrl;
  }
}

let instance: StorageAdapter | null = null;

export function storage(): StorageAdapter {
  if (instance) return instance;
  const e = env();
  if (e.STORAGE_PROVIDER === "supabase") {
    if (!e.NEXT_PUBLIC_SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("STORAGE_PROVIDER=supabase requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }
    instance = new SupabaseStorage(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, e.SUPABASE_STORAGE_BUCKET);
  } else {
    instance = new LocalStorage(path.resolve(e.STORAGE_LOCAL_DIR));
  }
  return instance;
}

export function setStorageForTests(adapter: StorageAdapter | null) {
  instance = adapter;
}

export { LocalStorage };
