import { AsyncLocalStorage } from 'node:async_hooks';
import type { HostFunctionContext } from './types.js';

interface HostFunctionContextStore {
  active: boolean;
  context: HostFunctionContext;
}

const hostFunctionContextStorage =
  new AsyncLocalStorage<HostFunctionContextStore>();

/** Returns the context for the currently executing host function. */
export const getHostFunctionContext = (): HostFunctionContext => {
  const store = hostFunctionContextStorage.getStore();
  if (store === undefined || !store.active) {
    throw new Error(
      'getHostFunctionContext() can only be called while executing a host function.',
    );
  }
  return store.context;
};

export const runWithHostFunctionContext = async <OUTPUT>(
  context: HostFunctionContext,
  execute: () => OUTPUT | Promise<OUTPUT>,
): Promise<OUTPUT> => {
  const store: HostFunctionContextStore = { active: true, context };
  try {
    return await hostFunctionContextStorage.run(store, execute);
  } finally {
    store.active = false;
  }
};
