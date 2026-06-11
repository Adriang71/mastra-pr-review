import { mastra } from './mastra/index.js';

const question = process.argv[2] ?? 'What is the attention mechanism described in the paper?';

async function main() {
  const agent = mastra.getAgent('researchAgent');

  console.log(`Question: ${question}\n`);
  console.log('Answer:');

  const response = await agent.stream([{ role: 'user', content: question }]);

  for await (const chunk of response.textStream) {
    process.stdout.write(chunk);
  }
  console.log('\n');
}

main().catch(console.error);
