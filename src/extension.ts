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

	constructor(node: ScriptNode, expandedKeys: ReadonlySet<string>, favoriteKeys: ReadonlySet<string>) {
		super(
			node.label,
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
		const parent = element.node.parent;
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

		const children = Array.from(element.node.children.values());
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
		return this.getOrCreateItem(node);
	}

	hasRoots(): boolean {
		return this.roots.length > 0;
	}

	private getOrCreateItem(node: ScriptNode): ScriptItem {
		const existing = this.itemCache.get(node.key);
		if (existing) {
			return existing;
		}
		const created = new ScriptItem(node, this.expandedKeys, this.favoriteKeys);
		this.itemCache.set(node.key, created);
		return created;
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
	const cachedScriptsKey = 'sh-explorer.cachedScripts';
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

	const expandedKeys = new Set<string>(
		context.workspaceState.get<string[]>(expandedStateKey, []).map(normalizeKey)
	);
	const favoritesKey = 'sh-explorer.favorites';
	const favoriteKeys = new Set<string>(
		context.workspaceState.get<string[]>(favoritesKey, []).map(normalizeKey)
	);
	const provider = new ShScriptsProvider(expandedKeys, favoriteKeys, getExcludeGlobs, getIncludeExtensions);
	const cachedScripts = context.workspaceState.get<string[]>(cachedScriptsKey, []);
	const hasCachedScripts = cachedScripts.length > 0;
	if (hasCachedScripts) {
		provider.loadFromCachedPaths(cachedScripts);
	}
	const treeView = vscode.window.createTreeView('sh-explorer.scripts', {
		treeDataProvider: provider,
		showCollapseAll: false
	});
	let didRestoreSelection = false;
	const restoreFromCache = async () => {
		if (!hasCachedScripts) {
			return;
		}
		provider.loadFromCachedPaths(cachedScripts);
		didRestoreSelection = false;
		await restoreSelection();
	};

	const getSavedSelection = (): string | undefined => {
		return (
			context.workspaceState.get<string | undefined>(selectedStateKey) ??
			context.globalState.get<string | undefined>(selectedStateKey)
		);
	};

	const restoreSelection = async (): Promise<boolean> => {
		if (didRestoreSelection) {
			return true;
		}
		const selectedKey = getSavedSelection();
		if (!selectedKey) {
			return false;
		}
		if (!treeView.visible) {
			return false;
		}
		if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
			return false;
		}
		await provider.ensureTree();
		const separator = '::';
		const separatorIndex = selectedKey.indexOf(separator);
		const rawRootKey = separatorIndex === -1 ? selectedKey : selectedKey.slice(0, separatorIndex);
		const normalizedRootKey = normalizeRootKey(rawRootKey);
		const relativePart = separatorIndex === -1 ? undefined : selectedKey.slice(separatorIndex + separator.length);
		const rootKey = normalizedRootKey;
		expandedKeys.add(rootKey);
		const segments = relativePart ? relativePart.split('::') : [];
		let currentKey = rootKey;
		for (let i = 0; i < segments.length; i += 1) {
			currentKey = `${currentKey}::${segments[i]}`;
			expandedKeys.add(currentKey);
		}
		if (!provider.hasRoots()) {
			await provider.ensureTree();
		} else {
			provider.refreshItems();
		}
		let restored = false;
		const rootItem = provider.getItemByKey(rootKey);
		if (rootItem) {
			try {
				await treeView.reveal(rootItem, { select: !relativePart, focus: true, expand: true });
				restored = !relativePart;
			} catch {
				// ignore reveal errors when tree is not yet ready
			}
		}
		let revealKey = rootKey;
		for (let i = 0; i < segments.length; i += 1) {
			revealKey = `${revealKey}::${segments[i]}`;
			const item = provider.getItemByKey(revealKey);
			if (!item) {
				continue;
			}
			try {
				const isLast = i === segments.length - 1;
				await treeView.reveal(item, { select: isLast, focus: true, expand: true });
				restored = isLast || restored;
			} catch {
				// ignore reveal errors when tree is not yet ready
			}
		}

		if (restored) {
			didRestoreSelection = true;
		}
		return restored;
	};

	const saveExpandedState = async () => {
		await context.workspaceState.update(expandedStateKey, Array.from(expandedKeys));
	};

	const expandListener = treeView.onDidExpandElement((event) => {
		expandedKeys.add(event.element.node.key);
		void saveExpandedState();
	});

	const collapseListener = treeView.onDidCollapseElement((event) => {
		expandedKeys.delete(event.element.node.key);
		void saveExpandedState();
	});

	let runTerminal: vscode.Terminal | undefined;
	const terminalName = 'Sh Explorer: Script Run';

	const closeListener = vscode.window.onDidCloseTerminal((terminal) => {
		if (terminal === runTerminal) {
			runTerminal = undefined;
		}
	});

	const resolveScriptUri = (arg?: unknown): vscode.Uri | undefined => {
		if (!arg) {
			return undefined;
		}
		if (arg instanceof vscode.Uri) {
			return arg;
		}
		if (arg instanceof ScriptItem) {
			return arg.node.uri;
		}
		if (typeof arg === 'object' && arg !== null && 'uri' in arg) {
			const maybeUri = (arg as { uri?: unknown }).uri;
			if (maybeUri instanceof vscode.Uri) {
				return maybeUri;
			}
		}
		return undefined;
	};

	const resolveScriptKey = (arg?: unknown): string | undefined => {
		if (!arg) {
			return undefined;
		}
		if (arg instanceof ScriptItem) {
			return arg.node.key;
		}
		const uri = resolveScriptUri(arg);
		if (!uri) {
			return undefined;
		}
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder) {
			return undefined;
		}
		const rootKey = path.resolve(folder.uri.fsPath);
		const relativePath = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
		const parts = relativePath.split('/');
		let key = rootKey;
		for (const part of parts) {
			key = `${key}::${part}`;
		}
		return key;
	};

	const refreshCommand = vscode.commands.registerCommand('sh-explorer.refresh', async () => {
		treeView.message = 'Обновление...';
		try {
			const paths = await provider.loadFromWorkspace();
			await context.workspaceState.update(cachedScriptsKey, paths);
		} finally {
			treeView.message = undefined;
		}
	});

	const runCommand = vscode.commands.registerCommand('sh-explorer.runScript', async (arg?: unknown) => {
		const uri = resolveScriptUri(arg);
		if (!uri) {
			vscode.window.showWarningMessage('No shell script selected.');
			return;
		}

		const folder = vscode.workspace.getWorkspaceFolder(uri);
		const cwd = folder?.uri.fsPath;
		if (!runTerminal) {
			runTerminal = vscode.window.createTerminal({
				name: terminalName,
				cwd,
				location: vscode.TerminalLocation.Editor
			});
		} else if (cwd) {
			runTerminal.sendText(`cd "${cwd}"`);
		}

		runTerminal.show(true);
		runTerminal.sendText(`bash "${uri.fsPath}"`);
	});

	const openCommand = vscode.commands.registerCommand('sh-explorer.openScript', async (arg?: unknown) => {
		const uri = resolveScriptUri(arg);
		if (!uri) {
			vscode.window.showWarningMessage('No shell script selected.');
			return;
		}

		await vscode.window.showTextDocument(uri, { preview: false, preserveFocus: false });
	});

	const toggleFavoriteCommand = vscode.commands.registerCommand('sh-explorer.toggleFavorite', (arg?: unknown) => {
		const key = resolveScriptKey(arg);
		if (!key) {
			vscode.window.showWarningMessage('No shell script selected.');
			return;
		}
		if (favoriteKeys.has(key)) {
			favoriteKeys.delete(key);
		} else {
			favoriteKeys.add(key);
		}
		void context.workspaceState.update(favoritesKey, Array.from(favoriteKeys));
		provider.refreshItems();
	});

	const selectionListener = treeView.onDidChangeSelection((event) => {
		const selected = event.selection[0];
		if (!selected) {
			return;
		}
		void context.workspaceState.update(selectedStateKey, selected.node.key);
		void context.globalState.update(selectedStateKey, selected.node.key);
	});

	const workspaceListener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
		scheduleRestoreSelection();
	});

	const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('sh-explorer.exclude') || event.affectsConfiguration('sh-explorer.extensions')) {
			void refreshInBackground();
		}
	});

	const visibilityListener = treeView.onDidChangeVisibility((event) => {
		if (event.visible) {
			if (!didRestoreSelection) {
				void restoreSelection();
			}
		}
	});

	const scheduleRestoreSelection = (attempt = 0) => {
		setTimeout(async () => {
			if (didRestoreSelection) {
				return;
			}
			const restored = await restoreSelection();
			if (attempt < 6 && !restored) {
				scheduleRestoreSelection(attempt + 1);
			}
		}, attempt === 0 ? 0 : 500);
	};

	const refreshInBackground = async () => {
		treeView.message = 'Обновление...';
		try {
			const paths = await provider.loadFromWorkspace();
			await context.workspaceState.update(cachedScriptsKey, paths);
		} finally {
			treeView.message = undefined;
		}
	};

	if (treeView.visible && !didRestoreSelection) {
		void restoreSelection();
	}
	void restoreFromCache();
	setTimeout(() => {
		void refreshInBackground();
	}, hasCachedScripts ? 200 : 0);

	context.subscriptions.push(
		provider,
		treeView,
		refreshCommand,
		runCommand,
		openCommand,
		toggleFavoriteCommand,
		closeListener,
		expandListener,
		collapseListener,
		selectionListener,
		workspaceListener,
		visibilityListener,
		configListener
	);
}

export function deactivate() { }
