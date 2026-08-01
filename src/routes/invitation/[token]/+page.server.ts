import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { invitations } from '$lib/server/db/schema';
import { invitationState, redeemInvitation } from '$lib/server/auth/invitations';
import { hashToken } from '$lib/server/auth/tokens';
import { createSession } from '$lib/server/auth/sessions';
import { poserCookieDeSession } from '$lib/server/auth/cookies';
import type { Actions, PageServerLoad } from './$types';

/**
 * On regarde l'état du lien avant d'afficher le formulaire, pour ne pas faire
 * saisir un nom à quelqu'un dont le lien est mort. Le jeton n'est pas renvoyé
 * au client : il est déjà dans l'URL, inutile de le dupliquer dans la page.
 */
export const load: PageServerLoad = async ({ params, platform, locals }) => {
	if (locals.member) redirect(303, '/');

	const d1 = platform?.env?.DB;
	if (!d1) return { etat: 'introuvable' as const };

	const invitation = await getDb(d1).query.invitations.findFirst({
		where: eq(invitations.tokenHash, await hashToken(params.token))
	});

	return { etat: invitation ? invitationState(invitation, Date.now()) : ('introuvable' as const) };
};

export const actions: Actions = {
	default: async ({ request, params, cookies, platform }) => {
		const d1 = platform?.env?.DB;
		if (!d1) return fail(500, { message: 'Base indisponible.' });

		const donnees = await request.formData();
		const nom = String(donnees.get('nom') ?? '').trim();
		if (nom.length < 2) {
			return fail(400, { message: 'Choisis un nom d’au moins deux caractères.' });
		}

		const db = getDb(d1);
		const resultat = await redeemInvitation(db, params.token, nom);

		if (!resultat.ok) {
			const messages: Record<string, string> = {
				introuvable: 'Ce lien n’existe pas.',
				consommée: 'Ce lien a déjà été utilisé.',
				révoquée: 'Ce lien a été révoqué.',
				expirée: 'Ce lien a expiré.'
			};
			return fail(400, { message: messages[resultat.reason] ?? 'Ce lien n’est plus valide.' });
		}

		poserCookieDeSession(cookies, await createSession(db, resultat.memberId));
		redirect(303, '/');
	}
};
