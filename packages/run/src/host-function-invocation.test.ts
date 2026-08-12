import { describe, expect, it, vi } from 'vitest';
import { invokeHostFunction } from './host-function-invocation.js';
import type { HostFunctionContext } from './types.js';

const createContext = (hostFunctionName: string): HostFunctionContext => ({
  abortSignal: new AbortController().signal,
  hostFunctionName,
  interrupt: () => {
    throw new Error('not used');
  },
  invocationId: 'invocation-1',
  logicalRunId: 'logical-run-1',
  requestId: 'request-1',
  requestIndex: 1,
});

const manifest = (...names: string[]) => new Map([['tools', new Set(names)]]);

describe('invokeHostFunction', () => {
  it('rejects oversized arguments before parsing them', async () => {
    const hostFunction = vi.fn();
    const abortController = new AbortController();
    const context: HostFunctionContext = {
      abortSignal: abortController.signal,
      hostFunctionName: 'tools.test',
      interrupt: () => {
        throw new Error('not used');
      },
      invocationId: 'invocation-1',
      logicalRunId: 'logical-run-1',
      requestId: 'request-1',
      requestIndex: 1,
    };

    await expect(
      invokeHostFunction({
        context,
        hostFunctionManifest: manifest('test'),
        hostFunctionName: 'tools.test',
        hostFunctions: { tools: { test: hostFunction } },
        inputJson: `[${' '.repeat(32)}`,
        maxHostFunctionInputBytes: 8,
        maxHostFunctionOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'RUN_HOST_FUNCTION_ERROR' });
    expect(hostFunction).not.toHaveBeenCalled();
  });

  it('rejects unknown and non-function own host functions', async () => {
    const context = createContext('tools.missing');
    await expect(
      invokeHostFunction({
        context,
        hostFunctionManifest: manifest('present'),
        hostFunctionName: 'tools.missing',
        hostFunctions: { tools: { present: () => true } },
        inputJson: '[[]]',
        maxHostFunctionInputBytes: 1024,
        maxHostFunctionOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({
      code: 'RUN_HOST_FUNCTION_ERROR',
      details: { availableHostFunctions: ['tools.present'] },
    });

    await expect(
      invokeHostFunction({
        context: createContext('tools.present'),
        hostFunctionManifest: manifest('present'),
        hostFunctionName: 'tools.present',
        hostFunctions: {
          tools: { present: true as unknown as () => boolean },
        },
        inputJson: '[[]]',
        maxHostFunctionInputBytes: 1024,
        maxHostFunctionOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'RUN_HOST_FUNCTION_ERROR' });
  });

  it('rejects non-enumerable host functions at the invocation boundary', async () => {
    const hidden = vi.fn();
    const group = { present: () => true };
    Object.defineProperty(group, 'hidden', { value: hidden });

    await expect(
      invokeHostFunction({
        context: createContext('tools.hidden'),
        hostFunctionManifest: manifest('present'),
        hostFunctionName: 'tools.hidden',
        hostFunctions: { tools: group },
        inputJson: '[[]]',
        maxHostFunctionInputBytes: 1024,
        maxHostFunctionOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({
      code: 'RUN_HOST_FUNCTION_ERROR',
      details: { availableHostFunctions: ['tools.present'] },
    });
    expect(hidden).not.toHaveBeenCalled();
  });

  it('serializes arguments and output at the host boundary', async () => {
    const hostFunction = vi.fn((input: unknown) => ({
      input,
      omitted: undefined,
    }));
    await expect(
      invokeHostFunction({
        context: createContext('tools.test'),
        hostFunctionManifest: manifest('test'),
        hostFunctionName: 'tools.test',
        hostFunctions: { tools: { test: hostFunction } },
        inputJson: '[[1],{"value":2},1]',
        maxHostFunctionInputBytes: 1024,
        maxHostFunctionOutputBytes: 1024,
      }),
    ).resolves.toEqual({
      status: 'fulfilled',
      valueJson: '[{"input":1,"omitted":-1},{"value":2},1]',
    });
    expect(hostFunction).toHaveBeenCalledWith({ value: 1 });
  });

  it('rejects oversized host function output', async () => {
    await expect(
      invokeHostFunction({
        context: createContext('tools.test'),
        hostFunctionManifest: manifest('test'),
        hostFunctionName: 'tools.test',
        hostFunctions: { tools: { test: () => 'too large' } },
        inputJson: '[[]]',
        maxHostFunctionInputBytes: 1024,
        maxHostFunctionOutputBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'RUN_SERIALIZATION_ERROR' });
  });
});
