import { getDb } from '$lib/server/db';
import { nomsPresents } from '$lib/server/auth/entree';
import type { PageServerLoad } from './$types';

/**
 * Partager — ce qui reste d'un système d'invitations qui n'a plus lieu d'être.
 *
 * Les liens à usage unique ont été retirés au profit de l'entrée libre (voir
 * `auth/entree.ts`) : il n'y a donc plus rien à émettre ni à révoquer, et la
 * page ne fait plus qu'une chose — rappeler l'adresse et dire ce qu'elle
 * engage. La route garde son chemin pour ne pas casser les liens déjà partagés
 * dans le groupe.
 */
export const load: PageServerLoad = async ({ platform, url }) => {
	const d1 = platform?.env?.DB;
	return {
		adresse: url.origin,
		presents: d1 ? await nomsPresents(getDb(d1)) : []
	};
};
