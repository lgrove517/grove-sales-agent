const fetch = require('node-fetch');

const API_URL = 'https://api.anthropic.com/v1/messages';

/**
 * Thin wrapper around the Claude Messages API. When ANTHROPIC_API_KEY is
 * not set, returns a clearly-labeled DRY_RUN stub instead of calling out -
 * this lets the whole agent pipeline be exercised end-to-end (routing,
 * logging, GHL calls) before real credentials exist.
 */
async function askClaude({ system, messages, maxTokens = 800 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

  if (!apiKey) {
    return {
      dryRun: true,
      text:
        `[DRY_RUN - no ANTHROPIC_API_KEY set] Would have asked Claude (${model}) ` +
        `with system prompt (${system.length} chars) and ${messages.length} message(s). ` +
        `Last user message: "${messages[messages.length - 1]?.content?.slice(0, 200)}"`,
    };
  }

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return { dryRun: false, text, raw: data };
}

module.exports = { askClaude };
