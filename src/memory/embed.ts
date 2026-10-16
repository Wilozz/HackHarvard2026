import { config } from "../config";

// bge-small-en-v1.5 runs locally (no API key, ~35 MB download on first use,
// 512-token window). Queries get the instruction prefix the model was trained
// with; passages are embedded as-is.
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

type Extractor = (
  texts: string | string[],
  options: { pooling: "cls"; normalize: true },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<Extractor> | undefined;

async function getExtractor(): Promise<Extractor> {
  extractorPromise ??= (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = "./data/models";
    const pipe = await pipeline("feature-extraction", config.embeddingModel, { dtype: "q8" });
    return pipe as unknown as Extractor;
  })();
  return extractorPromise;
}

async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  // bge models use the [CLS] token embedding, L2-normalized.
  const out = await extractor(texts, { pooling: "cls", normalize: true });
  const rows = out.tolist();
  for (const row of rows) {
    if (row.length !== config.embedDim) {
      throw new Error(`embedding has ${row.length} dims, expected ${config.embedDim}`);
    }
  }
  return rows;
}

export function embedPassages(texts: string[]): Promise<number[][]> {
  return embed(texts);
}

export async function embedQuery(text: string): Promise<number[]> {
  const [row] = await embed([QUERY_PREFIX + text]);
  if (!row) throw new Error("embedding returned no rows");
  return row;
}
