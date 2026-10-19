/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Serializes a Chromium accessibility tree (CDP `Accessibility.getFullAXTree`)
 * into a compact, indented text snapshot — the token-efficient page
 * representation `check_in_browser` feeds the model in place of a screenshot.
 *
 * Why this shape: a full PNG screenshot costs real image tokens on every
 * check, and a raw DOM dump is mostly boilerplate. The accessibility tree is
 * the page's *meaning* — roles, labels, and the text a user actually reads —
 * so it is the smallest representation that still lets the model verify "does
 * the heading render", "is the button labeled right". This mirrors the same
 * choice Playwright's `accessibility.snapshot` and Chrome DevTools MCP's
 * `snapshot` both make.
 *
 * The serializer is a pure function over a minimal `AxNode` subset so it can
 * be unit-tested in plain Node against a captured real tree, with no
 * dependency on the extension host (see `axTree.test.ts`).
 */

/** The subset of CDP `Accessibility.AXNode` the serializer reads. Every field
 * is optional because the wire shape varies across Chromium versions; the
 * walk below treats each absent field as empty rather than assuming. */
export interface AxNode {
	nodeId: string;
	ignored?: boolean;
	role?: { value?: string };
	name?: { value?: string };
	value?: { value?: string };
	childIds?: string[];
}

/** Ceiling on how many nodes one snapshot may emit — the token bound that is
 * the whole point of the feature. A page whose tree is larger is cut off with
 * an explicit marker rather than silently paying for the whole thing. */
export const AX_TREE_MAX_NODES = 200;

/** Depth at which the walk stops descending; a pathological nesting should
 * not blow past the node cap on indentation alone. */
export const AX_TREE_MAX_DEPTH = 20;

/** Roles that carry the page's prose. Emitted as their bare name (indented
 * under the element they belong to), even though Chromium marks them
 * `ignored` — skipping them would strip every word off the page. */
const TEXT_ROLES = new Set(['statictext', 'text']);

/** Roles whose current value is worth showing alongside the label: a filled
 * textbox or selected option is the difference between "the field exists" and
 * "the field says the right thing". */
const VALUE_ROLES = new Set(['textbox', 'combobox', 'searchbox', 'spinbutton', 'slider']);

export function serializeAxTree(nodes: AxNode[]): string {
	if (nodes.length === 0) {
		return '';
	}

	const byId = new Map<string, AxNode>();
	for (const node of nodes) {
		if (node.nodeId) {
			byId.set(node.nodeId, node);
		}
	}

	// The root is whichever node is referenced by no one else's `childIds`;
	// prefer an explicit `RootWebArea` when present, since some trees attach a
	// document-level wrapper around it.
	const referenced = new Set<string>();
	for (const node of nodes) {
		for (const childId of node.childIds ?? []) {
			referenced.add(childId);
		}
	}
	let root = nodes.find(n => (n.role?.value ?? '').trim().toLowerCase() === 'rootwebarea');
	if (!root) {
		root = nodes.find(n => !referenced.has(n.nodeId));
	}
	if (!root) {
		root = nodes[0];
	}

	const lines: string[] = [];
	let emitted = 0;
	let truncated = false;

	const walk = (node: AxNode, depth: number): void => {
		if (emitted >= AX_TREE_MAX_NODES) {
			truncated = true;
			return;
		}
		if (depth > AX_TREE_MAX_DEPTH) {
			return;
		}

		const role = (node.role?.value ?? '').trim().toLowerCase();
		const name = (node.name?.value ?? '').trim();
		const value = (node.value?.value ?? '').trim();

		// Emit a node unless it is an ignored structural node. Text nodes are
		// the exception: Chromium marks them `ignored`, but they carry the
		// page's actual words, so they emit as their name. An `InlineTextBox`
		// (also ignored, but not a TEXT_ROLE) is skipped as the duplicate of
		// its `StaticText` parent.
		//
		// A folded node adds no indent to its children: an ignored `generic`
		// wrapper is invisible, so indenting its text as if it were a real
		// level pads the snapshot with whitespace for no structure. `childDepth`
		// tracks *emitted* depth, not raw tree depth, which keeps the snapshot
		// compact on the deep `generic`-heavy trees Chromium actually produces.
		const isText = TEXT_ROLES.has(role);
		let childDepth = depth;
		if (!node.ignored || isText) {
			if (isText) {
				if (name) {
					lines.push(`${indent(depth)}${name}`);
					emitted += 1;
				}
			} else {
				let line = `${indent(depth)}${role || 'unknown'}`;
				if (name) {
					line += ` "${name}"`;
				}
				if (value && VALUE_ROLES.has(role)) {
					line += ` = "${value}"`;
				}
				lines.push(line);
				emitted += 1;
			}
			childDepth = depth + 1;
		}

		for (const childId of node.childIds ?? []) {
			const child = byId.get(childId);
			if (child) {
				walk(child, childDepth);
			}
		}
	};

	walk(root, 0);

	if (truncated) {
		lines.push('… (truncated)');
	}

	return lines.join('\n');
}

function indent(depth: number): string {
	return '  '.repeat(depth);
}
