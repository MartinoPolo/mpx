export interface CliIo {
  readonly supportsColor?: boolean;
  stdout(text: string): void;
  stderr(text: string): void;
}
export const processIo: CliIo = {
  supportsColor:
    process.stderr.isTTY === true &&
    process.env.NO_COLOR === undefined &&
    process.env.TERM !== 'dumb',
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface CapturedIo extends CliIo {
  readonly out: string[];
  readonly err: string[];
}
export function captureIo(): CapturedIo {
  const out: string[] = [],
    err: string[] = [];
  return { out, err, stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
}
