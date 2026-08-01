import { redirect, type Handle } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { SESSION_COOKIE, resolveSession } from '$lib/server/auth/sessions';

/**
 * Les seuls chemins accessibles sans session.
 *
 * La liste est blanche et non noire : tout ce qui n'y figure pas est protégé.
 * L'inverse — protéger ce qu'on pense sensible — laisse passer chaque route
 * qu'on oublie d'ajouter, et c'est exactement le genre d'oubli qui ouvre un
 * groupe fermé.
 */
const CHEMINS_PUBLICS = ['/', '/invitation'];

function estPublic(pathname: string): boolean {
	return CHEMINS_PUBLICS.some((chemin) => pathname === chemin || pathname.startsWith(`${chemin}/`));
}

export const handle: Handle = async ({ event, resolve }) => {
	const d1 = event.platform?.env?.DB;

	event.locals.member = d1
		? await resolveSession(getDb(d1), event.cookies.get(SESSION_COOKIE))
		: null;

	if (!event.locals.member && !estPublic(event.url.pathname)) {
		redirect(303, '/');
	}

	return resolve(event);
};
