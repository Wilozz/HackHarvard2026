import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import convertHeic from "heic-convert";
import sharp from "sharp";
import { config } from "../config";
import { log } from "../log";
import type { PhotonApi, PhotonContent, PhotonMessage } from "../photon/api";

/** A photo from the chat, ready for Claude: JPEG, at most 1024 px on the long side. */
export interface ChatImage {
  /** Photon attachment id. */
  id: string;
  sentBy: string;
  at: string;
  data: Buffer;
}

/** How far back to look for photos when someone asks for something. */
const WINDOW_MS = 60 * 60 * 1000;
const MAX_IMAGES = 4;
const LONG_EDGE = 1024;

function attachmentIds(content: PhotonContent): string[] {
  if (content.type === "attachment" && content.attachmentId) return [content.attachmentId];
  if (content.type === "group") return (content.parts ?? []).flatMap(attachmentIds);
  return [];
}

const cacheDir = () => join(config.ORBIT_APPS_DIR, "..", "images");

/** Any photo format people send (HEIC from iPhones, PNG, JPEG, WebP, GIF) → a small JPEG Claude can read and an app can embed. */
export async function toJpeg(data: Buffer, contentType: string): Promise<Buffer> {
  let input = data;
  if (/heic|heif/i.test(contentType)) input = Buffer.from(await convertHeic({ buffer: data, format: "JPEG", quality: 0.9 }));
  return sharp(input).rotate().resize({ width: LONG_EDGE, height: LONG_EDGE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
}

/** Download (or read from the cache) one attachment as a ChatImage. Undefined if it isn't an image. */
export async function loadImage(api: PhotonApi, id: string, sentBy: string, at: string): Promise<ChatImage | undefined> {
  const cached = join(cacheDir(), `${id}.jpg`);
  if (existsSync(cached)) return { id, sentBy, at, data: readFileSync(cached) };
  const { contentType, data } = await api.downloadAttachment(id);
  if (!/^image\//i.test(contentType)) return undefined;
  const jpeg = await toJpeg(data, contentType);
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(cached, jpeg);
  return { id, sentBy, at, data: jpeg };
}

export function readCachedImage(id: string): Buffer | undefined {
  const cached = join(cacheDir(), `${id}.jpg`);
  return existsSync(cached) ? readFileSync(cached) : undefined;
}

/**
 * The photos people sent in this chat in the last hour (newest four, oldest
 * first), up to and including `upTo`. Photos usually arrive as their own
 * message before "@Orbit make…", so this looks back rather than only at the
 * message that mentions Orbit.
 */
export async function recentImages(args: {
  api: PhotonApi;
  all: PhotonMessage[];
  spaceIds: Set<string>;
  upTo: PhotonMessage;
  nameOf: (m: PhotonMessage) => string;
}): Promise<ChatImage[]> {
  const until = Date.parse(args.upTo.createdAt);
  const found: { id: string; m: PhotonMessage }[] = [];
  for (const m of args.all) {
    if (!args.spaceIds.has(m.space.id) || m.status === "failed") continue;
    const at = Date.parse(m.createdAt);
    if (at > until || at < until - WINDOW_MS) continue;
    for (const id of attachmentIds(m.content)) found.push({ id, m });
  }
  const images: ChatImage[] = [];
  for (const { id, m } of found.slice(-MAX_IMAGES)) {
    try {
      const image = await loadImage(args.api, id, args.nameOf(m), m.createdAt);
      if (image) images.push(image);
    } catch (err) {
      log.error("orbit_image_failed", err, { attachmentId: id });
    }
  }
  return images;
}

/** Placeholder the generated code uses where image n goes; swapped for the real image after generation. */
export const imageToken = (n: number) => `ORBIT_IMAGE_${n}`;

const dataUri = (data: Buffer) => `data:image/jpeg;base64,${data.toString("base64")}`;

/** Put the real images into the app in place of their placeholders. */
export function inlineImages(html: string, images: Buffer[]): string {
  return images.reduce((out, data, i) => out.split(imageToken(i + 1)).join(dataUri(data)), html);
}

/** The reverse, so an edit sends Claude the code without hundreds of KB of base64. */
export function stripImages(html: string, images: Buffer[]): string {
  return images.reduce((out, data, i) => out.split(dataUri(data)).join(imageToken(i + 1)), html);
}
