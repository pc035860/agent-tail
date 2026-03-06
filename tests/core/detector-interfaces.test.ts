import { describe, test, expect } from 'bun:test';
import {
  MAIN_LABEL,
  makeAgentLabel,
  extractAgentIdFromLabel,
  type SessionHandler,
  type OutputHandler,
  type RetryConfig,
} from '../../src/core/detector-interfaces';

describe('detector-interfaces', () => {
  describe('MAIN_LABEL', () => {
    test('值為 [MAIN]', () => {
      expect(MAIN_LABEL).toBe('[MAIN]');
    });
  });

  describe('makeAgentLabel', () => {
    test('包裝短 agentId 為 [agentId] 格式', () => {
      expect(makeAgentLabel('abc1234')).toBe('[abc1234]');
    });

    test('包裝 UUID 前段（Codex 格式）', () => {
      expect(makeAgentLabel('019cc375-5af5')).toBe('[019cc375-5af5]');
    });

    test('包裝空字串', () => {
      expect(makeAgentLabel('')).toBe('[]');
    });
  });

  describe('extractAgentIdFromLabel', () => {
    test('從 [agentId] 格式提取 agentId', () => {
      expect(extractAgentIdFromLabel('[abc1234]')).toBe('abc1234');
    });

    test('從 [MAIN] 提取 MAIN', () => {
      expect(extractAgentIdFromLabel('[MAIN]')).toBe('MAIN');
    });
  });

  describe('makeAgentLabel / extractAgentIdFromLabel 往返一致性', () => {
    test('makeAgentLabel 後再 extract 還原原始 id', () => {
      const id = 'abc1234xyz';
      expect(extractAgentIdFromLabel(makeAgentLabel(id))).toBe(id);
    });

    test('UUID 前段往返一致', () => {
      const id = '019cc375-5af5';
      expect(extractAgentIdFromLabel(makeAgentLabel(id))).toBe(id);
    });
  });

  describe('SessionHandler 型別相容性', () => {
    test('空物件可賦值給 SessionHandler（所有方法均為 optional）', () => {
      // 編譯時型別驗證：若 SessionHandler 的方法不全是 optional，這裡會 typecheck 失敗
      const handler: SessionHandler = {};
      expect(handler).toBeDefined();
    });

    test('具有部分方法的物件可賦值給 SessionHandler', () => {
      const handler: SessionHandler = {
        addSession: (_agentId: string, _label: string, _path: string) => {},
      };
      expect(handler.addSession).toBeDefined();
    });
  });

  describe('OutputHandler 介面定義', () => {
    test('實作 OutputHandler 的物件具有正確方法簽名', () => {
      const logs: string[] = [];
      const handler: OutputHandler = {
        info: (msg: string) => logs.push(`info:${msg}`),
        warn: (msg: string) => logs.push(`warn:${msg}`),
        error: (msg: string) => logs.push(`error:${msg}`),
        debug: (msg: string) => logs.push(`debug:${msg}`),
      };
      handler.info('hello');
      handler.warn('warning');
      handler.error('err');
      handler.debug('dbg');
      expect(logs).toEqual([
        'info:hello',
        'warn:warning',
        'error:err',
        'debug:dbg',
      ]);
    });
  });

  describe('RetryConfig 介面定義', () => {
    test('RetryConfig 物件包含正確欄位', () => {
      const config: RetryConfig = {
        maxRetries: 5,
        retryDelay: 100,
        initialDelay: 50,
      };
      expect(config.maxRetries).toBe(5);
      expect(config.retryDelay).toBe(100);
      expect(config.initialDelay).toBe(50);
    });
  });
});
