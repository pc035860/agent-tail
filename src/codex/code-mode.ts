/**
 * Codex "code mode" 解析工具
 *
 * gpt-5.6 起 Codex 不再逐一發出 `function_call`，而是把所有工具呼叫包進一個
 * 名為 `exec` 的 custom tool，input 是一段 JS：
 *
 *   const r = await tools.exec_command({"cmd":"git status","workdir":"/x"});
 *   text(r.output);
 *
 * 這裡負責從那段 JS 還原出原本的工具名與參數，讓顯示層與 subagent 偵測
 * 可以沿用既有的 function_call 邏輯。
 */

export interface CodeModeCall {
  /** 還原後的工具名，例如 exec_command / update_plan / spawn_agent */
  name: string;
  /** 解析出的參數；無法完整解析時只含可辨識的 top-level 字串欄位 */
  args: Record<string, unknown>;
  /** 參數的原始文字（不含外層括號） */
  rawArgs: string;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[\w$]/;

/**
 * 從 index 開始跳過一個字串字面量，回傳結束引號的下一個 index
 */
function skipString(src: string, start: number): number {
  const quote = src[start]!;
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * 從左括號位置開始做平衡掃描，回傳對應右括號的 index（找不到回傳 -1）
 * 會正確跳過字串字面量內的括號
 */
function findMatching(src: string, openIndex: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [pairs[src[openIndex]!]!];
  let i = openIndex + 1;

  while (i < src.length && stack.length > 0) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(src, i);
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      stack.push(pairs[ch]!);
      i++;
      continue;
    }
    if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
      i++;
      continue;
    }
    i++;
  }

  return -1;
}

/**
 * 寬鬆解析物件字面量：JSON.parse 失敗時（key 未加引號等），
 * 只抽出 top-level 的字串型欄位供顯示使用
 */
function lenientParseObject(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const body = raw.trim();
  if (!body.startsWith('{')) return result;

  let i = 1;
  const end = body.length - 1;

  while (i < end) {
    const ch = body[i]!;

    // 跳過空白與逗號
    if (/\s|,/.test(ch)) {
      i++;
      continue;
    }

    // 讀 key（可能有引號）
    let key: string;
    if (ch === '"' || ch === "'") {
      const keyEnd = skipString(body, i);
      key = body.slice(i + 1, keyEnd - 1);
      i = keyEnd;
    } else if (IDENT_START.test(ch)) {
      let j = i;
      while (j < end && IDENT_CHAR.test(body[j]!)) j++;
      key = body.slice(i, j);
      i = j;
    } else {
      // 非預期字元，放棄後續解析
      break;
    }

    // 跳到冒號
    while (i < end && /\s/.test(body[i]!)) i++;
    if (body[i] !== ':') break;
    i++;
    while (i < end && /\s/.test(body[i]!)) i++;

    // 讀值
    const valueChar = body[i];
    if (valueChar === '"' || valueChar === "'" || valueChar === '`') {
      const strEnd = skipString(body, i);
      const literal = body.slice(i, strEnd);
      try {
        // 統一轉成雙引號字串再交給 JSON.parse 處理跳脫序列
        result[key] =
          literal[0] === '"'
            ? JSON.parse(literal)
            : JSON.parse(`"${literal.slice(1, -1).replace(/"/g, '\\"')}"`);
      } catch {
        result[key] = literal.slice(1, -1);
      }
      i = strEnd;
    } else if (valueChar === '{' || valueChar === '[') {
      const close = findMatching(body, i);
      if (close < 0) break;
      const nested = body.slice(i, close + 1);
      try {
        result[key] = JSON.parse(nested);
      } catch {
        result[key] = nested;
      }
      i = close + 1;
    } else {
      // 數字 / boolean / 識別字：讀到下一個 top-level 逗號
      let j = i;
      while (j < end && body[j] !== ',') j++;
      const rawValue = body.slice(i, j).trim();
      result[key] = rawValue;
      i = j;
    }
  }

  return result;
}

/**
 * 從 exec input（一段 JS）中解析所有 `tools.xxx({...})` 呼叫
 *
 * 只在程式碼區段偵測，字串字面量內的 `tools.foo(` 不會被誤判
 */
export function parseCodeModeCalls(input: string): CodeModeCall[] {
  if (!input || !input.includes('tools.')) return [];

  const calls: CodeModeCall[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;

    // 跳過字串字面量
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(input, i);
      continue;
    }

    // 跳過註解
    if (ch === '/' && input[i + 1] === '/') {
      const nl = input.indexOf('\n', i);
      i = nl < 0 ? input.length : nl;
      continue;
    }
    if (ch === '/' && input[i + 1] === '*') {
      const close = input.indexOf('*/', i + 2);
      i = close < 0 ? input.length : close + 2;
      continue;
    }

    if (!input.startsWith('tools.', i)) {
      i++;
      continue;
    }

    // 讀工具名
    let j = i + 'tools.'.length;
    const nameStart = j;
    while (j < input.length && IDENT_CHAR.test(input[j]!)) j++;
    const name = input.slice(nameStart, j);
    if (!name) {
      i = j + 1;
      continue;
    }

    // 後面必須是左括號才算呼叫
    let k = j;
    while (k < input.length && /\s/.test(input[k]!)) k++;
    if (input[k] !== '(') {
      i = j;
      continue;
    }

    const close = findMatching(input, k);
    if (close < 0) {
      i = k + 1;
      continue;
    }

    const rawArgs = input.slice(k + 1, close).trim();
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawArgs);
      args =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { value: parsed };
    } catch {
      args = lenientParseObject(rawArgs);
    }

    calls.push({ name, args, rawArgs });
    i = close + 1;
  }

  return calls;
}

/**
 * custom_tool_call_output.output 是 `[{type:'input_text', text}]` 陣列
 * （舊版 function_call_output 則是 JSON 字串），統一轉成純文字
 */
export function joinCustomToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return '';
  return output
    .map((part) =>
      part && typeof part === 'object'
        ? ((part as { text?: string }).text ?? '')
        : typeof part === 'string'
          ? part
          : ''
    )
    .filter(Boolean)
    .join('');
}

/**
 * exec_command 的結果在 code mode 下是被 `text()` 印出的 JSON 字串
 * （`{"chunk_id":...,"exit_code":0,"output":"..."}`），拆出真正的 stdout，
 * 讓顯示品質與舊版 function_call_output 一致。
 *
 * JSON 之前可能有 codex 自己加的警告文字（例如 truncated output），保留之。
 */
export function unwrapExecOutput(text: string): string {
  const braceIndex = text.indexOf('{');
  if (braceIndex < 0) return text;

  try {
    const parsed = JSON.parse(text.slice(braceIndex));
    if (!parsed || typeof parsed !== 'object') return text;
    const { output, exit_code: exitCode } = parsed as {
      output?: unknown;
      exit_code?: unknown;
    };
    if (typeof output !== 'string') return text;

    const prefix = text.slice(0, braceIndex);
    const exitInfo =
      typeof exitCode === 'number' && exitCode !== 0
        ? `[exit: ${exitCode}]`
        : '';
    return `${prefix}${exitInfo}${output}`;
  } catch {
    return text;
  }
}

const SCRIPT_HEADER_RE =
  /^Script completed\nWall time [\d.]+ seconds\nOutput:\n?/;

/**
 * 移除 code mode 輸出開頭的 `Script completed / Wall time / Output:` 樣板，
 * 讓實際輸出不被樣板佔掉截斷行數。非標準開頭（例如錯誤訊息）原樣保留。
 */
export function stripScriptHeader(text: string): string {
  return text.replace(SCRIPT_HEADER_RE, '');
}

/**
 * 把 custom_tool_call_output 整理成可讀文字：
 * 逐段剝掉 script 樣板、拆出 exec_command 的 stdout，再串接
 */
export function formatCustomToolOutput(output: unknown): string {
  const parts = Array.isArray(output) ? output : [output];
  return parts
    .map((part) => joinCustomToolOutput([part]))
    .map((text) => unwrapExecOutput(stripScriptHeader(text)))
    .filter((text) => text.trim())
    .join('');
}
