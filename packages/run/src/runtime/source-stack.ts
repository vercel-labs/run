const USER_SOURCE_FILENAME = 'run.js';

/** Number of generated lines before the first line of user source. */
export const USER_SOURCE_LINE_OFFSET = 2;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const STACK_FRAME = /^\s+at .+$/u;

const escapeControlCharacters = (value: string): string =>
  value.replace(CONTROL_CHARACTERS, (character) =>
    character === '\t'
      ? '\t'
      : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/**
 * Converts a QuickJS stack into a stable stack whose coordinates refer to the
 * source passed to `run`. Frames belonging to the generated wrapper and guest
 * runtime are intentionally omitted.
 */
export const normalizeUserSourceStack = ({
  name,
  message,
  stack,
  source,
}: {
  name: string;
  message: string;
  stack: string | undefined;
  source: string;
}): string => {
  const header = `${escapeControlCharacters(name)}: ${escapeControlCharacters(message)}`;
  if (stack === undefined || stack.length === 0) {
    return header;
  }

  const sourceLineCount = source.split('\n').length;
  const lines = stack.split('\n');
  const errorHeaderLines = new Set(
    [name, message, `${name}: ${message}`].flatMap((value) =>
      value.split('\n'),
    ),
  );
  const frames: string[] = [];

  for (const line of lines) {
    if (
      errorHeaderLines.has(line) ||
      line.includes('run-setup.js:') ||
      !STACK_FRAME.test(line)
    ) {
      continue;
    }

    let hasGeneratedSourceFrame = false;
    let outsideUserSource = false;
    const normalized = line.replaceAll(
      /run\.js:(\d+):(\d+)/gu,
      (_match, generatedLineText: string, column: string) => {
        hasGeneratedSourceFrame = true;
        const generatedLine = Number(generatedLineText);
        const userLine = generatedLine - USER_SOURCE_LINE_OFFSET;
        if (userLine < 1 || userLine > sourceLineCount) {
          outsideUserSource = true;
          return _match;
        }
        return `${USER_SOURCE_FILENAME}:${userLine}:${column}`;
      },
    );

    if (!(hasGeneratedSourceFrame && outsideUserSource)) {
      frames.push(escapeControlCharacters(normalized));
    }
  }

  return [header, ...frames].join('\n');
};
