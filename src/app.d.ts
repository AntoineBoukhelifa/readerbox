import type { Member } from '$lib/server/db/schema';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}

		interface Locals {
			/**
			 * Le membre authentifié, ou null. Résolu une fois par requête dans
			 * `hooks.server.ts` — aucune route ne relit le cookie elle-même.
			 */
			member: Member | null;
		}

		// interface Error {}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
