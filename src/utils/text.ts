export interface TruncateOptions {
  /** 是否啟用 verbose 模式（不截斷） */
  verbose?: boolean;
  /** 前段保留字數，預設 100 */
  headLength?: number;
  /** 後段保留字數，預設 100 */
  tailLength?: number;
}

/**
 * 截斷文字，保留前後段落
 * 格式: "前100字...後100字"
 */
export function truncate(text: string, options: TruncateOptions = {}): string {
  const { verbose = false, headLength = 100, tailLength = 100 } = options;

  // verbose 模式不截斷
  if (verbose) return text;

  const threshold = headLength + tailLength + 10;
  if (text.length <= threshold) return text;

  const head = text.slice(0, headLength);
  const tail = text.slice(-tailLength);
  return `${head}...${tail}`;
}

/**
 * 將 content 轉為字串（處理物件/陣列情況）
 */
export function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          // 處理 { type: 'text', text: '...' } 格式
          if ('text' in item && typeof item.text === 'string') return item.text;
          // 處理 { type: 'tool_result', content: '...' } 格式
          if ('content' in item && typeof item.content === 'string') return item.content;
          // 處理其他 type
          if ('type' in item) return `[${item.type}]`;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }

  // 物件情況
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if ('text' in obj && typeof obj.text === 'string') return obj.text;
    if ('content' in obj && typeof obj.content === 'string') return obj.content;
    return JSON.stringify(content);
  }

  return String(content);
}

/**
 * 格式化多行內容
 * 單行 → 直接回傳 " content"
 * 多行 → 換行後每行加 4 空格縮排
 */
export function formatMultiline(content: string, indent: string = '    '): string {
  if (!content.includes('\n')) {
    return ` ${content}`;
  }

  const lines = content.split('\n');
  const indentedLines = lines.map((line) => `${indent}${line}`);
  return `\n${indentedLines.join('\n')}`;
}
