import pg from 'pg';
import { config } from './config.js';

export const appPool = new pg.Pool({ connectionString: config.databaseUrlApp, max: 10 });
export const platformPool = new pg.Pool({ connectionString: config.databaseUrlPlatform, max: 5 });
