import { ChromaClient, Collection } from "chromadb";
import { homedir } from "node:os";
import { join } from "node:path";

const CHROMA_PATH = join(homedir(), ".claudechat", "chroma");

let client: ChromaClient | null = null;
let collection: Collection | null = null;

export async function getVectorStore(): Promise<Collection> {
  if (collection) return collection;

  client = new ChromaClient({
    path: `file://${CHROMA_PATH}`,
  });

  collection = await client.getOrCreateCollection({
    name: "messages",
    metadata: { "hnsw:space": "cosine" },
  });

  return collection;
}

export interface VectorEntry {
  id: string;
  content: string;
  metadata: {
    channel_id: string;
    sender_repo: string;
    type: string;
    created_at: string;
  };
}

export async function addToVectorStore(entries: VectorEntry[]): Promise<void> {
  const store = await getVectorStore();

  await store.add({
    ids: entries.map((e) => e.id),
    documents: entries.map((e) => e.content),
    metadatas: entries.map((e) => e.metadata),
  });
}

export async function semanticSearch(
  query: string,
  opts?: { channel?: string; limit?: number }
): Promise<VectorEntry[]> {
  const store = await getVectorStore();
  const limit = opts?.limit ?? 10;

  const where = opts?.channel
    ? { channel_id: { $eq: opts.channel } }
    : undefined;

  const results = await store.query({
    queryTexts: [query],
    nResults: limit,
    where: where as any,
  });

  if (!results.ids[0] || results.ids[0].length === 0) return [];

  return results.ids[0].map((id, i) => ({
    id,
    content: results.documents[0][i] ?? "",
    metadata: (results.metadatas[0][i] as VectorEntry["metadata"]) ?? {
      channel_id: "",
      sender_repo: "",
      type: "",
      created_at: "",
    },
  }));
}
