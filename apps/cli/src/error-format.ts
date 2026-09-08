import type { PublicError } from '@mpx/core';
import { errorSolutions, type ErrorSolution } from './error-guidance.js';

const ansiEscape = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu;
const controls = /[\u0000-\u001f\u007f-\u009f]+/gu;
const placeholder = /<[^<>\r\n]+>/u;
const boldCyan = '\u001b[1;36m';
const resetStyle = '\u001b[0m';

export interface HumanErrorFormatOptions {
  color?: boolean;
}

function terminalSafe(value: string): string {
  return value.replace(ansiEscape, '').replace(controls, ' ').replace(/\s+/gu, ' ').trim();
}

function renderSolution(solution: ErrorSolution, color: boolean): string {
  const explanation = terminalSafe(solution.explanation);
  if (!solution.command) {
    return explanation;
  }
  const command = terminalSafe(solution.command);
  const renderedCommand = color ? `${boldCyan}${command}${resetStyle}` : command;
  return `${renderedCommand} - ${explanation}`;
}

export function formatHumanError(
  error: PublicError,
  usage?: string,
  options: HumanErrorFormatOptions = {},
): string {
  const safeUsage = usage?.trim();
  const originalMessage = error.message.trim();
  const reason =
    safeUsage && originalMessage === safeUsage
      ? 'Invalid command usage.'
      : terminalSafe(error.message);
  const solutions = errorSolutions(error.code);
  const rendered = [
    ...(error.remediation ? [terminalSafe(error.remediation)] : []),
    ...solutions.map((solution) => renderSolution(solution, options.color === true)),
  ].filter(Boolean);
  if (rendered.length === 0) {
    rendered.push('No specific workaround is available. Review the error and try again.');
  }
  if (solutions.some((solution) => solution.command && placeholder.test(solution.command))) {
    rendered.push(
      'Replace angle-bracket placeholders with the appropriate values before running a command.',
    );
  }

  const sections = [
    `ERROR [${terminalSafe(error.code)}] - ${reason}`,
    `POSSIBLE SOLUTIONS/WORKAROUNDS\n${rendered.join('\n')}`,
  ];
  if (safeUsage) {
    sections.push(safeUsage);
  }
  return `${sections.join('\n\n')}\n`;
}
