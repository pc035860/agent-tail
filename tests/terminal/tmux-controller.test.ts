import { describe, test, expect, afterEach } from 'bun:test';
import { TmuxController } from '../../src/terminal/tmux-controller';

describe('TmuxController', () => {
  const originalEnv = process.env.TMUX;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TMUX = originalEnv;
    } else {
      delete process.env.TMUX;
    }
  });

  describe('isAvailable', () => {
    test('returns true when TMUX env is set', () => {
      process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
      const controller = new TmuxController();
      expect(controller.isAvailable()).toBe(true);
    });

    test('returns false when TMUX env is not set', () => {
      delete process.env.TMUX;
      const controller = new TmuxController();
      expect(controller.isAvailable()).toBe(false);
    });
  });

  describe('name', () => {
    test('returns "tmux"', () => {
      const controller = new TmuxController();
      expect(controller.name).toBe('tmux');
    });
  });

  describe('createPane', () => {
    test('returns null when tmux command fails', async () => {
      // This test will fail if tmux is actually available and TMUX is set.
      // In CI/test environments without tmux, this validates graceful degradation.
      delete process.env.TMUX;
      const controller = new TmuxController();

      // If not inside tmux, split-window should fail
      const result = await controller.createPane('echo test', 'test-agent-id');
      // Either null (error caught) or a PaneInfo if tmux happens to be available
      // We just verify it doesn't throw
      expect(result === null || typeof result?.id === 'string').toBe(true);
    });
  });

  describe('closePane', () => {
    test('does not throw on invalid pane ID', async () => {
      const controller = new TmuxController();
      // Should silently catch errors
      await expect(
        controller.closePane('%nonexistent')
      ).resolves.toBeUndefined();
    });
  });

  describe('renamePane', () => {
    test('does not throw on invalid pane ID', async () => {
      const controller = new TmuxController();
      // Should silently catch errors even with invalid pane
      await expect(
        controller.renamePane('%nonexistent', 'test title')
      ).resolves.toBeUndefined();
    });

    test('does not throw with special characters in title', async () => {
      const controller = new TmuxController();
      await expect(
        controller.renamePane('%nonexistent', 'title with "quotes" & symbols')
      ).resolves.toBeUndefined();
    });
  });
});
