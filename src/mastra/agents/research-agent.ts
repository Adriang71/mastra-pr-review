import { Agent } from '@mastra/core/agent';
import { createVectorQueryTool } from '@mastra/rag';
import { fastembed } from '@mastra/fastembed';

const vectorQueryTool = createVectorQueryTool({
  vectorStoreName: 'researchVectors',
  indexName: 'papers',
  model: fastembed.small,
});

export const researchAgent = new Agent({
  id: 'research-agent',
  name: 'Research Assistant',
  instructions: `You are a helpful research assistant with access to academic papers stored in a vector database.

When answering questions:
- Use the vectorQueryTool to search for relevant content in the papers
- Ground your answers in the retrieved context
- Cite specific sections or concepts when relevant
- If the information is not found in the database, say so clearly
- Keep answers accurate and informative`,
  model: 'groq/llama-3.3-70b-versatile',
  tools: { vectorQueryTool },
});
