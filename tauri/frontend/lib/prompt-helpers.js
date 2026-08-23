/** Pure prompt helpers shared by renderer and tests. */

function normalizePrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return null;
  const name = String(prompt.name ?? "").trim();
  const content = String(prompt.content ?? "").trim();
  if (!name || !content) return null;
  return {
    name,
    tag: typeof prompt.tag === "string" ? prompt.tag.trim() : "",
    content,
    isPinned: prompt.isPinned === true,
    useCount: Math.max(0, Number(prompt.useCount || 0)),
    lastUsedAt:
      typeof prompt.lastUsedAt === "string" ? prompt.lastUsedAt.trim() : "",
  };
}

function sanitizePromptList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => normalizePrompt(item)).filter(Boolean);
}

function promptIdentityKey(prompt) {
  const name = String(prompt?.name || "").trim().toLowerCase();
  const content = String(prompt?.content || "").trim().toLowerCase();
  return `${name}\n${content}`;
}

function mergePromptLists(existing, incoming) {
  const base = sanitizePromptList(existing);
  const next = sanitizePromptList(incoming);
  const seen = new Set(base.map((item) => promptIdentityKey(item)));
  let added = 0;
  let skipped = 0;
  for (const item of next) {
    const key = promptIdentityKey(item);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    base.push(item);
    added += 1;
  }
  return { prompts: base, added, skipped };
}

function parseMarkdownPrompts(raw) {
  const source = String(raw || "").replace(/^\uFEFF/, "").trim();
  if (!source) return [];

  const lines = source.split(/\r?\n/);
  const blocks = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const name = String(current.name || "").trim();
    const content = String(current.content || "").trim();
    if (name && content) {
      blocks.push({
        name,
        tag: String(current.tag || "").trim(),
        content,
        isPinned: false,
        useCount: 0,
        lastUsedAt: "",
      });
    }
    current = null;
  };

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flush();
      current = { name: heading[1].trim(), tag: "", content: "" };
      continue;
    }
    if (!current) continue;

    const tagLine = line.match(/^标签\s*[:：]\s*(.+)$/i) || line.match(/^tag\s*[:：]\s*(.+)$/i);
    if (tagLine && !current.content.trim()) {
      current.tag = tagLine[1].trim();
      continue;
    }

    current.content = current.content ? `${current.content}\n${line}` : line;
  }
  flush();

  // Fallback: treat whole file as one prompt when no headings found.
  if (blocks.length === 0) {
    const firstLine = lines.find((line) => line.trim()) || "导入提示词";
    const name = firstLine.replace(/^#+\s*/, "").trim().slice(0, 40) || "导入提示词";
    const content = source.trim();
    if (content) {
      blocks.push({
        name,
        tag: "imported",
        content,
        isPinned: false,
        useCount: 0,
        lastUsedAt: "",
      });
    }
  }

  return sanitizePromptList(blocks);
}

function parseCsvRows(raw) {
  const source = String(raw || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    if (ch === "\r") continue;
    field += ch;
  }

  row.push(field);
  if (row.some((cell) => String(cell).trim() !== "")) rows.push(row);
  return rows;
}

function parseCsvPrompts(raw) {
  const rows = parseCsvRows(raw);
  if (rows.length === 0) return [];

  const normalizeHeader = (value) =>
    String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");

  const header = rows[0].map(normalizeHeader);
  const looksLikeHeader = header.some((cell) =>
    ["name", "title", "content", "prompt", "tag", "tags", "category", "名称", "标题", "内容", "提示词", "标签", "分类"].includes(cell),
  );

  let dataRows = rows;
  let nameIdx = 0;
  let tagIdx = 1;
  let contentIdx = 2;

  if (looksLikeHeader) {
    dataRows = rows.slice(1);
    const findIdx = (candidates) =>
      header.findIndex((cell) => candidates.includes(cell));
    nameIdx = findIdx(["name", "title", "名称", "标题"]);
    tagIdx = findIdx(["tag", "tags", "category", "标签", "分类"]);
    contentIdx = findIdx(["content", "prompt", "body", "内容", "提示词"]);
    if (nameIdx < 0) nameIdx = 0;
    if (contentIdx < 0) contentIdx = Math.max(header.length - 1, 1);
    if (tagIdx < 0) tagIdx = -1;
  }

  const prompts = dataRows.map((row) => {
    const name = String(row[nameIdx] ?? "").trim();
    const content = String(row[contentIdx] ?? "").trim();
    const tag = tagIdx >= 0 ? String(row[tagIdx] ?? "").trim() : "";
    return {
      name: name || content.slice(0, 40) || "导入提示词",
      tag,
      content,
      isPinned: false,
      useCount: 0,
      lastUsedAt: "",
    };
  });

  return sanitizePromptList(prompts);
}

function extractPromptsFromImport(raw, format = "json") {
  if (format === "markdown") {
    return parseMarkdownPrompts(raw);
  }
  if (format === "csv") {
    return parseCsvPrompts(raw);
  }
  const parsed = JSON.parse(String(raw || ""));
  const prompts = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.prompts)
      ? parsed.prompts
      : null;
  if (!prompts) {
    throw new Error("文件格式错误：必须是提示词数组，或包含 prompts 数组的备份文件");
  }
  return sanitizePromptList(prompts);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tokenizeSearchTerm(term) {
  return String(term || "")
    .toLowerCase()
    .trim()
    // 半角/全角空白都拆词，中文多词搜索更稳。
    .split(/[\s\u3000]+/)
    .filter(Boolean);
}

function promptSearchHaystack(item) {
  return [
    String(item?.name || "").toLowerCase(),
    normalizeTag(item?.tag).toLowerCase(),
    String(item?.content || "").toLowerCase(),
  ].join("\n");
}

function promptMatchesSearch(item, term) {
  const raw = String(term || "").toLowerCase().trim();
  if (!raw) return true;
  const haystack = promptSearchHaystack(item);
  if (haystack.includes(raw)) return true;
  const tokens = tokenizeSearchTerm(raw);
  if (tokens.length === 0) return true;
  return tokens.every((token) => haystack.includes(token));
}

function highlightMatch(text, term) {
  const source = String(text ?? "");
  const tokens = [...new Set(tokenizeSearchTerm(term))].sort(
    (a, b) => b.length - a.length,
  );
  if (tokens.length === 0) return escapeHtml(source);

  const lower = source.toLowerCase();
  const ranges = [];
  for (const token of tokens) {
    if (!token) continue;
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(token, from);
      if (idx === -1) break;
      ranges.push([idx, idx + token.length]);
      from = idx + token.length;
    }
  }
  if (ranges.length === 0) return escapeHtml(source);

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (!last || range[0] > last[1]) {
      merged.push(range);
    } else {
      last[1] = Math.max(last[1], range[1]);
    }
  }

  let out = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    out += escapeHtml(source.slice(cursor, start));
    out += `<mark class="search-mark">${escapeHtml(source.slice(start, end))}</mark>`;
    cursor = end;
  }
  out += escapeHtml(source.slice(cursor));
  return out;
}

function clonePromptList(list) {
  return sanitizePromptList(list).map((item) => ({ ...item }));
}

function toTimestamp(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function formatRelativeTime(value) {
  const timestamp = toTimestamp(value);
  if (!timestamp) return "最近未使用";
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return "刚刚使用";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / (60 * 1000))} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
  if (diff < 30 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / (24 * 60 * 60 * 1000))} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN");
}

function getUsageSummary(item) {
  const count = Math.max(0, Number(item?.useCount || 0));
  return {
    useText: count > 0 ? `已使用 ${count} 次` : "尚未使用",
    lastUsedText: formatRelativeTime(item?.lastUsedAt),
  };
}

function normalizeTag(tag) {
  return typeof tag === "string" ? tag.trim() : "";
}

function comparePromptsForUse(a, b) {
  const lastUsedDiff = toTimestamp(b.lastUsedAt) - toTimestamp(a.lastUsedAt);
  if (lastUsedDiff !== 0) return lastUsedDiff;
  const useCountDiff = Math.max(0, Number(b.useCount || 0)) - Math.max(0, Number(a.useCount || 0));
  if (useCountDiff !== 0) return useCountDiff;
  return String(a.name || "").localeCompare(String(b.name || ""), "zh-CN");
}

function scoreTokenAgainstPrompt(item, token) {
  if (!token) return 0;
  const name = String(item?.name || "").toLowerCase();
  const tag = normalizeTag(item?.tag).toLowerCase();
  const content = String(item?.content || "").toLowerCase();
  let score = 0;

  if (name === token) score += 1000;
  else if (name.startsWith(token)) score += 520;
  else if (name.includes(token)) score += 320;

  if (tag === token) score += 220;
  else if (tag.startsWith(token)) score += 140;
  else if (tag.includes(token)) score += 90;

  if (content.includes(token)) {
    score += 45;
    const idx = content.indexOf(token);
    if (idx >= 0 && idx < 48) score += 25;
  }
  return score;
}

function scorePromptMatch(item, term) {
  if (!term) return 0;
  const raw = String(term).toLowerCase().trim();
  if (!raw || !promptMatchesSearch(item, raw)) return 0;

  const tokens = tokenizeSearchTerm(raw);
  let score = scoreTokenAgainstPrompt(item, raw);

  if (tokens.length > 1) {
    // 多词查询：每个词都要有贡献，名称里同时命中时再加分。
    for (const token of tokens) {
      score += scoreTokenAgainstPrompt(item, token);
    }
    const name = String(item?.name || "").toLowerCase();
    if (tokens.every((token) => name.includes(token))) score += 180;
  }

  if (item?.isPinned) score += 18;
  score += Math.min(40, Math.max(0, Number(item?.useCount || 0)) * 2);
  if (toTimestamp(item?.lastUsedAt) > 0) {
    const days = (Date.now() - toTimestamp(item.lastUsedAt)) / (24 * 60 * 60 * 1000);
    if (days < 1) score += 24;
    else if (days < 7) score += 14;
    else if (days < 30) score += 6;
  }
  return score;
}

function comparePromptsForSearch(a, b, term) {
  const scoreDiff = scorePromptMatch(b, term) - scorePromptMatch(a, term);
  if (scoreDiff !== 0) return scoreDiff;
  if (Boolean(a?.isPinned) !== Boolean(b?.isPinned)) {
    return a?.isPinned ? -1 : 1;
  }
  return comparePromptsForUse(a, b);
}

function markPromptUsed(prompt) {
  if (!prompt || typeof prompt !== "object") return;
  prompt.useCount = Math.max(0, Number(prompt.useCount || 0)) + 1;
  prompt.lastUsedAt = new Date().toISOString();
}

function formatPromptAsMarkdown(prompt) {
  const item = normalizePrompt(prompt);
  if (!item) return "";
  const lines = [`# ${item.name}`];
  if (item.tag) lines.push(`标签: ${item.tag}`);
  lines.push("", item.content, "");
  return lines.join("\n");
}

function formatPromptAsJson(prompt) {
  const item = normalizePrompt(prompt);
  if (!item) return "";
  return JSON.stringify(
    {
      name: item.name,
      tag: item.tag,
      content: item.content,
      isPinned: item.isPinned === true,
    },
    null,
    2,
  );
}

function formatPromptShareText(prompt, format = "markdown") {
  if (format === "json") return formatPromptAsJson(prompt);
  return formatPromptAsMarkdown(prompt);
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatPromptsAsMarkdown(list) {
  const prompts = sanitizePromptList(list);
  if (prompts.length === 0) return "";
  return prompts
    .map((item) => formatPromptAsMarkdown(item).trimEnd())
    .join("\n\n")
    .trim() + "\n";
}

function formatPromptsAsCsv(list) {
  const prompts = sanitizePromptList(list);
  const header = ["name", "tag", "content"].join(",");
  const rows = prompts.map((item) =>
    [item.name, item.tag, item.content].map(escapeCsvCell).join(","),
  );
  return [header, ...rows].join("\n") + (rows.length ? "\n" : "");
}

function formatPromptsAsJson(list) {
  return JSON.stringify(sanitizePromptList(list), null, 2);
}

function detectImportFormatFromPath(filePath = "") {
  const ext = String(filePath || "").toLowerCase().split(".").pop() || "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv") return "csv";
  return "json";
}


function getDefaultSamplePrompts() {
  return [
    {
      name: "文章润色专家",
      tag: "writing",
      content:
        "请将下面的文本润色为更通顺、更专业的中文，同时保留原意并给出三种不同风格（正式、亲切、技术性）的改写版本。",
      isPinned: true,
    },
    {
      name: "Tailwind 助手",
      tag: "coding",
      content:
        "根据下面的 UI 描述，生成对应的 Tailwind CSS 类名与简短示例 HTML，包含响应式样式和可访问性建议。",
      isPinned: false,
    },
    {
      name: "市场文案生成器",
      tag: "marketing",
      content:
        "为一款目标用户为职场人士的时间管理工具，生成三条不同角度的产品宣传文案（简洁、情感、功能导向），并包含一句 30 字以内的广告语。",
      isPinned: false,
    },
  ];
}

export {
  normalizePrompt,
  sanitizePromptList,
  promptIdentityKey,
  mergePromptLists,
  parseMarkdownPrompts,
  parseCsvRows,
  parseCsvPrompts,
  extractPromptsFromImport,
  escapeHtml,
  tokenizeSearchTerm,
  promptMatchesSearch,
  highlightMatch,
  clonePromptList,
  normalizeTag,
  toTimestamp,
  formatRelativeTime,
  getUsageSummary,
  comparePromptsForUse,
  scorePromptMatch,
  comparePromptsForSearch,
  markPromptUsed,
  formatPromptAsMarkdown,
  formatPromptAsJson,
  formatPromptShareText,
  escapeCsvCell,
  formatPromptsAsMarkdown,
  formatPromptsAsCsv,
  formatPromptsAsJson,
  detectImportFormatFromPath,
  getDefaultSamplePrompts,
};
