import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';

import { env } from '../env';
import { logger } from '../utils/logger';

export interface DataSyncResult {
	ok: boolean;
	output: string;
}

/**
 * Runs `nao sync` (the Python CLI) for the given project to refresh the data
 * context (schema/profiling/description metadata). Used by the on-demand admin
 * trigger and the scheduled job. The CLI is invoked via its module so it does
 * not depend on the `nao` console script being on PATH.
 */
export function runDataSync(projectPath: string, providers = 'databases'): Promise<DataSyncResult> {
	const python = env.NAO_PYTHON || 'python';
	// nao sync's cleanup iterdir()s databases/ without an existence check.
	try {
		mkdirSync(join(projectPath, 'databases'), { recursive: true });
	} catch {
		// ignore
	}
	return new Promise((resolve) => {
		const child = spawn(python, ['-m', 'nao_core.main', 'sync', '-p', providers], {
			cwd: projectPath,
			env: process.env,
		});

		let output = '';
		const capture = (chunk: Buffer) => {
			output += chunk.toString();
		};
		child.stdout.on('data', capture);
		child.stderr.on('data', capture);

		child.on('error', (err) => {
			logger.error(`Data sync failed to start: ${err.message}`, { source: 'system' });
			resolve({ ok: false, output: `Failed to start nao sync: ${err.message}` });
		});
		child.on('close', (code) => {
			const ok = code === 0;
			logger[ok ? 'info' : 'error'](`Data sync exited with code ${code}`, { source: 'system' });
			resolve({ ok, output: output.slice(-4000) });
		});
	});
}
