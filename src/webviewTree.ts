type TreeNodeKind = 'workspace' | 'folder' | 'file';

export type TreePresentationInputNode = {
	kind: TreeNodeKind;
	label: string;
	key: string;
	path?: string;
	children: TreePresentationInputNode[];
};

export type WebviewTreeNode = {
	kind: TreeNodeKind;
	label: string;
	key: string;
	path?: string;
	children: WebviewTreeNode[];
	rawLabel: string;
	multiLabel: boolean;
	aliases: string[];
	branchKeys: string[];
};

const uniqueKeys = (keys: string[]): string[] => Array.from(new Set(keys));

const compactNode = (node: TreePresentationInputNode): WebviewTreeNode => {
	if (node.kind === 'file') {
		return {
			kind: node.kind,
			label: node.label,
			key: node.key,
			path: node.path,
			children: [],
			rawLabel: node.label,
			multiLabel: false,
			aliases: [node.key],
			branchKeys: []
		};
	}

	if (node.kind === 'folder') {
		let current = node;
		const labels = [node.label];
		const aliases = [node.key];

		while (current.children.length === 1 && current.children[0]?.kind === 'folder') {
			current = current.children[0];
			labels.push(current.label);
			aliases.push(current.key);
		}

		const children = current.children.map(compactNode);
		return {
			kind: node.kind,
			label: node.label,
			key: current.key,
			path: current.path,
			children,
			rawLabel: labels.join('/'),
			multiLabel: labels.length > 1,
			aliases,
			branchKeys: uniqueKeys([...aliases, ...children.flatMap((child) => child.branchKeys)])
		};
	}

	const children = node.children.map(compactNode);
	return {
		kind: node.kind,
		label: node.label,
		key: node.key,
		path: node.path,
		children,
		rawLabel: node.label,
		multiLabel: false,
		aliases: [node.key],
		branchKeys: uniqueKeys([node.key, ...children.flatMap((child) => child.branchKeys)])
	};
};

export const buildWebviewTree = (nodes: readonly TreePresentationInputNode[]): WebviewTreeNode[] => {
	return nodes.map(compactNode);
};

export const findWebviewNodeByKey = (
	nodes: readonly WebviewTreeNode[],
	key: string
): WebviewTreeNode | undefined => {
	for (const node of nodes) {
		if (node.key === key) {
			return node;
		}

		const nested = findWebviewNodeByKey(node.children, key);
		if (nested) {
			return nested;
		}
	}

	return undefined;
};

export const isBranchExpanded = (
	node: WebviewTreeNode,
	expandedKeys: ReadonlySet<string>,
	forceExpand = false
): boolean => {
	if (forceExpand) {
		return true;
	}

	return node.branchKeys.some((key) => expandedKeys.has(key));
};