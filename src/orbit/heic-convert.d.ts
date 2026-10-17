declare module "heic-convert" {
  export default function convert(opts: { buffer: Buffer | Uint8Array | ArrayBuffer; format: "JPEG" | "PNG"; quality?: number }): Promise<ArrayBuffer>;
}
