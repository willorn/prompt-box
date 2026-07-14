import assert from "node:assert/strict";
import {
  parseCsvPrompts,
  parseMarkdownPrompts,
  mergePromptLists,
  highlightMatch,
  scorePromptMatch,
  comparePromptsForSearch,
  extractPromptsFromImport,
  formatPromptShareText,
  formatPromptAsMarkdown,
  formatPromptsAsMarkdown,
  formatPromptsAsCsv,
  formatPromptsAsJson,
  detectImportFormatFromPath,
  getDefaultSamplePrompts,
  promptMatchesSearch,
  tokenizeSearchTerm,
} from "../lib/prompt-helpers.js";

// CSV with quotes
const csv = `name,tag,content\n文章润色专家,writing,"请润色,并保留原意"\nTailwind 助手,coding,生成类名\n`;
const csvPrompts = parseCsvPrompts(csv);
assert.equal(csvPrompts.length, 2);
assert.equal(csvPrompts[0].content, "请润色,并保留原意");

// Markdown headings
const md = `# 文章润色专家\n标签: writing\n请润色下面的文本\n\n## Tailwind 助手\ntag: coding\n生成 tailwind 类名\n`;
const mdPrompts = parseMarkdownPrompts(md);
assert.equal(mdPrompts.length, 2);
assert.equal(mdPrompts[0].tag, "writing");

// Merge dedupe
const merged = mergePromptLists(
  [{ name: "文章润色专家", content: "请润色下面的文本", tag: "writing" }],
  mdPrompts,
);
assert.equal(merged.added, 1);
assert.equal(merged.skipped, 1);
assert.equal(merged.prompts.length, 2);

// Highlight
const hl = highlightMatch("文章润色专家", "润色");
assert.ok(hl.includes('<mark class="search-mark">润色</mark>'));

// Search score: exact name first
const items = [
  { name: "润色", tag: "writing", content: "简短", useCount: 0, lastUsedAt: "" },
  { name: "文章润色专家", tag: "writing", content: "润色文本", useCount: 5, lastUsedAt: "" },
  { name: "市场文案", tag: "marketing", content: "写文案", useCount: 1, lastUsedAt: "" },
];
const ranked = [...items].sort((a, b) => comparePromptsForSearch(a, b, "润色"));
assert.equal(ranked[0].name, "润色");
assert.ok(scorePromptMatch(ranked[0], "润色") > scorePromptMatch(ranked[1], "润色"));

// JSON extract
const jsonPrompts = extractPromptsFromImport(
  JSON.stringify({ prompts: [{ name: "X", content: "Y", tag: "t" }] }),
  "json",
);
assert.equal(jsonPrompts.length, 1);
assert.equal(jsonPrompts[0].name, "X");

// Share formats
const sharedMd = formatPromptAsMarkdown({
  name: "文章润色专家",
  tag: "writing",
  content: "请润色下面的文本",
});
assert.ok(sharedMd.startsWith("# 文章润色专家"));
assert.ok(sharedMd.includes("标签: writing"));
assert.ok(sharedMd.includes("请润色下面的文本"));
const sharedJson = formatPromptShareText(
  { name: "X", tag: "t", content: "Y" },
  "json",
);
assert.ok(sharedJson.includes('"name": "X"'));
assert.ok(sharedJson.includes('"content": "Y"'));

// Empty / invalid inputs
assert.equal(parseCsvPrompts("").length, 0);
assert.equal(parseMarkdownPrompts("").length, 0);
assert.throws(() => extractPromptsFromImport("{bad", "json"));

// CSV without header (name,tag,content order)
const csvNoHeader = `润色助手,writing,请润色文本\n代码助手,coding,写函数\n`;
const noHeader = parseCsvPrompts(csvNoHeader);
assert.equal(noHeader.length, 2);
assert.equal(noHeader[0].name, "润色助手");
assert.equal(noHeader[0].tag, "writing");

// Exact title match ranks above partial content match
const rankedExact = [
  { name: "其他", tag: "", content: "包含润色二字", useCount: 99, lastUsedAt: "" },
  { name: "润色", tag: "", content: "短", useCount: 0, lastUsedAt: "" },
].sort((a, b) => comparePromptsForSearch(a, b, "润色"));
assert.equal(rankedExact[0].name, "润色");

// Highlight escapes HTML and still marks
const dangerous = highlightMatch("<b>润色</b>", "润色");
assert.ok(dangerous.includes("&lt;b&gt;"));
assert.ok(dangerous.includes('<mark class="search-mark">润色</mark>'));

// Merge keeps existing metadata fields via sanitize
const mergedMeta = mergePromptLists(
  [{ name: "A", content: "1", tag: "t", useCount: 3, lastUsedAt: "2026-01-01T00:00:00.000Z" }],
  [{ name: "A", content: "1", tag: "t" }, { name: "B", content: "2", tag: "t" }],
);
assert.equal(mergedMeta.added, 1);
assert.equal(mergedMeta.skipped, 1);
assert.equal(mergedMeta.prompts[0].useCount, 3);

// Bulk export formats
const bulk = [
  { name: 'A', tag: 't', content: 'hello, world' },
  { name: 'B', tag: '', content: 'line1\nline2' },
];
const mdBulk = formatPromptsAsMarkdown(bulk);
assert.ok(mdBulk.includes('# A'));
assert.ok(mdBulk.includes('# B'));
const csvBulk = formatPromptsAsCsv(bulk);
assert.ok(csvBulk.startsWith('name,tag,content'));
assert.ok(csvBulk.includes('"hello, world"'));
const jsonBulk = formatPromptsAsJson(bulk);
assert.equal(JSON.parse(jsonBulk).length, 2);
assert.equal(detectImportFormatFromPath('a.MD'), 'markdown');
assert.equal(detectImportFormatFromPath('b.csv'), 'csv');
assert.equal(detectImportFormatFromPath('c.json'), 'json');

// multi-token search
assert.deepEqual(tokenizeSearchTerm("  文章  润色 "), ["文章", "润色"]);
assert.deepEqual(tokenizeSearchTerm("文章\u3000润色"), ["文章", "润色"]);
const multiItem = {
  name: "文章润色专家",
  tag: "writing",
  content: "请润色下面的文本",
};
assert.equal(promptMatchesSearch(multiItem, "文章 润色"), true);
assert.equal(promptMatchesSearch(multiItem, "文章 coding"), false);
const multiRanked = [
  { name: "市场文案", tag: "marketing", content: "写宣传", useCount: 9, lastUsedAt: "" },
  { name: "文章润色专家", tag: "writing", content: "请润色文本", useCount: 1, lastUsedAt: "" },
].sort((a, b) => comparePromptsForSearch(a, b, "文章 润色"));
assert.equal(multiRanked[0].name, "文章润色专家");
const multiHl = highlightMatch("文章润色专家", "文章 润色");
// 相邻命中会合并成一段 mark，这是预期行为。
assert.ok(
  multiHl.includes('<mark class="search-mark">文章润色</mark>') ||
    (multiHl.includes('<mark class="search-mark">文章</mark>') &&
      multiHl.includes('<mark class="search-mark">润色</mark>')),
);
const multiHlSpread = highlightMatch("文章与润色助手", "文章 润色");
assert.ok(multiHlSpread.includes('<mark class="search-mark">文章</mark>'));
assert.ok(multiHlSpread.includes('<mark class="search-mark">润色</mark>'));


// default sample seeds
const samples = getDefaultSamplePrompts();
assert.ok(Array.isArray(samples) && samples.length >= 1);
for (const item of samples) {
  assert.ok(item.name && item.content);
}

console.log("prompt-helpers tests passed");

