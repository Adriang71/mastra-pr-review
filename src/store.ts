import { MDocument } from '@mastra/rag';
import { fastembed } from '@mastra/fastembed';
import { LibSQLVector } from '@mastra/libsql';

const PAPER_URL = 'https://arxiv.org/abs/1706.03762';
const INDEX_NAME = 'papers';
const DIMENSIONS = 384; // bge-small-en-v1.5
const BATCH_SIZE = 256; // fastembed.small maxEmbeddingsPerCall

async function embedInBatches(texts: string[]): Promise<number[][]> {
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const { embeddings } = await fastembed.small.doEmbed({ values: batch });
    allEmbeddings.push(...embeddings);
    console.log(`  Embedded ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length} chunks`);
  }
  return allEmbeddings;
}

async function main() {
  console.log('Fetching paper from arXiv...');
  const response = await fetch(PAPER_URL);
  const html = await response.text();

  console.log('Chunking document...');
  const doc = MDocument.fromHTML(html);
  const chunks = await doc.chunk({ strategy: 'recursive', maxSize: 512, overlap: 50 });
  console.log(`Created ${chunks.length} chunks`);

  console.log('Generating embeddings...');
  const texts = chunks.map(c => c.text);
  const embeddings = await embedInBatches(texts);

  console.log('Storing vectors in LibSQL...');
  const vectorStore = new LibSQLVector({
    id: 'research-vectors',
    url: 'file:./vector.db',
  });

  await vectorStore.createIndex({ indexName: INDEX_NAME, dimension: DIMENSIONS });

  await vectorStore.upsert({
    indexName: INDEX_NAME,
    vectors: embeddings,
    metadata: chunks.map(c => ({ text: c.text, ...c.metadata })),
  });

  console.log(`Done! Stored ${embeddings.length} vectors in index "${INDEX_NAME}".`);
}

main().catch(console.error);
