import { GUEST_SERDE_SOURCE } from './guest-serde-source.js';

const BASE64_SOURCE = `
const __runBase64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function btoa(input) {
  var output = '';
  for (var index = 0; index < input.length; index += 3) {
    var first = input.charCodeAt(index);
    var hasSecond = index + 1 < input.length;
    var hasThird = index + 2 < input.length;
    var second = hasSecond ? input.charCodeAt(index + 1) : 0;
    var third = hasThird ? input.charCodeAt(index + 2) : 0;
    if (first > 255 || second > 255 || third > 255) {
      throw new TypeError('Invalid binary string for base64 encoding.');
    }
    var bits = (first << 16) | (second << 8) | third;
    output += __runBase64Alphabet[(bits >>> 18) & 63];
    output += __runBase64Alphabet[(bits >>> 12) & 63];
    output += hasSecond ? __runBase64Alphabet[(bits >>> 6) & 63] : '=';
    output += hasThird ? __runBase64Alphabet[bits & 63] : '=';
  }
  return output;
}
function atob(input) {
  if (
    typeof input !== 'string' ||
    input.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)
  ) {
    throw new TypeError('Invalid base64 data.');
  }
  var output = '';
  for (var index = 0; index < input.length; index += 4) {
    var first = __runBase64Alphabet.indexOf(input[index]);
    var second = __runBase64Alphabet.indexOf(input[index + 1]);
    var third = input[index + 2] === '=' ? 0 : __runBase64Alphabet.indexOf(input[index + 2]);
    var fourth = input[index + 3] === '=' ? 0 : __runBase64Alphabet.indexOf(input[index + 3]);
    var bits = (first << 18) | (second << 12) | (third << 6) | fourth;
    output += String.fromCharCode((bits >>> 16) & 255);
    if (input[index + 2] !== '=') output += String.fromCharCode((bits >>> 8) & 255);
    if (input[index + 3] !== '=') output += String.fromCharCode(bits & 255);
  }
  return output;
}
`;

const HARDENING_SOURCE = `
(function() {
  try { delete globalThis.crypto; } catch {}
  if ('crypto' in globalThis) {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      writable: false,
      configurable: false,
    });
  }
  try { delete globalThis.performance; } catch {}
  if ('performance' in globalThis) {
    Object.defineProperty(globalThis, 'performance', {
      value: undefined,
      writable: false,
      configurable: false,
    });
  }
  try { delete globalThis.SharedArrayBuffer; } catch {}
  if ('SharedArrayBuffer' in globalThis) {
    Object.defineProperty(globalThis, 'SharedArrayBuffer', {
      value: undefined,
      writable: false,
      configurable: false,
    });
  }
  try { delete globalThis.Atomics; } catch {}
  if ('Atomics' in globalThis) {
    Object.defineProperty(globalThis, 'Atomics', {
      value: undefined,
      writable: false,
      configurable: false,
    });
  }
  for (const name of [
    'AsyncDisposableStack',
    'DOMException',
    'DisposableStack',
    'SuppressedError',
    'atob',
    'btoa',
    'queueMicrotask',
  ]) {
    try { delete globalThis[name]; } catch {}
  }

  // @banned-pattern-ignore: intentional QuickJS guest hardening disables eval rather than host globals
  Object.defineProperty(globalThis, 'eval', {
    value: undefined,
    writable: false,
    configurable: false,
  });

  const OriginalFunction = Function;
  const BlockedFunction = function() {
    throw new TypeError('Function constructor is not allowed');
  };
  BlockedFunction.prototype = OriginalFunction.prototype;

  const AsyncFunction = (async function(){}).constructor;
  const GeneratorFunction = (function*(){}).constructor;
  const AsyncGeneratorFunction = (async function*(){}).constructor;
  for (const proto of [
    OriginalFunction.prototype,
    AsyncFunction.prototype,
    GeneratorFunction.prototype,
    AsyncGeneratorFunction.prototype,
  ]) {
    Object.defineProperty(proto, 'constructor', {
      value: BlockedFunction,
      writable: false,
      configurable: false,
    });
  }
  // @banned-pattern-ignore: intentional QuickJS guest hardening replaces the Function constructor
  Object.defineProperty(globalThis, 'Function', {
    value: BlockedFunction,
    writable: false,
    configurable: false,
  });

  const g = globalThis;
  const toFreeze = [
    Object, Object.prototype,
    OriginalFunction, OriginalFunction.prototype,
    AsyncFunction, AsyncFunction.prototype,
    GeneratorFunction, GeneratorFunction.prototype,
    AsyncGeneratorFunction, AsyncGeneratorFunction.prototype,
    Array, Array.prototype,
    String, String.prototype,
    Number, Number.prototype,
    g.BigInt, g.BigInt && g.BigInt.prototype,
    Boolean, Boolean.prototype,
    g.Symbol, g.Symbol && g.Symbol.prototype,
    RegExp, RegExp.prototype,
    Date, Date.prototype,
    Map, Map.prototype,
    Set, Set.prototype,
    WeakMap, WeakMap.prototype,
    WeakSet, WeakSet.prototype,
    Promise, Promise.prototype,
    ArrayBuffer, ArrayBuffer.prototype,
    g.DataView, g.DataView && g.DataView.prototype,
    JSON, Math, g.Reflect, g.Proxy,
  ];
  for (const name of [
    'Int8Array','Uint8Array','Uint8ClampedArray',
    'Int16Array','Uint16Array','Int32Array','Uint32Array',
    'Float16Array','Float32Array','Float64Array',
    'BigInt64Array','BigUint64Array',
  ]) {
    if (g[name]) toFreeze.push(g[name], g[name].prototype);
  }
  for (const obj of toFreeze) {
    if (obj != null) {
      try { Object.freeze(obj); } catch {}
    }
  }

  for (const name of [
    'AggregateError','Array','ArrayBuffer','BigInt','Boolean','DataView','Error',
    'EvalError','FinalizationRegistry','Float16Array','Float32Array','Float64Array',
    'Int8Array','Int16Array','Int32Array','InternalError','Iterator','JSON','Map',
    'Math','Number','Object','Promise','Proxy','RangeError','ReferenceError',
    'Reflect','RegExp','Set','String','Symbol','SyntaxError','TypeError',
    'Uint8Array','Uint8ClampedArray','Uint16Array','Uint32Array','URIError',
    'WeakMap','WeakRef','WeakSet','BigInt64Array','BigUint64Array','console',
    'globalThis'
  ]) {
    if (g[name] !== undefined) {
      try {
        // @banned-pattern-ignore: name comes only from the fixed intrinsic list above
        Object.defineProperty(g, name, {
          value: g[name],
          writable: false,
          configurable: false,
        });
      } catch {}
    }
  }
})();
`;

const DETERMINISTIC_APIS_SOURCE = `
var __runResetDateNow = (function(config) {
  var OriginalDate = Date;
  var dateNowMs = __runOriginalNumber(config && config.dateNowMs);
  if (!__runOriginalNumber.isFinite(dateNowMs)) dateNowMs = 0;

  function resetDateNow(value) {
    var next = __runOriginalNumber(value);
    if (__runOriginalNumber.isFinite(next)) dateNowMs = __runOriginalMath.trunc(next);
  }

  function nextDateMs() {
    var value = dateNowMs;
    dateNowMs += 1;
    return value;
  }

  function RunDate() {
    if (new.target) {
      if (arguments.length === 0) return new OriginalDate(nextDateMs());
      return __runOriginalReflect.construct(OriginalDate, arguments, new.target);
    }
    return new OriginalDate(nextDateMs()).toString();
  }

  Object.defineProperty(RunDate, 'prototype', {
    value: OriginalDate.prototype,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(OriginalDate.prototype, 'constructor', {
    value: RunDate,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(RunDate, 'now', {
    value: nextDateMs,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(RunDate, 'parse', {
    value: OriginalDate.parse,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(RunDate, 'UTC', {
    value: OriginalDate.UTC,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(globalThis, 'Date', {
    value: RunDate,
    writable: false,
    configurable: false,
  });

  var randomSeed = String(config && config.randomSeed || '');
  var mask64 = (1n << 64n) - 1n;

  function readSeedPart(offset, fallback) {
    var part = randomSeed.slice(offset, offset + 16);
    return /^[0-9a-fA-F]{16}$/.test(part) ? BigInt('0x' + part) : fallback;
  }

  var randomState0 = readSeedPart(0, 0x243f6a8885a308d3n);
  var randomState1 = readSeedPart(16, 0x13198a2e03707344n);
  if ((randomState0 | randomState1) === 0n) randomState1 = 0x9e3779b97f4a7c15n;

  function nextRandom64() {
    var s1 = randomState0;
    var s0 = randomState1;
    randomState0 = s0;
    s1 = (s1 ^ ((s1 << 23n) & mask64)) & mask64;
    randomState1 = (s1 ^ s0 ^ (s1 >> 17n) ^ (s0 >> 26n)) & mask64;
    return (randomState1 + s0) & mask64;
  }

  Object.defineProperty(Math, 'random', {
    value: function() {
      return __runOriginalNumber(nextRandom64() >> 11n) / 9007199254740992;
    },
    writable: false,
    configurable: false,
  });
  return resetDateNow;
})(__runDeterminism);
`;

const BRIDGE_TRACKING_SOURCE = `
const __runCreateBridgePromiseHandle = (function() {
  var nextRecordId = 0;
  var records = [];

  function detachedError(message, record) {
    var error = new __runOriginalError(message);
    __runOriginalObject.defineProperties(error, {
      name: {
        value: 'RunDetachedBridgeRequestError',
        writable: true,
        configurable: true,
        enumerable: true
      },
      code: {
        value: 'RUN_DETACHED_BRIDGE_REQUEST',
        writable: true,
        configurable: true,
        enumerable: true
      },
      details: {
        value: {
          id: record.id,
          kind: record.kind,
          name: record.name,
          status: record.status
        },
        writable: true,
        configurable: true,
        enumerable: true
      }
    });
    return error;
  }

  function createBridgePromise(kind, name, start) {
    var record = {
      id: ++nextRecordId,
      kind: __runOriginalString(kind),
      name: __runOriginalString(name || ''),
      observed: false,
      status: 'idle'
    };
    var promise;
    records.push(record);

    function getPromise() {
      record.observed = true;
      if (!promise) {
        record.status = 'pending';
        promise = __runOriginalPromise.resolve().then(start).then(
          function(value) {
            record.status = 'fulfilled';
            return value;
          },
          function(error) {
            record.status = 'rejected';
            throw error;
          }
        );
      }
      return promise;
    }

    return __runOriginalObject.freeze({
      then: function(onFulfilled, onRejected) {
        return getPromise().then(onFulfilled, onRejected);
      },
      catch: function(onRejected) {
        return getPromise().catch(onRejected);
      },
      finally: function(onFinally) {
        return getPromise().finally(onFinally);
      },
      get [__runOriginalSymbol.toStringTag]() {
        return 'Promise';
      }
    });
  }

  Object.defineProperty(globalThis, '__runCreateBridgePromise', {
    value: createBridgePromise,
    writable: false,
    configurable: false
  });

  Object.defineProperty(globalThis, '__runAssertNoDetachedBridgeCalls', {
    value: function() {
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        if (!record.observed) {
          throw detachedError(
            'JavaScript runtime created an unawaited ' + record.kind + ' bridge request: ' + record.name + '.',
            record
          );
        }
        if (record.status === 'pending') {
          throw detachedError(
            'JavaScript runtime returned while a ' + record.kind + ' bridge request was still pending: ' + record.name + '.',
            record
          );
        }
      }
    },
    writable: false,
    configurable: false
  });
  return createBridgePromise;
})();
`;

const HOST_FUNCTIONS_PROXY_SOURCE = `
(function(invokeHostFunction, hostFunctionNamespaces, createBridgePromise) {
  function serializationError(label, error) {
    var message = __runSafeErrorMessage(error);
    var result = new __runOriginalTypeError(label + ': ' + message);
    __runOriginalObject.defineProperty(result, 'code', {
      value: 'RUN_SERIALIZATION_ERROR',
      writable: true,
      configurable: true,
      enumerable: true
    });
    return result;
  }

  function makeProxy(path) {
    return new __runOriginalProxy(function(){}, {
      get: function(_target, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return makeProxy(path.concat([__runOriginalString(prop)]));
      },
      apply: function(_target, _thisArg, args) {
        var hostFunctionPath = path.join('.');
        if (!hostFunctionPath) throw new Error('Host function path missing in invocation');
        var callSiteStack = new Error().stack;
        var inputJson;
        try {
          inputJson = __runSerdeBundle.serializeRunValue(args);
        } catch (error) {
          throw serializationError('Host function arguments are not serializable', error);
        }
        return createBridgePromise('hostFunction', hostFunctionPath, async function() {
          var resultJson;
          try {
            resultJson = await invokeHostFunction(hostFunctionPath, inputJson);
          } catch (error) {
            try { error.stack = callSiteStack; } catch {}
            throw error;
          }
          try {
            return __runSerdeBundle.deserializeRunValue(resultJson);
          } catch (error) {
            throw serializationError('Host function result is invalid run-js-v1 data', error);
          }
        });
      }
    });
  }

  for (var i = 0; i < hostFunctionNamespaces.length; i++) {
    var namespace = hostFunctionNamespaces[i];
    // @banned-pattern-ignore: namespace is host-validated as a safe non-reserved identifier
    Object.defineProperty(globalThis, namespace, {
      value: makeProxy([namespace]),
      writable: false,
      configurable: false
    });
  }
})(
  __runInvokeHostFunction,
  __runHostFunctionNamespaces,
  __runCreateBridgePromiseHandle
);
`;

const SYNC_HOST_FUNCTIONS_PROXY_SOURCE = `
(function(invokeSyncHostFunction, syncHostFunctionNamespaces) {
  function serializationError(label, error) {
    var message = __runSafeErrorMessage(error);
    var result = new __runOriginalTypeError(label + ': ' + message);
    __runOriginalObject.defineProperty(result, 'code', {
      value: 'RUN_SERIALIZATION_ERROR',
      writable: true,
      configurable: true,
      enumerable: true
    });
    return result;
  }

  function makeProxy(path) {
    return new __runOriginalProxy(function(){}, {
      get: function(_target, prop) {
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        return makeProxy(path.concat([__runOriginalString(prop)]));
      },
      apply: function(_target, _thisArg, args) {
        var hostFunctionPath = path.join('.');
        var inputJson;
        try {
          inputJson = __runSerdeBundle.serializeRunValue(args);
        } catch (error) {
          throw serializationError('Synchronous host function arguments are not serializable', error);
        }
        var encoded = invokeSyncHostFunction(hostFunctionPath, inputJson);
        if (encoded.charCodeAt(0) === 0) {
          var serialized = JSON.parse(encoded.slice(1));
          var error = new __runOriginalError(serialized.message || 'Synchronous host function failed');
          if (typeof serialized.name === 'string') error.name = serialized.name;
          if (typeof serialized.code === 'string') error.code = serialized.code;
          if (serialized.details !== undefined) error.details = serialized.details;
          __runTrustedErrorHandles.register(error, serialized.name, serialized.code);
          throw error;
        }
        try {
          return __runSerdeBundle.deserializeRunValue(encoded.slice(1));
        } catch (error) {
          throw serializationError('Synchronous host function result is invalid run-js-v1 data', error);
        }
      }
    });
  }

  for (var i = 0; i < syncHostFunctionNamespaces.length; i++) {
    var namespace = syncHostFunctionNamespaces[i];
    // @banned-pattern-ignore: namespace is host-validated as a safe non-reserved identifier
    Object.defineProperty(globalThis, namespace, {
      value: makeProxy([namespace]),
      writable: false,
      configurable: false
    });
  }
})(__runInvokeSyncHostFunction, __runSyncHostFunctionNamespaces);
`;

const SERIALIZATION_GUARD_SOURCE = `
const __runSerializeJsonPayloadHandle = (function() {
  function serializeValuePayload(value) {
    if (typeof globalThis.__runAssertNoDetachedBridgeCalls === 'function') {
      globalThis.__runAssertNoDetachedBridgeCalls();
    }

    var encoded;
    try {
      encoded = __runSerdeBundle.serializeRunValue(value);
    } catch (error) {
      var message = __runSafeErrorMessage(error);
      var serializationError = new __runOriginalTypeError('JavaScript runtime result is not serializable: ' + message);
      __runOriginalObject.defineProperty(serializationError, 'code', {
        value: 'RUN_SERIALIZATION_ERROR',
        writable: true,
        configurable: true,
        enumerable: true
      });
      throw serializationError;
    }

    if (encoded === undefined) {
      var serializationError = new __runOriginalTypeError('JavaScript runtime result is not serializable.');
      __runOriginalObject.defineProperty(serializationError, 'code', {
        value: 'RUN_SERIALIZATION_ERROR',
        writable: true,
        configurable: true,
        enumerable: true
      });
      throw serializationError;
    }

    return encoded;
  }

  Object.defineProperty(globalThis, '__runSerializeJsonPayload', {
    value: serializeValuePayload,
    writable: false,
    configurable: false,
  });
  return serializeValuePayload;
})();
`;

const TRUSTED_ERROR_SOURCE = `
const __runTrustedErrorHandles = (function() {
  var trustedCodes = new __runOriginalWeakMap();
  return __runOriginalObject.freeze({
    register: function(error, name, code) {
      if (typeof name === 'string') {
        __runOriginalObject.defineProperty(error, 'name', {
          value: __runOriginalString(name),
          writable: true,
          configurable: true
        });
      }
      if (typeof code === 'string') {
        var trustedCode = __runOriginalString(code);
        __runOriginalObject.defineProperty(error, 'code', {
          value: trustedCode,
          writable: true,
          configurable: true,
          enumerable: true
        });
        trustedCodes.set(error, trustedCode);
      }
    },
    getCode: function(error) {
      return trustedCodes.get(error);
    }
  });
})();
`;

export const buildGuestRuntimeSetupSource = (
  hostFunctionNamespaces: string[],
  syncHostFunctionNamespaces: string[] = [],
): string => {
  const namespacesJson = JSON.stringify(hostFunctionNamespaces);
  const syncNamespacesJson = JSON.stringify(syncHostFunctionNamespaces);
  return `
(function(__runInvokeHostFunction, __runInvokeSyncHostFunction, __runDeterminism) {
const __runHostFunctionNamespaces = ${namespacesJson};
const __runSyncHostFunctionNamespaces = ${syncNamespacesJson};
const __runOriginalError = Error;
const __runOriginalMath = Math;
const __runOriginalNumber = Number;
const __runOriginalObject = Object;
const __runOriginalPromise = Promise;
const __runOriginalProxy = Proxy;
const __runOriginalReflect = Reflect;
const __runOriginalString = String;
const __runOriginalSymbol = Symbol;
const __runOriginalTypeError = TypeError;
const __runOriginalWeakMap = WeakMap;
function __runSafeErrorMessage(error) {
  if (typeof error === 'string') return error;
  if (
    (typeof error === 'object' && error !== null) ||
    typeof error === 'function'
  ) {
    try {
      var descriptor = __runOriginalObject.getOwnPropertyDescriptor(error, 'message');
      if (descriptor && typeof descriptor.value === 'string') {
        return descriptor.value;
      }
    } catch {}
  }
  return 'Serialization failed.';
}
${DETERMINISTIC_APIS_SOURCE}
${BASE64_SOURCE}
${GUEST_SERDE_SOURCE}
${HARDENING_SOURCE}
${BRIDGE_TRACKING_SOURCE}
${HOST_FUNCTIONS_PROXY_SOURCE}
${SYNC_HOST_FUNCTIONS_PROXY_SOURCE}
${SERIALIZATION_GUARD_SOURCE}
${TRUSTED_ERROR_SOURCE}
return Object.freeze({
  getTrustedErrorCode: __runTrustedErrorHandles.getCode,
  registerTrustedError: __runTrustedErrorHandles.register,
  resetDateNow: __runResetDateNow,
  serializeJsonPayload: __runSerializeJsonPayloadHandle
});
})
`;
};

export const wrapUserCode = (js: string): string => `
globalThis.__runResult = (async () => {
${js}
})();
`;
