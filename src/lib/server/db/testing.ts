import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from './schema';
import type { Db } from './index';

/**
 * Une base en mémoire montée depuis les migrations réelles.
 *
 * Les tests appliquent les mêmes fichiers SQL que la production plutôt qu'un
 * schéma réécrit à la main : sans ça, une migration et son test peuvent
 * diverger sans que rien ne le signale.
 *
 * D1 et better-sqlite3 sont deux moteurs différents, mais l'un et l'autre
 * exposent la même surface Drizzle sur ce schéma — d'où la conversion de type.
 * La différence qui compte, l'asynchronisme de D1, est absorbée par le fait
 * que la couche serveur attend systématiquement ses appels.
 */
export function createTestDb(): Db {
	const sqlite = new Database(':memory:');
	sqlite.pragma('foreign_keys = ON');

	const migrationsDir = join(process.cwd(), 'drizzle');
	const files = readdirSync(migrationsDir)
		.filter((name) => name.endsWith('.sql'))
		.sort();

	for (const file of files) {
		const sql = readFileSync(join(migrationsDir, file), 'utf8');
		for (const statement of sql.split('--> statement-breakpoint')) {
			const trimmed = statement.trim();
			if (trimmed) sqlite.exec(trimmed);
		}
	}

	return drizzle(sqlite, { schema }) as unknown as Db;
}
