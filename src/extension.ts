import * as path from 'path';
import * as vscode from 'vscode';
import { minimatch } from 'minimatch';

type ScriptNodeKind = 'workspace' | 'folder' | 'file';

type ScriptNode = {
	kind: ScriptNodeKind;
	label: string;
	key: string;
	uri?: vscode.Uri;
	children: Map<string, ScriptNode>;
	parent?: ScriptNode;
};

class ScriptItem extends vscode.TreeItem {
	public readonly node: ScriptNode;
	private readonly expandedKeys: ReadonlySet<string>;
	private readonly favoriteKeys: ReadonlySet<string>;

	constructor(
		node: ScriptNode,
		expandedKeys: ReadonlySet<string>,
		favoriteKeys: ReadonlySet<string>,
		displayLabel?: string
	) {
		super(
			displayLabel ?? node.label,
			node.kind === 'file'
				? vscode.TreeItemCollapsibleState.None
				: expandedKeys.has(node.key)
					? vscode.TreeItemCollapsibleState.Expanded
					: vscode.TreeItemCollapsibleState.Collapsed
		);
		this.node = node;
		this.expandedKeys = expandedKeys;
		this.favoriteKeys = favoriteKeys;
		this.id = node.key;

		if (node.kind === 'file' && node.uri) {
			this.tooltip = node.uri.fsPath;
			this.contextValue = 'sh-explorer.script';
			this.iconPath = this.favoriteKeys.has(node.key)
				? new vscode.ThemeIcon('star-full')
				: new vscode.ThemeIcon('file-code');
			if (this.favoriteKeys.has(node.key)) {
				this.label = {
					label: node.label,
					highlights: [[0, node.label.length]]
				};
				// this.description = '★';
				this.description = undefined;
			} else {
				this.description = undefined;
			}
		} else {
			this.contextValue = 'sh-explorer.folder';
			this.iconPath = new vscode.ThemeIcon('folder');
		}
	}
}

class ShScriptsProvider implements vscode.TreeDataProvider<ScriptItem>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<ScriptItem | undefined>();
	public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private roots: ScriptNode[] = [];
	private readonly expandedKeys: Set<string>;
	private readonly nodeIndex = new Map<string, ScriptNode>();
	private readonly itemCache = new Map<string, ScriptItem>();
	private readonly getExcludeGlobs: () => string[];
	private readonly getIncludeExtensions: () => string[];
	private readonly favoriteKeys: Set<string>;
	private refreshChain: Promise<string[]> = Promise.resolve([]);
	private refreshToken = 0;

	constructor(
		expandedKeys: Set<string>,
		favoriteKeys: Set<string>,
		getExcludeGlobs: () => string[],
		getIncludeExtensions: () => string[]
	) {
		this.expandedKeys = expandedKeys;
		this.favoriteKeys = favoriteKeys;
		this.getExcludeGlobs = getExcludeGlobs;
		this.getIncludeExtensions = getIncludeExtensions;
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	refresh(): void {
		this.roots = [];
		this.nodeIndex.clear();
		this.itemCache.clear();
		this._onDidChangeTreeData.fire(undefined);
	}

	refreshItems(): void {
		this.itemCache.clear();
		this._onDidChangeTreeData.fire(undefined);
	}

	loadFromCachedPaths(paths: string[]): void {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			return;
		}
		const patterns = this.getNormalizedExcludeGlobs();
		const extensions = this.getNormalizedExtensions();
		const uris = paths
			.map((entry) => vscode.Uri.file(entry))
			.filter((uri) => this.isIncludedByExtension(uri, extensions))
			.filter((uri) => !this.isExcluded(uri, patterns));
		this.roots = this.buildTreeFromUris(uris, folders);
		this.itemCache.clear();
		this._onDidChangeTreeData.fire(undefined);
	}

	async loadFromWorkspace(): Promise<string[]> {
		const token = ++this.refreshToken;
		const task = async (): Promise<string[]> => {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders || folders.length === 0) {
				if (token === this.refreshToken) {
					this.refresh();
				}
				return [];
			}
			const patterns = this.getNormalizedExcludeGlobs();
			const excludePattern = patterns.length > 0 ? `{${patterns.join(',')}}` : undefined;
			const includePattern = this.getIncludePattern();
			if (!includePattern) {
				if (token === this.refreshToken) {
					this.refresh();
				}
				return [];
			}
			const files = await vscode.workspace.findFiles(includePattern, excludePattern);
			if (token !== this.refreshToken) {
				return [];
			}
			this.roots = this.buildTreeFromUris(files, folders);
			this.itemCache.clear();
			this._onDidChangeTreeData.fire(undefined);
			return files.map((entry) => entry.fsPath);
		};
		this.refreshChain = this.refreshChain.then(task, task);
		return this.refreshChain;
	}

	getTreeItem(element: ScriptItem): vscode.TreeItem {
		return element;
	}

	getParent(element: ScriptItem): ScriptItem | undefined {
		const parent = this.getVisibleParent(element.node);
		if (!parent) {
			return undefined;
		}
		return this.getOrCreateItem(parent);
	}

	async getChildren(element?: ScriptItem): Promise<ScriptItem[]> {
		if (!element) {
			if (this.roots.length === 0) {
				this.roots = await this.buildTree();
			}
			return this.roots.map((node) => this.getOrCreateItem(node));
		}
		const { tail } = this.getCompactInfo(element.node);
		const children = Array.from(tail.children.values()).filter((node) => !this.isHiddenByCompaction(node));
		children.sort((a, b) => a.label.localeCompare(b.label));
		return children.map((node) => this.getOrCreateItem(node));
	}

	async ensureTree(): Promise<void> {
		if (this.roots.length === 0) {
			this.roots = await this.buildTree();
		}
	}

	getItemByKey(key: string): ScriptItem | undefined {
		const node = this.nodeIndex.get(key);
		if (!node) {
			return undefined;
		}
		const visibleNode = this.getVisibleNode(node);
		return this.getOrCreateItem(visibleNode);
	}

	hasRoots(): boolean {
		return this.roots.length > 0;
	}

	private getOrCreateItem(node: ScriptNode): ScriptItem {
		const existing = this.itemCache.get(node.key);
		if (existing) {
			return existing;
		}
		const { label } = this.getCompactInfo(node);
		const created = new ScriptItem(node, this.expandedKeys, this.favoriteKeys, label);
		this.itemCache.set(node.key, created);
		return created;
	}

	private isHiddenByCompaction(node: ScriptNode): boolean {
		const parent = node.parent;
		if (!parent) {
			return false;
		}
		if (parent.kind !== 'folder') {
			return false;
		}
		if (parent.children.size !== 1) {
			return false;
		}
		const onlyChild = parent.children.values().next().value as ScriptNode | undefined;
		return !!onlyChild && onlyChild.kind === 'folder';
	}

	private getVisibleParent(node: ScriptNode): ScriptNode | undefined {
		let current = node.parent;
		while (current && this.isHiddenByCompaction(current)) {
			current = current.parent;
		}
		return current;
	}

	private getVisibleNode(node: ScriptNode): ScriptNode {
		let current: ScriptNode = node;
		while (this.isHiddenByCompaction(current)) {
			if (!current.parent) {
				return current;
			}
			current = current.parent;
		}
		return current;
	}

	private getCompactInfo(node: ScriptNode): { label: string; tail: ScriptNode } {
		if (node.kind !== 'folder') {
			return { label: node.label, tail: node };
		}
		let current = node;
		const labels = [node.label];
		while (current.kind === 'folder') {
			if (current.children.size !== 1) {
				break;
			}
			const onlyChild = current.children.values().next().value as ScriptNode | undefined;
			if (!onlyChild || onlyChild.kind !== 'folder') {
				break;
			}
			labels.push(onlyChild.label);
			current = onlyChild;
		}
		return { label: labels.join('/'), tail: current };
	}


	private async buildTree(): Promise<ScriptNode[]> {
		await this.loadFromWorkspace();
		return this.roots;
	}

	private getNormalizedExtensions(): string[] {
		return this.getIncludeExtensions()
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
			.map((entry) => (entry.startsWith('.') ? entry.slice(1) : entry))
			.map((entry) => entry.replace(/^\.+/, ''))
			.filter((entry) => entry.length > 0)
			.filter((entry) => !entry.includes('*') && !entry.includes('?') && !entry.includes('['))
			.filter((entry) => !entry.includes('/') && !entry.includes('\\'))
			.map((entry) => entry.toLowerCase());
	}

	private getIncludePattern(): string | undefined {
		const extensions = this.getNormalizedExtensions();
		if (extensions.length === 0) {
			return undefined;
		}
		if (extensions.length === 1) {
			return `**/*.${extensions[0]}`;
		}
		return `**/*.{${extensions.join(',')}}`;
	}

	private isIncludedByExtension(uri: vscode.Uri, extensions: string[]): boolean {
		if (extensions.length === 0) {
			return false;
		}
		const ext = path.extname(uri.fsPath).replace(/^\./, '').toLowerCase();
		return extensions.includes(ext);
	}

	private getNormalizedExcludeGlobs(): string[] {
		return this.getExcludeGlobs()
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
			.flatMap((entry) => {
				const hasWildcard = entry.includes('*') || entry.includes('?') || entry.includes('[');
				const hasSlash = entry.includes('/') || entry.includes('\\');
				if (!hasWildcard && !hasSlash) {
					return [`**/${entry}/**`];
				}
				return [entry];
			});
	}

	private isExcluded(uri: vscode.Uri, patterns: string[]): boolean {
		if (patterns.length === 0) {
			return false;
		}
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder) {
			return false;
		}
		const relativePath = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
		return patterns.some((pattern) => minimatch(relativePath, pattern, { dot: true }));
	}

	private buildTreeFromUris(uris: vscode.Uri[], folders: readonly vscode.WorkspaceFolder[]): ScriptNode[] {
		const rootNodes: ScriptNode[] = [];
		const rootMap = new Map<string, ScriptNode>();
		this.nodeIndex.clear();

		const ensureNode = (parent: ScriptNode, label: string, kind: ScriptNodeKind): ScriptNode => {
			const existing = parent.children.get(label);
			if (existing) {
				return existing;
			}
			const key = parent.kind === 'workspace'
				? `${parent.key}::${label}`
				: `${parent.key}::${label}`;
			const created: ScriptNode = {
				kind,
				label,
				key,
				children: new Map(),
				parent
			};
			parent.children.set(label, created);
			this.nodeIndex.set(created.key, created);
			return created;
		};

		for (const folder of folders) {
			const rootLabel = folder.name;
			const rootKey = path.resolve(folder.uri.fsPath);
			const root: ScriptNode = {
				kind: 'workspace',
				label: rootLabel,
				key: rootKey,
				children: new Map()
			};
			rootNodes.push(root);
			rootMap.set(folder.uri.fsPath, root);
			this.nodeIndex.set(root.key, root);
		}

		for (const uri of uris) {
			const folder = vscode.workspace.getWorkspaceFolder(uri);
			if (!folder) {
				continue;
			}
			const root = rootMap.get(folder.uri.fsPath);
			if (!root) {
				continue;
			}
			const relativePath = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
			const parts = relativePath.split('/');
			let current = root;
			for (let i = 0; i < parts.length; i += 1) {
				const part = parts[i];
				if (i === parts.length - 1) {
					const fileNode = ensureNode(current, part, 'file');
					fileNode.uri = uri;
				} else {
					current = ensureNode(current, part, 'folder');
				}
			}
		}

		rootNodes.sort((a, b) => a.label.localeCompare(b.label));
		return rootNodes;
	}
}

export function activate(context: vscode.ExtensionContext) {
	const expandedStateKey = 'sh-explorer.expandedNodes';
	const selectedStateKey = 'sh-explorer.selectedNode';
	const scrollTopStateKey = 'sh-explorer.scrollTop';
	const cachedScriptsKey = 'sh-explorer.cachedScripts';
	const favoritesKey = 'sh-explorer.favorites';
	const recentRunsKey = 'sh-explorer.recentRuns';

	const normalizeRootKey = (rawRootKey: string): string => {
		if (rawRootKey.startsWith('file://')) {
			return path.resolve(vscode.Uri.parse(rawRootKey).fsPath);
		}
		return path.resolve(rawRootKey);
	};

	const normalizeKey = (key: string): string => {
		const separator = '::';
		const separatorIndex = key.indexOf(separator);
		if (separatorIndex === -1) {
			return normalizeRootKey(key);
		}
		const rawRootKey = key.slice(0, separatorIndex);
		const rest = key.slice(separatorIndex);
		return `${normalizeRootKey(rawRootKey)}${rest}`;
	};

	const getExcludeGlobs = (): string[] => {
		return vscode.workspace.getConfiguration('sh-explorer').get<string[]>('exclude', []);
	};

	const getIncludeExtensions = (): string[] => {
		return vscode.workspace
			.getConfiguration('sh-explorer')
			.get<string[]>('extensions', ['.bat', '.cmd', '.sh']);
	};

	type PersistMessage = {
		type: 'persistState';
		expandedKeys?: string[];
		selectedKey?: string;
		scrollTop?: number;
	};

	type WebviewMessage =
		| { type: 'ready' }
		| { type: 'refresh' }
		| { type: 'run'; key?: string }
		| { type: 'open'; key?: string }
		| { type: 'copy'; key?: string }
		| { type: 'toggleFavorite'; key?: string }
		| PersistMessage;

	let expandedKeys = new Set<string>(
		context.workspaceState.get<string[]>(expandedStateKey, []).map(normalizeKey)
	);
	const favoriteKeys = new Set<string>(
		context.workspaceState.get<string[]>(favoritesKey, []).map(normalizeKey)
	);
	let selectedKey = context.workspaceState.get<string | undefined>(selectedStateKey);
	if (selectedKey) {
		selectedKey = normalizeKey(selectedKey);
	}
	let scrollTop = context.workspaceState.get<number>(scrollTopStateKey, 0);
	let recentRuns: string[] = context.globalState.get<string[]>(recentRunsKey, []);

	let roots: ScriptNode[] = [];
	const nodeIndex = new Map<string, ScriptNode>();
	let refreshChain: Promise<string[]> = Promise.resolve([]);
	let refreshToken = 0;
	let webviewView: vscode.WebviewView | undefined;

	const getNormalizedExtensions = (): string[] => {
		return getIncludeExtensions()
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
			.map((entry) => (entry.startsWith('.') ? entry.slice(1) : entry))
			.map((entry) => entry.replace(/^\.+/, ''))
			.filter((entry) => entry.length > 0)
			.filter((entry) => !entry.includes('*') && !entry.includes('?') && !entry.includes('['))
			.filter((entry) => !entry.includes('/') && !entry.includes('\\'))
			.map((entry) => entry.toLowerCase());
	};

	const getIncludePattern = (): string | undefined => {
		const extensions = getNormalizedExtensions();
		if (extensions.length === 0) {
			return undefined;
		}
		if (extensions.length === 1) {
			return `**/*.${extensions[0]}`;
		}
		return `**/*.{${extensions.join(',')}}`;
	};

	const getNormalizedExcludeGlobs = (): string[] => {
		return getExcludeGlobs()
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
			.flatMap((entry) => {
				const hasWildcard = entry.includes('*') || entry.includes('?') || entry.includes('[');
				const hasSlash = entry.includes('/') || entry.includes('\\');
				if (!hasWildcard && !hasSlash) {
					return [`**/${entry}/**`];
				}
				return [entry];
			});
	};

	const isIncludedByExtension = (uri: vscode.Uri, extensions: string[]): boolean => {
		if (extensions.length === 0) {
			return false;
		}
		const ext = path.extname(uri.fsPath).replace(/^\./, '').toLowerCase();
		return extensions.includes(ext);
	};

	const isExcluded = (uri: vscode.Uri, patterns: string[]): boolean => {
		if (patterns.length === 0) {
			return false;
		}
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder) {
			return false;
		}
		const relativePath = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
		return patterns.some((pattern) => minimatch(relativePath, pattern, { dot: true }));
	};

	const buildTreeFromUris = (uris: vscode.Uri[], folders: readonly vscode.WorkspaceFolder[]): ScriptNode[] => {
		const rootNodes: ScriptNode[] = [];
		const rootMap = new Map<string, ScriptNode>();
		nodeIndex.clear();

		const ensureNode = (parent: ScriptNode, label: string, kind: ScriptNodeKind): ScriptNode => {
			const existing = parent.children.get(label);
			if (existing) {
				return existing;
			}
			const key = `${parent.key}::${label}`;
			const created: ScriptNode = {
				kind,
				label,
				key,
				children: new Map(),
				parent
			};
			parent.children.set(label, created);
			nodeIndex.set(created.key, created);
			return created;
		};

		for (const folder of folders) {
			const root: ScriptNode = {
				kind: 'workspace',
				label: folder.name,
				key: path.resolve(folder.uri.fsPath),
				children: new Map()
			};
			rootNodes.push(root);
			rootMap.set(folder.uri.fsPath, root);
			nodeIndex.set(root.key, root);
		}

		for (const uri of uris) {
			const folder = vscode.workspace.getWorkspaceFolder(uri);
			if (!folder) {
				continue;
			}
			const root = rootMap.get(folder.uri.fsPath);
			if (!root) {
				continue;
			}
			const relativePath = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
			const parts = relativePath.split('/');
			let current = root;
			for (let i = 0; i < parts.length; i += 1) {
				const part = parts[i];
				if (i === parts.length - 1) {
					const fileNode = ensureNode(current, part, 'file');
					fileNode.uri = uri;
				} else {
					current = ensureNode(current, part, 'folder');
				}
			}
		}

		rootNodes.sort((a, b) => a.label.localeCompare(b.label));
		return rootNodes;
	};

	const sanitizeStateAgainstTree = () => {
		expandedKeys = new Set(Array.from(expandedKeys).filter((key) => nodeIndex.has(key)));
		favoriteKeys.forEach((key) => {
			if (!nodeIndex.has(key)) {
				favoriteKeys.delete(key);
			}
		});
		if (selectedKey && !nodeIndex.has(selectedKey)) {
			selectedKey = undefined;
		}
	};

	const loadFromCachedPaths = (paths: string[]) => {
		const folders = vscode.workspace.workspaceFolders;
		if (!folders || folders.length === 0) {
			roots = [];
			nodeIndex.clear();
			return;
		}
		const patterns = getNormalizedExcludeGlobs();
		const extensions = getNormalizedExtensions();
		const uris = paths
			.map((entry) => vscode.Uri.file(entry))
			.filter((uri) => isIncludedByExtension(uri, extensions))
			.filter((uri) => !isExcluded(uri, patterns));
		roots = buildTreeFromUris(uris, folders);
		sanitizeStateAgainstTree();
	};

	const loadFromWorkspace = async (): Promise<string[]> => {
		const token = ++refreshToken;
		const task = async (): Promise<string[]> => {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders || folders.length === 0) {
				if (token === refreshToken) {
					roots = [];
					nodeIndex.clear();
				}
				return [];
			}
			const patterns = getNormalizedExcludeGlobs();
			const excludePattern = patterns.length > 0 ? `{${patterns.join(',')}}` : undefined;
			const includePattern = getIncludePattern();
			if (!includePattern) {
				if (token === refreshToken) {
					roots = [];
					nodeIndex.clear();
				}
				return [];
			}
			const files = await vscode.workspace.findFiles(includePattern, excludePattern);
			if (token !== refreshToken) {
				return [];
			}
			roots = buildTreeFromUris(files, folders);
			sanitizeStateAgainstTree();
			return files.map((entry) => entry.fsPath);
		};
		refreshChain = refreshChain.then(task, task);
		return refreshChain;
	};

	const serialize = (node: ScriptNode): { kind: ScriptNodeKind; label: string; key: string; path?: string; children: unknown[] } => {
		const children = Array.from(node.children.values())
			.sort((a, b) => {
				if (a.kind === b.kind) {
					return a.label.localeCompare(b.label);
				}
				if (a.kind === 'file') {
					return 1;
				}
				if (b.kind === 'file') {
					return -1;
				}
				return a.label.localeCompare(b.label);
			})
			.map((child) => serialize(child));
		return {
			kind: node.kind,
			label: node.label,
			key: node.key,
			path: node.uri?.fsPath,
			children
		};
	};

	const postState = () => {
		if (!webviewView) {
			return;
		}
		webviewView.webview.postMessage({
			type: 'state',
			roots: roots.map((entry) => serialize(entry)),
			expandedKeys: Array.from(expandedKeys),
			favoriteKeys: Array.from(favoriteKeys),
			recentKeys: recentRuns,
			selectedKey,
			scrollTop
		});
	};

	const saveExpanded = async () => {
		await context.workspaceState.update(expandedStateKey, Array.from(expandedKeys));
	};
	const saveSelected = async () => {
		await context.workspaceState.update(selectedStateKey, selectedKey);
		await context.globalState.update(selectedStateKey, selectedKey);
	};
	const saveScrollTop = async () => {
		await context.workspaceState.update(scrollTopStateKey, scrollTop);
	};
	const saveFavorites = async () => {
		await context.workspaceState.update(favoritesKey, Array.from(favoriteKeys));
	};

	const resolveNodeByKey = (raw?: string): ScriptNode | undefined => {
		if (!raw) {
			return undefined;
		}
		return nodeIndex.get(normalizeKey(raw));
	};

	const terminalNamePrefix = 'SH Run';
	const runTerminals = new Map<string, vscode.Terminal>();

	const runScriptByKey = (raw?: string) => {
		const node = resolveNodeByKey(raw ?? selectedKey);
		if (!node || node.kind !== 'file' || !node.uri) {
			vscode.window.showWarningMessage('No shell script selected.');
			return;
		}
		const folder = vscode.workspace.getWorkspaceFolder(node.uri);
		const cwd = folder?.uri.fsPath;
		let terminal = runTerminals.get(node.key);
		if (!terminal) {
			terminal = vscode.window.createTerminal({
				name: `${terminalNamePrefix}: ${path.basename(node.uri.fsPath)}`,
				cwd,
				location: vscode.TerminalLocation.Editor
			});
			runTerminals.set(node.key, terminal);
		} else if (cwd) {
			terminal.sendText(`cd "${cwd}"`);
		}
		terminal.show(true);
		terminal.sendText(`bash "${node.uri.fsPath}"`);
		// Track recent runs (most-recent-first, deduplicated, max 10)
		recentRuns = [node.key, ...recentRuns.filter((k) => k !== node.key)].slice(0, 10);
		void context.globalState.update(recentRunsKey, recentRuns);
		postState();
	};

	const openScriptByKey = async (raw?: string) => {
		const node = resolveNodeByKey(raw ?? selectedKey);
		if (!node || node.kind !== 'file' || !node.uri) {
			vscode.window.showWarningMessage('No shell script selected.');
			return;
		}
		await vscode.window.showTextDocument(node.uri, { preview: false, preserveFocus: false });
	};

	const copyPathByKey = async (raw?: string) => {
		const node = resolveNodeByKey(raw ?? selectedKey);
		if (!node || node.kind !== 'file' || !node.uri) {
			vscode.window.showWarningMessage('No shell script selected.');
			return;
		}
		await vscode.env.clipboard.writeText(node.uri.fsPath);
		void vscode.window.setStatusBarMessage('Full path copied', 2000);
	};

	const toggleFavoriteByKey = async (raw?: string) => {
		const node = resolveNodeByKey(raw ?? selectedKey);
		if (!node || node.kind !== 'file') {
			vscode.window.showWarningMessage('No shell script selected.');
			return;
		}
		if (favoriteKeys.has(node.key)) {
			favoriteKeys.delete(node.key);
		} else {
			favoriteKeys.add(node.key);
		}
		await saveFavorites();
		postState();
	};

	const refreshInBackground = async (showMessage = false) => {
		if (showMessage) {
			void vscode.window.setStatusBarMessage('Sh Explorer: обновление...', 1000);
		}
		const paths = await loadFromWorkspace();
		await context.workspaceState.update(cachedScriptsKey, paths);
		postState();
	};

	const getWebviewHtml = (webview: vscode.Webview, codiconsCssUri: vscode.Uri): string => {
		const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const csp = [
			`default-src 'none'`,
			`font-src ${webview.cspSource}`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<link rel="stylesheet" href="${codiconsCssUri}"/>
<style>
*{box-sizing:border-box}
body{margin:0;padding:0;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);font-weight:var(--vscode-font-weight);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);-webkit-user-select:none;user-select:none}
.codicon{font-size:14px;line-height:1}
.toolbar{display:flex;align-items:center;gap:2px;padding:4px 6px;height:35px;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,var(--vscode-panel-border,rgba(128,128,128,.2)))}
.tb-btn{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border:none;background:transparent;color:var(--vscode-icon-foreground);border-radius:4px;cursor:pointer;padding:0;opacity:.85}
.tb-btn:hover{background:var(--vscode-toolbar-hoverBackground);opacity:1}
.tb-btn.active{background:var(--vscode-toolbar-activeBackground,rgba(99,102,110,.31));color:var(--vscode-focusBorder,#007acc)!important;opacity:1}
.tb-sep{width:1px;height:16px;background:var(--vscode-panel-border,rgba(128,128,128,.3));margin:0 3px;flex-shrink:0}
.search-bar{display:flex;align-items:center;gap:4px;padding:3px 6px;height:28px;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,rgba(128,128,128,.2))}
.search-ico{color:var(--vscode-icon-foreground);opacity:.55;flex-shrink:0;display:flex;align-items:center}
.search-input{flex:1;background:var(--vscode-input-background);border:1px solid transparent;color:var(--vscode-input-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);border-radius:2px;padding:1px 4px;outline:none;height:20px;min-width:0}
.search-input:focus{border-color:var(--vscode-focusBorder,#007acc)}
.search-input::placeholder{color:var(--vscode-input-placeholderForeground,rgba(255,255,255,.4))}
.search-clear{display:none;align-items:center;justify-content:center;width:16px;height:16px;border:none;background:transparent;color:var(--vscode-icon-foreground);cursor:pointer;padding:0;opacity:.7;flex-shrink:0}
.search-clear:hover{opacity:1}
.count{font-size:11px;color:var(--vscode-descriptionForeground);padding-right:2px;white-space:nowrap;margin-left:2px}
.tree{overflow-y:auto;overflow-x:hidden}
.tree::-webkit-scrollbar{width:6px}
.tree::-webkit-scrollbar-track{background:transparent}
.tree::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background);border-radius:3px}
.tree::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground)}
.row{position:relative;display:flex;align-items:center;height:22px;padding-right:4px;cursor:pointer;outline:none}
.row:hover{background:var(--vscode-list-hoverBackground)}
.row:hover .label{color:var(--vscode-list-hoverForeground)}
.row.selected{background:var(--vscode-list-inactiveSelectionBackground)}
.row.focused{background:var(--vscode-list-activeSelectionBackground)!important;color:var(--vscode-list-activeSelectionForeground)!important}
.row.focused .label,.row.focused .ico{color:var(--vscode-list-activeSelectionForeground)!important}
@keyframes kidsIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.kids{animation:kidsIn .12s ease}
.kids-static{}
.indent{display:flex;align-items:center;flex-shrink:0}
/* Вертикальная линия папок */
.indent-guide{width:8px;height:22px;border-right:1px solid var(--vscode-tree-indentGuidesStroke,rgba(128,128,128,.15));opacity:.2}
.arrow{display:flex;align-items:center;justify-content:center;width:16px;height:22px;flex-shrink:0;color:var(--vscode-icon-foreground);opacity:.8}
.arrow.leaf{pointer-events:none}
.ico{display:flex;align-items:center;flex-shrink:0;margin-right:5px}
.ico.folder-ico{color:var(--vscode-symbolIcon-folderForeground,#dcb67a)}
.ico.workspace-ico{color:var(--vscode-symbolIcon-moduleForeground,#a4b7cc)}
.ico.file-sh{color:var(--vscode-symbolIcon-fileForeground,#7eb3f5)}
.ico.file-bash{color:#ce9178}
.ico.file-zsh{color:#4ec9b0}
.ico.file-other{color:var(--vscode-symbolIcon-fileForeground,#7eb3f5)}
.ico.fav-ico{color:var(--vscode-charts-yellow,#e5c07b)}
.ico.recent-ico{color:green}
.label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:22px}
.label .dim{opacity:.65;font-size:.92em}
.label.fav{font-weight:700}
.match{background:var(--vscode-editor-findMatchHighlightBackground,rgba(234,92,0,.3));border-radius:2px}
.badge{font-size:10px;opacity:0;color:var(--vscode-descriptionForeground);padding:0 4px;flex-shrink:0;transition:opacity .15s;pointer-events:none}
.row:hover .badge{opacity:.75}
.actions{display:none;align-items:center;flex-shrink:0}
.row:hover .actions,.row.selected .actions,.row.focused .actions{display:flex}
.row:hover .badge,.row.selected .badge,.row.focused .badge{display:none}
.act{display:flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;background:transparent;color:var(--vscode-icon-foreground);border-radius:3px;cursor:pointer;padding:0}
.act:hover{background:var(--vscode-toolbar-hoverBackground)}
.act .codicon-play{color:var(--vscode-charts-green,#4ec9b0)}
.act .codicon-go-to-file{color:var(--vscode-focusBorder,#007acc)}
.act .codicon-copy{color:var(--vscode-foreground)}
.act .codicon-star-full{color:var(--vscode-charts-yellow,#e5c07b)}
.act .codicon-star-empty{color:var(--vscode-descriptionForeground)}
#ctx{position:fixed;z-index:9999;background:var(--vscode-menu-background,#252526);border:1px solid var(--vscode-menu-border,#454545);border-radius:4px;padding:4px 0;min-width:168px;box-shadow:0 4px 16px rgba(0,0,0,.4);display:none;outline:none}
#ctx .ci{display:flex;align-items:center;gap:8px;padding:4px 12px;font-size:var(--vscode-font-size);color:var(--vscode-menu-foreground,#ccc);cursor:pointer;white-space:nowrap}
#ctx .ci:hover{background:var(--vscode-menu-selectionBackground,#04395e);color:var(--vscode-menu-selectionForeground,#fff)}
#ctx .ci .codicon{font-size:14px;width:16px;text-align:center}
#ctx .csep{height:1px;background:var(--vscode-menu-separatorBackground,#454545);margin:4px 0}
</style>
</head>
<body>
<div class="toolbar">
  <button class="tb-btn" id="refreshBtn" title="Обновить"><span class="codicon codicon-refresh"></span></button>
  <button class="tb-btn" id="expandAllBtn" title="Развернуть всё"><span class="codicon codicon-expand-all"></span></button>
  <button class="tb-btn" id="collapseAllBtn" title="Свернуть всё"><span class="codicon codicon-collapse-all"></span></button>
  <div class="tb-sep"></div>
  <button class="tb-btn" id="recentBtn" title="Недавно запущенные"><span class="codicon codicon-history"></span></button>
  <button class="tb-btn" id="favBtn" title="Только избранное"><span class="codicon codicon-star-full"></span></button>
  <div style="flex:1"></div>
  <span class="count" id="count"></span>
</div>
<div class="search-bar">
  <div class="search-ico"><span class="codicon codicon-search"></span></div>
  <input class="search-input" id="searchInput" placeholder="Поиск..." type="text" autocomplete="off" spellcheck="false"/>
  <button class="search-clear" id="searchClear" title="Очистить"><span class="codicon codicon-close"></span></button>
</div>
<div id="tree" class="tree" tabindex="0"></div>
<div id="ctx" tabindex="-1"></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
const treeEl=document.getElementById('tree');
const countEl=document.getElementById('count');
const favBtnEl=document.getElementById('favBtn');
const recentBtnEl=document.getElementById('recentBtn');
const searchInput=document.getElementById('searchInput');
const searchClear=document.getElementById('searchClear');
const updateLayout=()=>{
  const th=document.querySelector('.toolbar').offsetHeight||35;
  const sh=document.querySelector('.search-bar').offsetHeight||28;
  treeEl.style.height=(window.innerHeight-th-sh)+'px';
};
window.addEventListener('resize',updateLayout);
updateLayout();
const state={roots:[],expanded:new Set(),favorites:new Set(),selected:undefined,scrollTop:0,
  favFilter:false,recentFilter:false,recentKeys:[],searchQuery:''};
let persistTimer;
const esc=(v)=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const persist=()=>{clearTimeout(persistTimer);persistTimer=setTimeout(()=>vscode.postMessage({type:'persistState',expandedKeys:[...state.expanded],selectedKey:state.selected,scrollTop:treeEl.scrollTop}),150)};
document.getElementById('refreshBtn').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));
favBtnEl.addEventListener('click',()=>{
  state.favFilter=!state.favFilter;
  if(state.favFilter) state.recentFilter=false;
  favBtnEl.classList.toggle('active',state.favFilter);
  recentBtnEl.classList.toggle('active',state.recentFilter);
  render();
});
recentBtnEl.addEventListener('click',()=>{
  state.recentFilter=!state.recentFilter;
  if(state.recentFilter) state.favFilter=false;
  recentBtnEl.classList.toggle('active',state.recentFilter);
  favBtnEl.classList.toggle('active',state.favFilter);
  render();
});
document.getElementById('expandAllBtn').addEventListener('click',()=>{
  const addAll=(nodes)=>nodes.forEach(n=>{if(n.kind!=='file'){state.expanded.add(n.key);addAll(n.children||[]);}});
  addAll(state.roots); render(); persist();
});
document.getElementById('collapseAllBtn').addEventListener('click',()=>{
  state.expanded.clear(); render(); persist();
});
searchInput.addEventListener('input',()=>{
  state.searchQuery=searchInput.value;
  searchClear.style.display=state.searchQuery?'flex':'none';
  render();
});
searchClear.addEventListener('click',()=>{
  searchInput.value=''; state.searchQuery='';
  searchClear.style.display='none';
  searchInput.focus(); render();
});
const compact=(node)=>{
  if(node.kind==='file') return {...node,_rawLabel:node.label};
  if(node.kind==='folder'){
    let cur=node;
    const parts=[cur.label];
    let key=cur.key,nodePath=cur.path;
    while(cur.children&&cur.children.length===1&&cur.children[0].kind==='folder'){
      cur=cur.children[0]; parts.push(cur.label); key=cur.key; nodePath=cur.path;
    }
    const kids=(cur.children||[]).map(compact);
    let label;
    if(parts.length>1){
      label='<span class="dim">'+esc(parts.slice(0,-1).join('/'))+'</span>/'+esc(parts[parts.length-1]);
    } else { label=esc(node.label); }
    return {kind:node.kind,label,key,path:nodePath,children:kids,_raw:node.key,_compactedKey:key,_multiLabel:parts.length>1,_rawLabel:parts.join('/')};
  }
  return {...node,_rawLabel:node.label,children:(node.children||[]).map(compact)};
};
const subtreeCount=(n)=>n.kind==='file'?1:(n.children||[]).reduce((s,c)=>s+subtreeCount(c),0);
const filesCount=(nodes)=>nodes.reduce((s,n)=>s+(n.kind==='file'?1:0)+filesCount(n.children||[]),0);
const fileIcoHtml=(rawLabel,isFav,isRecent)=>{
  if(isFav) return '<div class="ico fav-ico"><span class="codicon codicon-star-full"></span></div>';
  if(isRecent) return '<div class="ico recent-ico"><span class="codicon codicon-history"></span></div>';
  const ext=(rawLabel.match(/\.([^.]+)$$/)||[])[1]?.toLowerCase()||'';
  if(ext==='bash'||ext==='bashrc') return '<div class="ico file-bash"><span class="codicon codicon-file-code"></span></div>';
  if(ext==='zsh'||ext==='zshrc') return '<div class="ico file-zsh"><span class="codicon codicon-file-code"></span></div>';
  if(ext==='sh') return '<div class="ico file-sh"><span class="codicon codicon-file-code"></span></div>';
  return '<div class="ico file-other"><span class="codicon codicon-file-code"></span></div>';
};
const highlight=(text,q)=>{
  if(!q) return esc(text);
  const li=text.toLowerCase().indexOf(q.toLowerCase());
  if(li<0) return esc(text);
  return esc(text.slice(0,li))+'<span class="match">'+esc(text.slice(li,li+q.length))+'</span>'+esc(text.slice(li+q.length));
};
const nodeHtml=(node,depth,forceExpand,searchQ)=>{
  const isFolder=node.kind!=='file';
  const isExpanded=forceExpand||state.expanded.has(node.key)||state.expanded.has(node._compactedKey);
  const isFav=state.favorites.has(node.key)||state.favorites.has(node._compactedKey);
  const isRecent=!isFav&&state.recentKeys.includes(node.key);
  const hasKids=(node.children||[]).length>0;
  const isSel=node.key===state.selected||node._compactedKey===state.selected||(node._raw&&node._raw===state.selected);
  let indentHtml='';
  for(let i=0;i<depth;i++) indentHtml+='<div class="indent-guide"></div>';
  let arrowHtml;
  if(!isFolder||!hasKids){
    arrowHtml='<div class="arrow leaf"><span class="codicon codicon-blank"></span></div>';
  } else {
    const ch=isExpanded?'codicon-chevron-down':'codicon-chevron-right';
    const ek=esc(node.key);
    arrowHtml='<div class="arrow" data-a="toggle" data-k="'+ek+'"><span class="codicon '+ch+'" data-a="toggle" data-k="'+ek+'"></span></div>';
  }
  let icoHtml;
  if(node.kind==='workspace') icoHtml='<div class="ico workspace-ico"><span class="codicon codicon-root-folder"></span></div>';
  else if(node.kind==='folder'){
    const fi=isExpanded?'codicon-folder-opened':'codicon-folder';
    icoHtml='<div class="ico folder-ico"><span class="codicon '+fi+'"></span></div>';
  } else {
    icoHtml=fileIcoHtml(node._rawLabel||node.label,isFav,isRecent);
  }
  const rawL=node._rawLabel||node.label;
  let labelText;
  if(node._multiLabel){
    const parts=rawL.split('/');
    const last=parts[parts.length-1];
    const prefix=parts.slice(0,-1).join('/');
    labelText='<span class="dim">'+esc(prefix)+'/</span>'+highlight(last,searchQ);
  } else {
    labelText=highlight(rawL,searchQ);
  }
  let badgeHtml='';
  if(isFolder&&hasKids) badgeHtml='<span class="badge">'+subtreeCount(node)+'</span>';
  let actHtml='';
  if(node.kind==='file'){
    const k=esc(node.key);
    const favTitle=isFav?'Убрать из избранного':'В избранное';
    const favIcon=isFav?'codicon-star-full':'codicon-star-empty';
    actHtml=
      '<button class="act" data-a="run" data-k="'+k+'" title="Запустить"><span class="codicon codicon-play" data-a="run" data-k="'+k+'"></span></button>'+
      '<button class="act" data-a="open" data-k="'+k+'" title="Редактировать"><span class="codicon codicon-go-to-file" data-a="open" data-k="'+k+'"></span></button>'+
      '<button class="act" data-a="copy" data-k="'+k+'" title="Копировать путь"><span class="codicon codicon-copy" data-a="copy" data-k="'+k+'"></span></button>'+
      '<button class="act" data-a="fav" data-k="'+k+'" title="'+favTitle+'"><span class="codicon '+favIcon+'" data-a="fav" data-k="'+k+'"></span></button>';
  }
  const rowCls='row'+(isSel?' selected':'')+(isSel&&document.hasFocus()?' focused':'');
  let html='<div class="'+rowCls+'" data-k="'+esc(node.key)+'" title="'+esc(node.path||rawL)+'">';
  html+='<div class="indent">'+indentHtml+'</div>'+arrowHtml+icoHtml;
  html+='<div class="label'+(isFav?' fav':'')+'"'+(isRecent&&!isFav?' style="color:green;opacity:.9"':'')+'>'+labelText+'</div>';
  html+=badgeHtml+'<div class="actions">'+actHtml+'</div></div>';
  if(isFolder&&hasKids&&isExpanded){
    const kCls=(node.key===justExpandedKey||node._compactedKey===justExpandedKey)?'kids':'kids-static';
    html+='<div class="'+kCls+'">'+(node.children||[]).map(c=>nodeHtml(c,depth+1,forceExpand,searchQ)).join('')+'</div>';
  }
  return html;
};
const filterByPredicate=(nodes,pred)=>{
  const out=[];
  for(const n of nodes){
    if(n.kind==='file'){if(pred(n)) out.push(n);}
    else{const kids=filterByPredicate(n.children||[],pred);if(kids.length) out.push({...n,children:kids});}
  }
  return out;
};
const filterSearch=(nodes,q)=>{
  if(!q) return nodes;
  const lq=q.toLowerCase();
  const out=[];
  for(const n of nodes){
    const rawL=(n._rawLabel||n.label||'').toLowerCase();
    if(n.kind==='file'){if(rawL.includes(lq)) out.push(n);}
    else{
      if(rawL.includes(lq)) out.push({...n,children:(n.children||[])});
      else{const kids=filterSearch(n.children||[],q);if(kids.length) out.push({...n,children:kids});}
    }
  }
  return out;
};
const countFavFiles=(nodes)=>nodes.reduce((s,n)=>s+(n.kind==='file'&&state.favorites.has(n.key)?1:0)+countFavFiles(n.children||[]),0);
let justExpandedKey=null;
const setSelectedInDom=(k)=>{
  const prev=treeEl.querySelector('.row.selected');
  if(prev){prev.classList.remove('selected','focused');}
  const next=treeEl.querySelector('.row[data-k="'+k+'"]');
  if(next){next.classList.add('selected');}
};
const render=()=>{
  const searchQ=state.searchQuery.trim();
  let base=state.roots;
  const forceExpand=!!(searchQ||state.favFilter||state.recentFilter);
  let label='';
  if(state.favFilter){
    base=filterByPredicate(state.roots,n=>state.favorites.has(n.key));
    const cnt=countFavFiles(state.roots);
    label='Избранное: '+cnt;
    if(!cnt){treeEl.innerHTML='<div style="padding:16px 12px;opacity:.6;font-size:12px">Нет избранных скриптов.</div>';countEl.textContent=label;return;}
  } else if(state.recentFilter){
    base=filterByPredicate(state.roots,n=>state.recentKeys.includes(n.key));
    label='Недавние: '+state.recentKeys.length;
    if(!state.recentKeys.length){treeEl.innerHTML='<div style="padding:16px 12px;opacity:.6;font-size:12px">Нет недавно запущенных скриптов.</div>';countEl.textContent=label;return;}
  }
  let compacted=base.map(compact);
  if(searchQ) compacted=filterSearch(compacted,searchQ);
  if(!compacted.length){
    treeEl.innerHTML='<div style="padding:16px 12px;opacity:.6;font-size:12px">'+(searchQ?'Ничего не найдено.':'Скрипты не найдены.')+'</div>';
    countEl.textContent=label; return;
  }
  treeEl.innerHTML=compacted.map(n=>nodeHtml(n,0,forceExpand,searchQ)).join('');
  if(!label) label=filesCount(state.roots)+' файлов';
  countEl.textContent=label;
  if(!forceExpand) requestAnimationFrame(()=>{treeEl.scrollTop=state.scrollTop||0;});
};
let clickTimer=null;
treeEl.addEventListener('click',(e)=>{
  const t=e.target; if(!(t instanceof HTMLElement)) return;
  const a=t.dataset.a;
  const k=t.dataset.k||(t.closest('[data-k]')?.dataset.k);
  if(!k) return;
  if(a==='toggle'){const exp=!state.expanded.has(k);exp?state.expanded.add(k):state.expanded.delete(k);justExpandedKey=exp?k:null;render();justExpandedKey=null;persist();return;}
  if(a==='run'){vscode.postMessage({type:'run',key:k});return;}
  if(a==='open'){vscode.postMessage({type:'open',key:k});return;}
  if(a==='copy'){vscode.postMessage({type:'copy',key:k});return;}
  if(a==='fav'){vscode.postMessage({type:'toggleFavorite',key:k});return;}
  clearTimeout(clickTimer);
  const capK=k;
  clickTimer=setTimeout(()=>{state.selected=capK;setSelectedInDom(capK);persist();},280);
});
treeEl.addEventListener('dblclick',(e)=>{
  clearTimeout(clickTimer); clickTimer=null;
  const t=e.target; if(!(t instanceof HTMLElement)) return;
  if(t.dataset.a) return;
  const row=t.closest('[data-k]'); if(!row) return;
  const k=row.dataset.k;
  state.selected=k;setSelectedInDom(k);persist();
  vscode.postMessage({type:'run',key:k});
});
treeEl.addEventListener('keydown',(e)=>{
  const rows=[...treeEl.querySelectorAll('.row')];
  if(!rows.length) return;
  const cur=treeEl.querySelector('.row.selected,.row.focused');
  const idx=cur?rows.indexOf(cur):-1;
  if(e.key==='ArrowDown'){e.preventDefault();const next=rows[Math.min(idx+1,rows.length-1)];if(next){state.selected=next.dataset.k;setSelectedInDom(next.dataset.k);next.scrollIntoView({block:'nearest'});persist();}}
  else if(e.key==='ArrowUp'){e.preventDefault();const prev=rows[Math.max(idx-1,0)];if(prev){state.selected=prev.dataset.k;setSelectedInDom(prev.dataset.k);prev.scrollIntoView({block:'nearest'});persist();}}
  else if(e.key==='Enter'&&cur){vscode.postMessage({type:'run',key:cur.dataset.k});}
  else if(e.key==='F2'&&cur){vscode.postMessage({type:'open',key:cur.dataset.k});}
  else if(e.key===' '&&cur){e.preventDefault();const k=cur.dataset.k;const exp=!state.expanded.has(k);exp?state.expanded.add(k):state.expanded.delete(k);justExpandedKey=exp?k:null;render();justExpandedKey=null;persist();}
  else if(e.key==='ArrowRight'&&cur){const k=cur.dataset.k;if(!state.expanded.has(k)){state.expanded.add(k);justExpandedKey=k;render();justExpandedKey=null;persist();}}
  else if(e.key==='ArrowLeft'&&cur){const k=cur.dataset.k;if(state.expanded.has(k)){state.expanded.delete(k);render();persist();}}
});
const ctxEl=document.getElementById('ctx');
let ctxKey=null;
const hideCtx=()=>{ctxEl.style.display='none';ctxKey=null;};
ctxEl.addEventListener('blur',()=>setTimeout(hideCtx,100));
document.addEventListener('click',()=>hideCtx());
const showCtx=(x,y,k,isFav)=>{
  ctxKey=k;
  ctxEl.innerHTML=
    '<div class="ci" data-ca="run"><span class="codicon codicon-play" style="color:var(--vscode-charts-green,#4ec9b0)"></span>Запустить</div>'+
    '<div class="ci" data-ca="open"><span class="codicon codicon-go-to-file" style="color:var(--vscode-focusBorder,#007acc)"></span>Редактировать</div>'+
    '<div class="csep"></div>'+
    '<div class="ci" data-ca="copy"><span class="codicon codicon-copy"></span>Копировать имя</div>'+
    '<div class="csep"></div>'+
    '<div class="ci" data-ca="fav"><span class="codicon '+(isFav?'codicon-star-full':'codicon-star-empty')+'" style="'+(isFav?'color:var(--vscode-charts-yellow,#e5c07b)':'')+'"></span>'+(isFav?'Убрать из избранного':'Добавить в избранное')+'</div>';
  ctxEl.style.display='block';
  const pw=window.innerWidth,ph=window.innerHeight;
  const cw=ctxEl.offsetWidth||180,ch=ctxEl.offsetHeight||120;
  ctxEl.style.left=Math.min(x,pw-cw-4)+'px';
  ctxEl.style.top=Math.min(y,ph-ch-4)+'px';
  ctxEl.focus();
};
ctxEl.addEventListener('click',(e)=>{
  if(!(e.target instanceof HTMLElement)) return;
  const ci=e.target.closest('[data-ca]');
  if(!ci||!ctxKey) return;
  const ca=ci.dataset.ca,k=ctxKey; hideCtx();
  if(ca==='run') vscode.postMessage({type:'run',key:k});
  else if(ca==='open') vscode.postMessage({type:'open',key:k});
  else if(ca==='copy') vscode.postMessage({type:'copy',key:k});
  else if(ca==='fav') vscode.postMessage({type:'toggleFavorite',key:k});
});
treeEl.addEventListener('contextmenu',(e)=>{
  e.preventDefault();
  const t=e.target; if(!(t instanceof HTMLElement)) return;
  const row=t.closest('[data-k]'); if(!row) return;
  const k=row.dataset.k;
  state.selected=k; render(); persist();
  showCtx(e.clientX,e.clientY,k,state.favorites.has(k));
});
treeEl.addEventListener('scroll',()=>{state.scrollTop=treeEl.scrollTop;persist();});
window.addEventListener('message',(event)=>{
  const m=event.data; if(!m||m.type!=='state') return;
  state.roots=Array.isArray(m.roots)?m.roots:[];
  state.expanded=new Set(Array.isArray(m.expandedKeys)?m.expandedKeys:[]);
  state.favorites=new Set(Array.isArray(m.favoriteKeys)?m.favoriteKeys:[]);
  state.recentKeys=Array.isArray(m.recentKeys)?m.recentKeys:[];
  state.selected=typeof m.selectedKey==='string'?m.selectedKey:undefined;
  state.scrollTop=Number.isFinite(m.scrollTop)?Math.max(0,m.scrollTop):0;
  render();
});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden')
    vscode.postMessage({type:'persistState',expandedKeys:[...state.expanded],selectedKey:state.selected,scrollTop:treeEl.scrollTop});
});
vscode.postMessage({type:'ready'});
</script>
</body>
</html>`;
	};
	const messageHandler = async (message: WebviewMessage) => {
		switch (message.type) {
			case 'ready':
				postState();
				return;
			case 'refresh':
				await refreshInBackground(true);
				return;
			case 'run':
				runScriptByKey(message.key);
				return;
			case 'open':
				await openScriptByKey(message.key);
				return;
			case 'copy':
				await copyPathByKey(message.key);
				return;
			case 'toggleFavorite':
				await toggleFavoriteByKey(message.key);
				return;
			case 'persistState':
				if (Array.isArray(message.expandedKeys)) {
					expandedKeys = new Set(message.expandedKeys.map(normalizeKey));
					await saveExpanded();
				}
				if (typeof message.selectedKey === 'string' || message.selectedKey === undefined) {
					selectedKey = message.selectedKey ? normalizeKey(message.selectedKey) : undefined;
					await saveSelected();
				}
				if (typeof message.scrollTop === 'number' && Number.isFinite(message.scrollTop)) {
					scrollTop = Math.max(0, message.scrollTop);
					await saveScrollTop();
				}
				return;
			default:
				return;
		}
	};

	const viewProvider: vscode.WebviewViewProvider = {
		resolveWebviewView(view: vscode.WebviewView) {
			webviewView = view;
			const codiconsPath = vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist');
			view.webview.options = {
				enableScripts: true,
				localResourceRoots: [codiconsPath]
			};
			const codiconsCssUri = view.webview.asWebviewUri(vscode.Uri.joinPath(codiconsPath, 'codicon.css'));
			view.webview.html = getWebviewHtml(view.webview, codiconsCssUri);
			view.webview.onDidReceiveMessage((message: WebviewMessage) => {
				void messageHandler(message);
			});
			view.onDidDispose(() => {
				if (webviewView === view) {
					webviewView = undefined;
				}
			});
			postState();
			if (roots.length === 0) {
				const cached = context.workspaceState.get<string[]>(cachedScriptsKey, []);
				if (cached.length > 0) {
					loadFromCachedPaths(cached);
					postState();
				}
				void refreshInBackground();
			}
		}
	};

	const registerProvider = vscode.window.registerWebviewViewProvider('sh-explorer.scripts', viewProvider, {
		webviewOptions: { retainContextWhenHidden: true }
	});

	const closeListener = vscode.window.onDidCloseTerminal((terminal) => {
		for (const [key, value] of runTerminals) {
			if (value === terminal) {
				runTerminals.delete(key);
				break;
			}
		}
	});

	const refreshCommand = vscode.commands.registerCommand('sh-explorer.refresh', async () => {
		await refreshInBackground(true);
	});
	const runCommand = vscode.commands.registerCommand('sh-explorer.runScript', async (arg?: string) => {
		runScriptByKey(arg);
	});
	const openCommand = vscode.commands.registerCommand('sh-explorer.openScript', async (arg?: string) => {
		await openScriptByKey(arg);
	});
	const copyFullPathCommand = vscode.commands.registerCommand('sh-explorer.copyFullPath', async (arg?: string) => {
		await copyPathByKey(arg);
	});
	const toggleFavoriteCommand = vscode.commands.registerCommand('sh-explorer.toggleFavorite', async (arg?: string) => {
		await toggleFavoriteByKey(arg);
	});

	const workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
		void refreshInBackground();
	});
	const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('sh-explorer.exclude') || event.affectsConfiguration('sh-explorer.extensions')) {
			void refreshInBackground();
		}
	});

	const cached = context.workspaceState.get<string[]>(cachedScriptsKey, []);
	if (cached.length > 0) {
		loadFromCachedPaths(cached);
	}
	void refreshInBackground();

	context.subscriptions.push(
		registerProvider,
		refreshCommand,
		runCommand,
		openCommand,
		copyFullPathCommand,
		toggleFavoriteCommand,
		closeListener,
		workspaceListener,
		configListener
	);
}

export function deactivate() { }
