import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPromptsAsMarkdown, parseMarkdownPrompts } from '../src/lib/prompt-helpers.js';
const lines = (...values) => values.join(String.fromCharCode(10));

test('Markdown export preserves body headings, tags and nested fences', () => {
  const prompts = [
    { name: 'Demo', tag: 'coding', content: lines('tag: body text', '# Body heading', '## Requirements', '### Details', 'Only output JSON', '', '~~~markdown', '# Sample', '~~~', '', '~~~~promptbox-content', 'Nested content', '~~~~') },
    { name: 'Second', tag: '', content: lines('# First body line', 'Content') },
  ];
  const restored = parseMarkdownPrompts(formatPromptsAsMarkdown(prompts));
  assert.deepEqual(restored.map(({ name, tag, content }) => ({ name, tag, content })), prompts);
});

test('ordinary fenced code does not create prompt records', () => {
  const content = lines('Before', '~~~markdown', '## Code heading', '~~~', 'After');
  const restored = parseMarkdownPrompts(lines('# Demo', content, '', '## Next', 'Next body'));
  assert.equal(restored.length, 2);
  assert.equal(restored[0].content, content);
  assert.equal(restored[1].name, 'Next');
});
