import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { consommerUneReconnexion } from '$lib/server/auth/reconnexion';
import { createSession } from '$lib/server/auth/sessions';
import { poserCookieDeSession } from '$lib/server/auth/cookies';
import type { PageServerLoad } from './$types';

/**
 * Le lien se consomme à l'ouverture, sans formulaire.
 *
 * Contrairement à l'invitation, il n'y a rien à demander : le membre existe
 * déjà, son nom est choisi, il n'a qu'à récupérer une session. Interposer un
 * écran de confirmation n'ajouterait aucune sécurité — quiconque tient le jeton
 * peut cliquer — et coûterait un geste au seul cas d'usage qui compte, celui de
 * quelqu'un qui vient de perdre l'accès.
 */
export const load: PageServerLoad = async ({ params, cookies, platform, locals }) => {
	if (locals.member) redirect(303, '/');

	const d1 = platform?.env?.DB;
	if (!d1) return { motif: 'introuvable' as const };

	const db = getDb(d1);
	const resultat = await consommerUneReconnexion(db, params.token);

	if (!resultat.ok) return { motif: resultat.motif };

	poserCookieDeSession(cookies, await createSession(db, resultat.membreId));
	redirect(303, '/');
};
