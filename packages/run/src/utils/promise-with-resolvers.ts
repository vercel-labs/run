interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
}

interface PromiseConstructorWithResolvers extends PromiseConstructor {
  withResolvers<T>(): PromiseWithResolvers<T>;
}

export const createPromiseWithResolvers = <T>(): PromiseWithResolvers<T> =>
  (Promise as PromiseConstructorWithResolvers).withResolvers<T>();
