import { describe, expect, it, vi } from 'vitest';
import { invokeHostBinding } from './binding-invocation.js';
import type { BindingContext } from './types.js';

const createContext = (bindingName: string): BindingContext => ({
  abortSignal: new AbortController().signal,
  bindingName,
  interrupt: () => {
    throw new Error('not used');
  },
  invocationId: 'invocation-1',
  logicalRunId: 'logical-run-1',
  requestId: 'request-1',
  requestIndex: 1,
});

describe('invokeHostBinding', () => {
  it('rejects oversized arguments before parsing them', async () => {
    const binding = vi.fn();
    const abortController = new AbortController();
    const context: BindingContext = {
      abortSignal: abortController.signal,
      bindingName: 'tools.test',
      interrupt: () => {
        throw new Error('not used');
      },
      invocationId: 'invocation-1',
      logicalRunId: 'logical-run-1',
      requestId: 'request-1',
      requestIndex: 1,
    };

    await expect(
      invokeHostBinding({
        bindingName: 'tools.test',
        bindings: { tools: { test: binding } },
        context,
        inputJson: `[${' '.repeat(32)}`,
        maxBindingInputBytes: 8,
        maxBindingOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'RUN_BINDING_ERROR' });
    expect(binding).not.toHaveBeenCalled();
  });

  it('rejects unknown and non-function own bindings', async () => {
    const context = createContext('tools.missing');
    await expect(
      invokeHostBinding({
        bindingName: 'tools.missing',
        bindings: { tools: { present: () => true } },
        context,
        inputJson: '[[]]',
        maxBindingInputBytes: 1024,
        maxBindingOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({
      code: 'RUN_BINDING_ERROR',
      details: { availableBindings: ['tools.present'] },
    });

    await expect(
      invokeHostBinding({
        bindingName: 'tools.present',
        bindings: {
          tools: { present: true as unknown as () => boolean },
        },
        context: createContext('tools.present'),
        inputJson: '[[]]',
        maxBindingInputBytes: 1024,
        maxBindingOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'RUN_BINDING_ERROR' });
  });

  it('serializes arguments and output at the host boundary', async () => {
    const binding = vi.fn((input: unknown) => ({ input, omitted: undefined }));
    await expect(
      invokeHostBinding({
        bindingName: 'tools.test',
        bindings: { tools: { test: binding } },
        context: createContext('tools.test'),
        inputJson: '[[1],{"value":2},1]',
        maxBindingInputBytes: 1024,
        maxBindingOutputBytes: 1024,
      }),
    ).resolves.toEqual({
      status: 'fulfilled',
      valueJson: '[{"input":1,"omitted":-1},{"value":2},1]',
    });
    expect(binding).toHaveBeenCalledWith({ value: 1 });
  });

  it('rejects oversized binding output', async () => {
    await expect(
      invokeHostBinding({
        bindingName: 'tools.test',
        bindings: { tools: { test: () => 'too large' } },
        context: createContext('tools.test'),
        inputJson: '[[]]',
        maxBindingInputBytes: 1024,
        maxBindingOutputBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'RUN_SERIALIZATION_ERROR' });
  });
});
