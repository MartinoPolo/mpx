// A session's id from its transcript path: a Claude transcript is named by the id, a Pi transcript by its start time,
// an underscore and the id. Undefined for anything that is not a transcript, such as an automation run's id.
export function sessionIdOfTranscript(transcriptPath) {
  const fileName = typeof transcriptPath === 'string' ? transcriptPath.split(/[\\/]/).at(-1) : '';
  return fileName.endsWith('.jsonl') ? fileName.slice(0, -'.jsonl'.length).split('_').at(-1) || undefined : undefined;
}
