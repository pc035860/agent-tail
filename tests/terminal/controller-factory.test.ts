import { describe, test, expect, afterEach } from 'bun:test';
import { createTerminalController } from '../../src/terminal/controller-factory';
import { TmuxController } from '../../src/terminal/tmux-controller';
import { NullController } from '../../src/terminal/null-controller';

describe('createTerminalController', () => {
  const originalTmux = process.env.TMUX;

  afterEach(() => {
    if (originalTmux !== undefined) {
      process.env.TMUX = originalTmux;
    } else {
      delete process.env.TMUX;
    }
  });

  test('returns TmuxController when TMUX env is set', () => {
    process.env.TMUX = '/tmp/tmux-1000/default,12345,0';
    const controller = createTerminalController();
    expect(controller).toBeInstanceOf(TmuxController);
    expect(controller.name).toBe('tmux');
  });

  test('returns NullController when TMUX env is not set', () => {
    delete process.env.TMUX;
    const controller = createTerminalController();
    expect(controller).toBeInstanceOf(NullController);
    expect(controller.name).toBe('null');
  });

  test('NullController.isAvailable() returns false', () => {
    delete process.env.TMUX;
    const controller = createTerminalController();
    expect(controller.isAvailable()).toBe(false);
  });

  test('NullController.createPane() returns null', async () => {
    delete process.env.TMUX;
    const controller = createTerminalController();
    const result = await controller.createPane('echo test', 'agent-id');
    expect(result).toBeNull();
  });
});
