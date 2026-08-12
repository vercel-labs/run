import { run } from 'run';

export const runtime = 'nodejs';
export const maxDuration = 10;

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 32 * 1024;

const jsonError = (message: string, status: number) =>
  Response.json(
    {
      error: {
        message,
        name: status >= 500 ? 'ExecutionError' : 'RequestError',
      },
    },
    { status },
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return jsonError('Request body is too large.', 413);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Request body must be valid JSON.', 400);
  }

  if (
    !isRecord(body) ||
    typeof body.source !== 'string' ||
    !Object.hasOwn(body, 'input')
  ) {
    return jsonError('Request must contain source and input.', 400);
  }

  if (Buffer.byteLength(body.source) > MAX_SOURCE_BYTES) {
    return jsonError('Guest source is too large.', 413);
  }

  const inputJson = JSON.stringify(body.input);
  if (
    inputJson === undefined ||
    Buffer.byteLength(inputJson) > MAX_INPUT_BYTES
  ) {
    return jsonError('Host input is too large.', 413);
  }

  try {
    const result = await run({
      source: body.source,
      hostFunctions: {
        input: {
          get: () => body.input,
        },
      },
      limits: {
        maxBridgeRequests: 8,
        maxConsoleOutputBytes: 8 * 1024,
        maxHostFunctionArgumentsBytes: 8 * 1024,
        maxHostFunctionOutputBytes: MAX_INPUT_BYTES,
        maxInFlightBridgeRequests: 2,
        maxResultBytes: 64 * 1024,
        maxSourceBytes: MAX_SOURCE_BYTES,
        memoryLimitBytes: 32 * 1024 * 1024,
        timeoutMs: 1_000,
      },
    });

    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Guest execution failed.';
    return jsonError(message, 400);
  }
}
