import { env } from '../env';
import { runDataSync } from '../services/data-sync.service';
import type { JobHandler } from '../services/scheduler.service';
import { logger } from '../utils/logger';

export const DATA_SYNC_JOB_NAME = 'data.sync';

export const dataSyncHandler: JobHandler = async () => {
	const projectPath = env.NAO_DEFAULT_PROJECT_PATH;
	if (!projectPath) {
		return;
	}
	const result = await runDataSync(projectPath);
	if (!result.ok) {
		logger.warn('Scheduled data sync failed', { source: 'system' });
	}
};
