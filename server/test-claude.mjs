
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

async function testClaude() {
  const response = await client.messages.create({
    model: 'claude-haiku-5-5',
    max_tokens: 128,
    messages: [
      {
        role: 'user',
        content: `
You are the AI assistant for Access OS.

The user says: "Find more information about this domain."

Available webpage elements:
[
  { "id": 1, "text": "Learn more", "role": "link" },
  { "id": 2, "text": "Sign in", "role": "button" },
  { "id": 3, "text": "Contact support", "role": "link" }
]

Choose the element that best matches the request.

Respond ONLY with JSON:
{"action":"click","elementId":1}

If nothing matches, return:
{"action":"none","elementId":null}
`
      }
    ]
  });

  for (const block of response.content) {
    if (block.type === 'text') {
      console.log(block.text);
    }
  }
}

testClaude().catch(console.error);
