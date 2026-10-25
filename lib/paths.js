import os from 'node:os';
import path from 'node:path';
export const DEFAULT_VAULT_PATH = process.env.DSH_MEMORY_VAULT || path.join(os.homedir(), 'codex-deepseek-data', 'vault');
