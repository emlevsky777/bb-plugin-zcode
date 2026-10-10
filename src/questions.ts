import { interactionRequestPayloadSchema, pendingInteractionResolutionSchema,
  isUserQuestionPendingInteractionResolution } from '@get-bb/plugin-sdk/provider-bridge';
import { ProtocolError, record, string } from './errors.ts';
import type { Snapshot } from './native.ts';

// OSS29628c9 protocol/index.ts2356 + interaction-broker.ts475; installed0.16.9.
// No content is logged by this adapter. Unsupported schemas fail visibly.
export function nativeQuestion(value: unknown) {
  const params = record(value), requestId = string(params.requestId);
  const sessionId = string(params.sessionId);
  if (params.toolName !== 'AskUserQuestion' || !Array.isArray(params.questions) ||
      !params.questions.length || params.questions.length > 4) throw new ProtocolError('unsupported-user-input');
  const originals = params.questions.map((value, index) => {
    const q = record(value);
    if (!Array.isArray(q.options) || !q.options.length || q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean')
      throw new ProtocolError('invalid-question-options');
    const options = q.options.map(value => {
      const o = record(value);
      return { value: string(o.value), label: string(o.label),
        ...(typeof o.description === 'string' && o.description.trim() ? { description: o.description } : {}) };
    });
    if (new Set(options.map(o => o.value)).size !== options.length) throw new ProtocolError('duplicate-question-options');
    return { id: `${requestId}:question-${index + 1}`, prompt: string(q.question), shortLabel: string(q.header),
      multiSelect: q.multiSelect === true, options, allowFreeText: true };
  });
  const payload = interactionRequestPayloadSchema.parse({ kind: 'user_question', questions: originals.map(q => ({
    ...q, ...(q.options.length > 4 ? { options: undefined,
      prompt: q.prompt + '\n' + q.options.map(o => `${o.label}: ${o.value}${o.description ? ' — ' + o.description : ''}`).join('\n') } : {}) })) });
  return { requestId, sessionId, turnId: string(params.turnId), toolCallId: string(params.toolCallId), payload, originals };
}
// OSS29628c9 rows.ts191/snapshot.ts310: the interaction's legacy turn ID
// differs from the conversation message ID. Bind only by the exact pending
// interaction anchor and toolCallId; never guess the latest/current turn.
export function questionTurn(snapshot: Snapshot, question: ReturnType<typeof nativeQuestion>): string | null {
  if (!Array.isArray(snapshot.pendingInteractions)) return null;
  const pending = snapshot.pendingInteractions.map(record).filter(p => p.interactionId === question.requestId);
  if (!pending.length) return null; // The reverse request can precede its frame.
  if (pending.length !== 1) throw new ProtocolError('ambiguous-question-anchor');
  const p = pending[0]!, payload = record(p.payload);
  const rows = snapshot.rows.window.filter(r => r.kind === 'toolCall' && r.toolCallId === question.toolCallId);
  if (p.kind !== 'userInput' || payload.toolCallId !== question.toolCallId || rows.length !== 1 ||
      rows[0]!.rowId !== p.anchorRowId || rows[0]!.toolName !== 'AskUserQuestion' || rows[0]!.status !== 'pendingApproval')
    throw new ProtocolError('unconfirmed-question-anchor');
  return string(rows[0]!.turnId);
}
export function nativeAnswer(question: ReturnType<typeof nativeQuestion>, value: unknown) {
  // Installed bridge-protocol-adapter.buildInteractiveResponse returns the
  // resolution alone; the lifecycle outcome's payload/resolution wrapper is
  // a different API and must not be required on the reverse-RPC wire.
  const resolution = pendingInteractionResolutionSchema.parse(value);
  if (!isUserQuestionPendingInteractionResolution(resolution)) throw new ProtocolError('invalid-question-resolution');
  const answers: Record<string, string> = {};
  for (const [id, answer] of Object.entries(resolution.answers)) {
    const q = question.originals.find(q => q.id === id);
    if (!q || !q.multiSelect && answer.selected.length > 1 || new Set(answer.selected).size !== answer.selected.length ||
        answer.selected.some(option => !q.options.some(o => o.value === option))) throw new ProtocolError('invalid-question-answer');
    const parts = [...answer.selected, ...(answer.freeText ? [answer.freeText] : [])];
    if (parts.length) answers[q.prompt] = parts.join(', ');
  }
  return { action: 'accept', content: { answers } };
}
