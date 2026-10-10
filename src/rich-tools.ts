import type { ThreadDelta } from '@get-bb/plugin-sdk/provider-bridge';
import type { Row } from './native.ts';
import type { Warn } from './errors.ts';
import { record } from './errors.ts';
type Shape = Extract<ThreadDelta, { kind: 'item.open' }>['item'];
// Native29628c9: tool handlers/input schemas and V4 rows/toolDisplay. Never
// reconstruct missing exitCode, originalFile, patches, or execution usage.
export function richTool(row: Row, cwd: string, warn: Warn): Shape {
  const tool = String(row.toolName), a = row.input && typeof row.input === 'object' && !Array.isArray(row.input) ? record(row.input) : {};
  const knownInputs: Record<string, string[]> = {
    Bash: ['command','timeout','description','run_in_background','dangerouslyDisableSandbox'],
    Read: ['file_path','offset','limit','pages'], Write: ['file_path','content'],
    Edit: ['file_path','old_string','new_string','replace_all'], Grep: ['pattern','path','glob','output_mode','-B','-A','-C','-n','-i','type','head_limit','offset','multiline'],
    Glob: ['pattern','path'], WebSearch: ['query','allowed_domains','blocked_domains','maxUses'], WebFetch: ['url','prompt'], TodoWrite: ['todos'],
  };
  if (knownInputs[tool] && Object.keys(a).some(k => !knownInputs[tool]!.includes(k)))
    warn({ code: 'native-tool-extra-fields' }, row.rowId);
  const output = row.output && typeof row.output === 'object' ? record(row.output) : {};
  const text = typeof output.text === 'string' ? output.text : undefined;
  if (tool === 'Bash' && typeof a.command === 'string' && cwd) return {
    type: 'command', command: a.command, cwd,
    ...(text !== undefined ? { aggregatedOutput: text } : {}),
  };
  if (tool === 'Read' && typeof a.file_path === 'string') return { type: 'fileRead', path: a.file_path };
  if ((tool === 'Write' || tool === 'Edit') && typeof a.file_path === 'string') {
    // An attempted write has no proven change kind until native supplies it.
    // Native file_diff is authoritative; no made-up add/update diff is emitted.
    const display = output.display && typeof output.display === 'object' ? record(output.display) : {};
    if (tool === 'Write' && row.status === 'success' && text?.startsWith(`File created successfully at: ${a.file_path}`))
      return { type: 'fileChange', changes: [{ path: a.file_path, kind: 'add' }] };
    if (display.kind === 'file_diff' && display.filePath === a.file_path && Array.isArray(display.structuredPatch)) {
      return { type: 'fileChange', changes: [{ path: a.file_path, kind: 'update' }] };
    }
    if (tool === 'Edit') return { type: 'fileChange', changes: [{ path: a.file_path, kind: 'update' }] };
    // Write can create OR replace. Native input alone does not say which.
    // Empty changes while running is honest; completion needs native output.
    if (row.status !== 'success') return { type: 'fileChange', changes: [] };
    if (text?.startsWith('File created successfully at:')) return { type: 'fileChange', changes: [{ path: a.file_path, kind: 'add' }] };
    if (text?.startsWith('The file ') && text.includes(' has been updated successfully.')) return { type: 'fileChange', changes: [{ path: a.file_path, kind: 'update' }] };
    warn({ code: 'file-change-kind-unavailable' }, row.rowId);
    return { type: 'fileChange', changes: [] };
  }
  if ((tool === 'Grep' || tool === 'Glob') && typeof a.pattern === 'string') return {
    type: 'search', mode: tool === 'Glob' ? 'path' : 'content', query: a.pattern,
    ...(typeof a.path === 'string' ? { path: a.path } : {}),
  };
  if (tool === 'WebSearch' && typeof a.query === 'string') return { type: 'webSearch', queries: [a.query] };
  if (tool === 'WebFetch' && typeof a.url === 'string') return { type: 'webFetch', url: a.url,
    prompt: typeof a.prompt === 'string' ? a.prompt : null, pattern: null };
  if (tool === 'TodoWrite' && Array.isArray(a.todos) && a.todos.every(value => value && typeof value === 'object' &&
      typeof record(value).content === 'string' && ['pending', 'in_progress', 'completed'].includes(String(record(value).status)))) {
    return { type: 'planSteps', steps: a.todos.map(value => {
      const t = record(value); return { step: String(t.content), status: t.status === 'in_progress' ? 'active' : t.status === 'completed' ? 'completed' : 'pending' };
    }) };
  }
  const display = row.display && typeof row.display === 'object' ? record(row.display) :
    output.display && typeof output.display === 'object' ? record(output.display) : {};
  if (display.kind === 'mcp_tool' && typeof display.serverName === 'string' && typeof display.toolName === 'string')
    return { type: 'tool', server: display.serverName, tool: display.toolName, args: row.input ?? {} };
  // Schema-valid unknown tool does not establish a native semantic mapping.
  warn({ code: 'generic-native-tool' }, [row.rowId, tool]);
  return { type: 'tool', tool, args: row.input ?? {} };
}
export function richPresentation(row: Row, shape: Shape): Extract<ThreadDelta, { kind: 'item.open' }>['presentation'] {
  if (shape.type === 'tool') return undefined;
  const output = row.output && typeof row.output === 'object' ? record(row.output) : {};
  const text = typeof output.text === 'string' ? output.text : undefined;
  return { label: { pending: String(row.toolName), completed: String(row.toolName) }, icon: { glyph: shape.type === 'command' ? 'Terminal' : 'FileText' },
    title: String(row.toolName), ...(text ? { detail: text.length > 280 ? text.slice(0, 277) + '…' : text } : {}) };
}
