import * as path from 'path';

const keySeparator = '::';

export type FavoriteRecord = {
	filePath: string;
	preferredRoot: string;
};

export type FavoriteNodeMatch = {
	key: string;
	filePath: string;
	rootPath: string;
};

const normalizeFsPath = (value: string): string => path.resolve(value);

const normalizeFavoriteRecord = (record: FavoriteRecord): FavoriteRecord => {
	return {
		filePath: normalizeFsPath(record.filePath),
		preferredRoot: normalizeFsPath(record.preferredRoot)
	};
};

const dedupeFavoriteRecords = (records: readonly FavoriteRecord[]): FavoriteRecord[] => {
	const uniqueByFilePath = new Map<string, FavoriteRecord>();

	for (const record of records) {
		const normalizedRecord = normalizeFavoriteRecord(record);
		uniqueByFilePath.set(normalizedRecord.filePath, normalizedRecord);
	}

	return Array.from(uniqueByFilePath.values());
};

export const mergeFavoriteRecords = (...recordGroups: ReadonlyArray<readonly FavoriteRecord[]>): FavoriteRecord[] => {
	return dedupeFavoriteRecords(recordGroups.flat());
};

const pickFallbackNode = (matches: readonly FavoriteNodeMatch[]): FavoriteNodeMatch => {
	return [...matches].sort((left, right) => {
		const rootLengthDelta = right.rootPath.length - left.rootPath.length;
		if (rootLengthDelta !== 0) {
			return rootLengthDelta;
		}

		const rootDelta = left.rootPath.localeCompare(right.rootPath);
		if (rootDelta !== 0) {
			return rootDelta;
		}

		return left.key.localeCompare(right.key);
	})[0]!;
};

export const migrateLegacyFavoriteKeys = (keys: readonly string[]): FavoriteRecord[] => {
	const migratedRecords: FavoriteRecord[] = [];

	for (const key of keys) {
		const separatorIndex = key.indexOf(keySeparator);
		if (separatorIndex === -1) {
			continue;
		}

		const rawRootPath = key.slice(0, separatorIndex);
		const relativeSegments = key
			.slice(separatorIndex + keySeparator.length)
			.split(keySeparator)
			.filter((segment) => segment.length > 0);

		if (relativeSegments.length === 0) {
			continue;
		}

		migratedRecords.push({
			filePath: path.join(rawRootPath, ...relativeSegments),
			preferredRoot: rawRootPath
		});
	}

	return dedupeFavoriteRecords(migratedRecords);
};

export const resolveFavoriteRecords = (
	records: readonly FavoriteRecord[],
	nodes: readonly FavoriteNodeMatch[]
): { records: FavoriteRecord[]; favoriteKeys: string[]; didChange: boolean } => {
	const normalizedRecords = mergeFavoriteRecords(records);
	const nodesByFilePath = new Map<string, FavoriteNodeMatch[]>();

	for (const node of nodes) {
		const normalizedFilePath = normalizeFsPath(node.filePath);
		const normalizedNode = {
			...node,
			filePath: normalizedFilePath,
			rootPath: normalizeFsPath(node.rootPath)
		};
		const fileMatches = nodesByFilePath.get(normalizedFilePath) ?? [];
		fileMatches.push(normalizedNode);
		nodesByFilePath.set(normalizedFilePath, fileMatches);
	}

	const resolvedRecords: FavoriteRecord[] = [];
	const favoriteKeys = new Set<string>();
	let didChange = false;

	for (const record of normalizedRecords) {
		const matches = nodesByFilePath.get(record.filePath);
		if (!matches || matches.length === 0) {
			resolvedRecords.push(record);
			continue;
		}

		const preferredMatch = matches.find((entry) => entry.rootPath === record.preferredRoot);
		const selectedMatch = preferredMatch ?? pickFallbackNode(matches);
		const resolvedRecord = preferredMatch
			? record
			: {
				filePath: record.filePath,
				preferredRoot: selectedMatch.rootPath
			};

		if (!preferredMatch) {
			didChange = true;
		}

		resolvedRecords.push(resolvedRecord);
		favoriteKeys.add(selectedMatch.key);
	}

	return {
		records: mergeFavoriteRecords(resolvedRecords),
		favoriteKeys: Array.from(favoriteKeys),
		didChange
	};
};

export const toggleFavoriteRecord = (
	records: readonly FavoriteRecord[],
	node: FavoriteNodeMatch
): FavoriteRecord[] => {
	const normalizedRecords = mergeFavoriteRecords(records);
	const normalizedNode = {
		...node,
		filePath: normalizeFsPath(node.filePath),
		rootPath: normalizeFsPath(node.rootPath)
	};
	const existingIndex = normalizedRecords.findIndex((record) => record.filePath === normalizedNode.filePath);

	if (existingIndex === -1) {
		return mergeFavoriteRecords([
			...normalizedRecords,
			{
				filePath: normalizedNode.filePath,
				preferredRoot: normalizedNode.rootPath
			}
		]);
	}

	const existingRecord = normalizedRecords[existingIndex];
	if (existingRecord.preferredRoot === normalizedNode.rootPath) {
		return normalizedRecords.filter((_, index) => index !== existingIndex);
	}

	return normalizedRecords.map((record, index) => {
		if (index !== existingIndex) {
			return record;
		}

		return {
			filePath: normalizedNode.filePath,
			preferredRoot: normalizedNode.rootPath
		};
	});
};
