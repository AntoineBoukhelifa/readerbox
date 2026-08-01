import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export const getDb = (d1: D1Database) => drizzle(d1, { schema });

/**
 * Le type de base attendu par toute la couche serveur.
 *
 * Il est dérivé de `getDb` plutôt qu'écrit à la main pour que les tests, qui
 * montent le même schéma sur un SQLite en mémoire, restent structurellement
 * compatibles sans dépendre de D1.
 */
export type Db = ReturnType<typeof getDb>;

export { schema };
