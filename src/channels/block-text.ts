/**
 * Line breaks the Chat SDK loses between blocks.
 *
 * `Message.text` is the plain text of the parsed message, and for a Slack
 * numbered list the SDK glues the items together with nothing between them:
 * Ctibor's answer "1. pätička / 2. ok kontakt / 3. áno secondary" reached the
 * agent as "patickaok kontaktano secondary", and the agent confirmed
 * "variant: primary" from it (2026-10-04). The structure is still in
 * `formatted` (an mdast tree), so the text is rebuilt from it with a line per
 * block and list item.
 *
 * Only when it is safe: the text is replaced only if it is exactly the leaves
 * of the tree glued without separators — i.e. what the SDK produced — so the
 * change can only ever add line breaks and list markers, never drop or alter a
 * word, a mention or a link the tree renders differently.
 */
interface Node {
  type?: string;
  value?: unknown;
  children?: Node[];
  ordered?: boolean;
  start?: number | null;
}

const BLOCKS = new Set([
  'root',
  'paragraph',
  'heading',
  'blockquote',
  'list',
  'listItem',
  'code',
  'thematicBreak',
  'table',
  'tableRow',
]);

/** The leaves glued with nothing in between — the SDK's flattening. */
export function flatText(node: Node): string {
  if (typeof node.value === 'string') return node.value;
  return (node.children || []).map(flatText).join('');
}

function hasBlockBoundary(node: Node): boolean {
  const kids = node.children || [];
  if (node.type === 'list' && kids.length > 1) return true;
  if (
    (node.type === 'root' || node.type === 'blockquote' || node.type === 'listItem') &&
    kids.filter((k) => BLOCKS.has(k.type || '')).length > 1
  )
    return true;
  return kids.some(hasBlockBoundary);
}

function render(node: Node): string {
  if (typeof node.value === 'string') return node.value;
  const kids = node.children || [];
  if (node.type === 'list') {
    const start = typeof node.start === 'number' ? node.start : 1;
    return kids.map((item, i) => `${node.ordered ? `${start + i}.` : '-'} ${render(item)}`).join('\n');
  }
  if (node.type === 'root' || node.type === 'blockquote' || node.type === 'listItem') {
    return kids.map(render).join('\n');
  }
  return kids.map(render).join('');
}

/**
 * The text with its block line breaks restored, or null when the tree is
 * missing, has no block boundaries, or does not match the text exactly.
 */
function hasList(node: Node): boolean {
  return node.type === 'list' || (node.children || []).some(hasList);
}

export function blockText(text: unknown, formatted: unknown): string | null {
  if (typeof text !== 'string' || !formatted || typeof formatted !== 'object') return null;
  const root = formatted as Node;
  if (root.type !== 'root') return null;
  // "1." alone parses as a list with one EMPTY item, and the text comes out empty:
  // Ctibor's answer "1." reached the agent as nothing (2026-10-12). The markers are the message.
  if (text === '') {
    if (!hasList(root) || flatText(root) !== '') return null;
    return render(root).trim() || null;
  }
  if (!hasBlockBoundary(root)) return null;
  if (flatText(root) !== text) return null;
  const rebuilt = render(root);
  return rebuilt !== text ? rebuilt : null;
}
