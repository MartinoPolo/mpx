import type { PublicError } from '@mpx/core';
import { errorSolutions, type ErrorSolution } from './error-guidance.js';

const ansiEscape = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/gu;
const controls = /[\u0000-\u001f\u007f-\u009f]+/gu;
const placeholder = /<[^<>\r\n]+>/u;

function terminalSafe(value: string): string {
  return value.replace(ansiEscape, '').replace(controls, ' ').replace(/\s+/gu, ' ').trim();
}

function renderSolution(solution: ErrorSolution): string {
  const explanation = terminalSafe(solution.explanation);
  if (!solution.command) {
    return explanation;
  }
  return `${terminalSafe(solution.command)} - ${explanation}`;
}

export function formatHumanError(error: PublicError, usage?: string): string {
  const safeUsage = usage?.trim();
  const originalMessage = error.message.trim();
  const reason =
    safeUsage && originalMessage === safeUsage
      ? 'Invalid command usage.'
      : terminalSafe(error.message);
  const solutions = errorSolutions(error.code);
  const rendered = [
    ...(error.remediation ? [terminalSafe(error.remediation)] : []),
    ...solutions.map(renderSolution),
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
