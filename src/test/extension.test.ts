import * as assert from 'assert';
import { buildScriptExecutionPlan } from '../scriptRunner';
import { buildWebviewTree, findWebviewNodeByKey, isBranchExpanded, type TreePresentationInputNode } from '../webviewTree';

suite('Extension Test Suite', () => {
	test('uses bash with safe quoting for shell scripts', () => {
		const plan = buildScriptExecutionPlan("/tmp/it's fine.sh", 'linux', undefined);

		assert.deepStrictEqual(plan, {
			ok: true,
			command: "bash '/tmp/it'\\''s fine.sh'"
		});
	});

	test('uses systemd-run on linux when the sudo workaround is enabled', () => {
		const plan = buildScriptExecutionPlan("/tmp/it's fine.sh", 'linux', undefined, true);

		assert.deepStrictEqual(plan, {
			ok: true,
			command: "systemd-run --user --wait --pty --same-dir --collect --quiet bash '/tmp/it'\\''s fine.sh'"
		});
	});

	test('uses cmd for batch scripts on windows', () => {
		const plan = buildScriptExecutionPlan('C:\\temp\\run me.cmd', 'win32', 'C:\\Windows\\System32\\cmd.exe');

		assert.deepStrictEqual(plan, {
			ok: true,
			command: '"C:\\temp\\run me.cmd"',
			shellPath: 'C:\\Windows\\System32\\cmd.exe',
			shellArgs: ['/d']
		});
	});

	test('returns a clear error for batch scripts outside windows', () => {
		const plan = buildScriptExecutionPlan('/tmp/run.cmd', 'linux', undefined);

		assert.deepStrictEqual(plan, {
			ok: false,
			message: 'Scripts with .bat and .cmd can only be run on Windows.'
		});
	});

	test('keeps folder chain aliases when compacting the webview tree', () => {
		const tree: TreePresentationInputNode[] = [
			{
				kind: 'workspace',
				label: 'workspace',
				key: '/workspace',
				children: [
					{
						kind: 'folder',
						label: 'scripts',
						key: '/workspace::scripts',
						children: [
							{
								kind: 'folder',
								label: 'deploy',
								key: '/workspace::scripts::deploy',
								children: [
									{
										kind: 'file',
										label: 'run.sh',
										key: '/workspace::scripts::deploy::run.sh',
										path: '/workspace/scripts/deploy/run.sh',
										children: []
									}
								]
							}
						]
					}
				]
			}
		];

		const compacted = buildWebviewTree(tree);
		const folder = findWebviewNodeByKey(compacted, '/workspace::scripts::deploy');

		assert.ok(folder);
		assert.deepStrictEqual(folder?.aliases, ['/workspace::scripts', '/workspace::scripts::deploy']);
		assert.deepStrictEqual(folder?.branchKeys, ['/workspace::scripts', '/workspace::scripts::deploy']);
		assert.strictEqual(folder?.rawLabel, 'scripts/deploy');
		assert.strictEqual(folder?.multiLabel, true);
	});

	test('expands a newly visible parent when a refreshed child branch stayed expanded', () => {
		const tree: TreePresentationInputNode[] = [
			{
				kind: 'workspace',
				label: 'workspace',
				key: '/workspace',
				children: [
					{
						kind: 'folder',
						label: 'scripts',
						key: '/workspace::scripts',
						children: [
							{
								kind: 'folder',
								label: 'deploy',
								key: '/workspace::scripts::deploy',
								children: [
									{
										kind: 'file',
										label: 'run.sh',
										key: '/workspace::scripts::deploy::run.sh',
										path: '/workspace/scripts/deploy/run.sh',
										children: []
									}
								]
							},
							{
								kind: 'file',
								label: 'check.sh',
								key: '/workspace::scripts::check.sh',
								path: '/workspace/scripts/check.sh',
								children: []
							}
						]
					}
				]
			}
		];

		const compacted = buildWebviewTree(tree);
		const folder = findWebviewNodeByKey(compacted, '/workspace::scripts');

		assert.ok(folder);
		assert.strictEqual(
			isBranchExpanded(folder!, new Set(['/workspace::scripts::deploy'])),
			true
		);
	});
});
