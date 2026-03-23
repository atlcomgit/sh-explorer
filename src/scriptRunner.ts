import * as path from 'path';

export type ScriptExecutionPlan = {
	ok: true;
	command: string;
	shellPath?: string;
	shellArgs?: string[];
};

export type ScriptExecutionError = {
	ok: false;
	message: string;
};

const quoteForPosixShell = (value: string): string => {
	return `'${value.replace(/'/g, `'\\''`)}'`;
};

const quoteForCmd = (value: string): string => {
	return `"${value}"`;
};

export const buildScriptExecutionPlan = (
	scriptPath: string,
	platform: NodeJS.Platform,
	comspec = process.env.COMSPEC
): ScriptExecutionPlan | ScriptExecutionError => {
	const extension = path.extname(scriptPath).toLowerCase();

	if (extension === '.bat' || extension === '.cmd') {
		if (platform !== 'win32') {
			return {
				ok: false,
				message: 'Scripts with .bat and .cmd can only be run on Windows.'
			};
		}

		return {
			ok: true,
			command: quoteForCmd(scriptPath),
			shellPath: comspec && comspec.trim().length > 0 ? comspec : 'cmd.exe',
			shellArgs: ['/d']
		};
	}

	return {
		ok: true,
		command: `bash ${quoteForPosixShell(scriptPath)}`
	};
};