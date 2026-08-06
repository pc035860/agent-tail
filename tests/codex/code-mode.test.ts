import { describe, test, expect } from 'bun:test';
import {
  formatCustomToolOutput,
  joinCustomToolOutput,
  parseCodeModeCalls,
  stripScriptHeader,
  unwrapExecOutput,
} from '../../src/codex/code-mode';
import { CodexAgent } from '../../src/agents/codex/codex-agent';

// 取自真實 session（gpt-5.6-sol, cli 0.146.0）
const REAL_EXEC_INPUT =
  'const r = await tools.exec_command({"cmd":"git show --stat HEAD","workdir":"/tmp/x","yield_time_ms":10000,"max_output_tokens":50000});\ntext(r.output);\n';

const REAL_MULTI_CALL_INPUT =
  'const p = await tools.update_plan({plan:[\n  {step:"讀取規範",status:"in_progress"},\n  {step:"審查",status:"pending"}\n]});\nconst r = await tools.exec_command({cmd:"pwd && ls",workdir:"/tmp/x",yield_time_ms:10000});\ntext(JSON.stringify(p)); text(r.output);\n';

describe('parseCodeModeCalls', () => {
  test('解析 JSON 形式的參數', () => {
    const calls = parseCodeModeCalls(REAL_EXEC_INPUT);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('exec_command');
    expect(calls[0]!.args.cmd).toBe('git show --stat HEAD');
    expect(calls[0]!.args.workdir).toBe('/tmp/x');
  });

  test('解析多個呼叫，含未加引號的 key', () => {
    const calls = parseCodeModeCalls(REAL_MULTI_CALL_INPUT);
    expect(calls.map((c) => c.name)).toEqual(['update_plan', 'exec_command']);
    expect(calls[1]!.args.cmd).toBe('pwd && ls');
    // plan 是巢狀陣列，寬鬆解析保留原文或結構皆可，重點是 key 有被抓到
    expect(calls[0]!.args.plan).toBeDefined();
  });

  test('忽略字串字面量內的 tools.xxx(', () => {
    const input =
      'const r = await tools.exec_command({cmd:"grep -n \'tools.spawn_agent(\' src/x.ts"});';
    const calls = parseCodeModeCalls(input);
    expect(calls.map((c) => c.name)).toEqual(['exec_command']);
  });

  test('忽略註解內的呼叫', () => {
    const input =
      '// await tools.spawn_agent({agent_type:"x"})\nconst r = await tools.exec_command({cmd:"ls"});';
    expect(parseCodeModeCalls(input).map((c) => c.name)).toEqual([
      'exec_command',
    ]);
  });

  test('沒有 tools. 呼叫時回傳空陣列', () => {
    expect(parseCodeModeCalls('const x = 1 + 1; text(String(x));')).toEqual([]);
    expect(parseCodeModeCalls('')).toEqual([]);
  });

  test('cmd 內含跳脫引號不會截斷參數', () => {
    const input =
      'const r = await tools.exec_command({"cmd":"rg -n \\"foo\\\\\\"bar\\" .","workdir":"/tmp"});';
    const calls = parseCodeModeCalls(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.workdir).toBe('/tmp');
  });

  test('括號未閉合時不會無限迴圈', () => {
    const calls = parseCodeModeCalls('await tools.exec_command({cmd:"ls"');
    expect(calls).toEqual([]);
  });
});

describe('output 處理', () => {
  test('joinCustomToolOutput 串接 input_text 陣列', () => {
    const out = joinCustomToolOutput([
      { type: 'input_text', text: 'a' },
      { type: 'input_text', text: 'b' },
    ]);
    expect(out).toBe('ab');
  });

  test('joinCustomToolOutput 相容舊的字串格式', () => {
    expect(joinCustomToolOutput('plain')).toBe('plain');
  });

  test('stripScriptHeader 移除樣板但保留其他開頭', () => {
    expect(
      stripScriptHeader('Script completed\nWall time 0.4 seconds\nOutput:\nhi')
    ).toBe('hi');
    expect(stripScriptHeader('Script error: boom')).toBe('Script error: boom');
  });

  test('unwrapExecOutput 拆出 stdout', () => {
    const raw = JSON.stringify({
      chunk_id: '0e5a62',
      exit_code: 0,
      output: 'hello\n',
    });
    expect(unwrapExecOutput(raw)).toBe('hello\n');
  });

  test('unwrapExecOutput 保留 JSON 前的警告文字並標示非零 exit code', () => {
    const raw = `Warning: truncated output\n${JSON.stringify({
      exit_code: 2,
      output: 'boom',
    })}`;
    const result = unwrapExecOutput(raw);
    expect(result).toContain('Warning: truncated output');
    expect(result).toContain('[exit: 2]');
    expect(result).toContain('boom');
  });

  test('unwrapExecOutput 對非 JSON 原樣回傳', () => {
    expect(unwrapExecOutput('just text')).toBe('just text');
  });

  test('formatCustomToolOutput 逐段剝樣板與 JSON 外殼', () => {
    const result = formatCustomToolOutput([
      {
        type: 'input_text',
        text: 'Script completed\nWall time 0.5 seconds\nOutput:\n',
      },
      { type: 'input_text', text: '{}' },
      {
        type: 'input_text',
        text: JSON.stringify({ exit_code: 0, output: 'real stdout' }),
      },
    ]);
    expect(result).not.toContain('Wall time');
    expect(result).toContain('real stdout');
  });
});

describe('CodexLineParser code mode', () => {
  const parser = new CodexAgent({ verbose: true }).parser;

  test('custom_tool_call 顯示成 tool use 而非被丟棄', () => {
    const line = JSON.stringify({
      timestamp: '2026-08-06T08:15:23.143Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'call_1',
        name: 'exec',
        input: REAL_EXEC_INPUT,
      },
    });

    const parsed = parser.parse(line);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('function_call');
    expect(parsed!.toolName).toBe('exec_command');
    expect(parsed!.formatted).toContain('git show --stat HEAD');
  });

  test('多個 tools.* 呼叫逐行顯示', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: REAL_MULTI_CALL_INPUT,
      },
    });

    const parsed = parser.parse(line);
    expect(parsed!.formatted.split('\n').length).toBeGreaterThanOrEqual(2);
    expect(parsed!.formatted).toContain('update_plan');
    expect(parsed!.formatted).toContain('pwd && ls');
  });

  test('純 JS（無 tools 呼叫）仍顯示程式碼', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        name: 'exec',
        input: 'text(String(1 + 1));',
      },
    });

    const parsed = parser.parse(line);
    expect(parsed!.formatted).toContain('[TOOL: exec]');
    expect(parsed!.formatted).toContain('1 + 1');
  });

  test('custom_tool_call_output 顯示為 output 類型', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call_1',
        output: [
          {
            type: 'input_text',
            text: 'Script completed\nWall time 0.4 seconds\nOutput:\n',
          },
          {
            type: 'input_text',
            text: JSON.stringify({ exit_code: 0, output: 'done\n' }),
          },
        ],
      },
    });

    const parsed = parser.parse(line);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe('output');
    expect(parsed!.formatted).toContain('done');
    expect(parsed!.formatted).not.toContain('Wall time');
  });

  test('空輸出不產生行', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', output: [] },
    });
    expect(parser.parse(line)).toBeNull();
  });
});
