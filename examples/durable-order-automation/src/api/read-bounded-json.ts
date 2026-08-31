import { HttpError } from './auth.js';

export const readBoundedJson = async <T>(
  request: Request,
  maxBytes: number,
): Promise<T> => {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new HttpError(413, `Request body must not exceed ${maxBytes} bytes.`);
  }
  if (!request.body) throw new HttpError(400, 'Request body is required.');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new HttpError(
        413,
        `Request body must not exceed ${maxBytes} bytes.`,
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
};
