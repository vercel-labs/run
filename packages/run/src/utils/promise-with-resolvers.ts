interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
}

export const createPromiseWithResolvers = <T>(): PromiseWithResolvers<T> => {
  let resolveDeferred!: PromiseWithResolvers<T>['resolve'];
  let rejectDeferred!: PromiseWithResolvers<T>['reject'];
  // eslint-disable-next-line promise/avoid-new -- Node.js 20 lacks Promise.withResolvers.
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return {
    promise,
    reject: rejectDeferred,
    resolve: resolveDeferred,
  };
};
