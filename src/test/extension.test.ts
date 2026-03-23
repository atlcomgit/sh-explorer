import * as assert from 'assert';
import { buildScriptExecutionPlan } from '../scriptRunner';

suite('Extension Test Suite', () => {
	test('uses bash with safe quoting for shell scripts', () => {
		const plan = buildScriptExecutionPlan("/tmp/it's fine.sh", 'linux', undefined);

		assert.deepStrictEqual(plan, {
			ok: true,
			command: "bash '/tmp/it'\\''s fine.sh'"
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
});
