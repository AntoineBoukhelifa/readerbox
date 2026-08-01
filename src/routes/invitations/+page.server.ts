import { fail } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { invitations } from '$lib/server/db/schema';
import { createInvitation, invitationState, revokeInvitation } from '$lib/server/auth/invitations';
import type { Actions, PageServerLoad } from './$types';

/**
 * Chaque membre ne voit et ne révoque que les liens qu'il a émis lui-même.
 *
 * Ce n'est pas une hiérarchie déguisée : c'est que révoquer le lien d'un autre
 * sans le prévenir couperait quelqu'un qu'il attend. La règle « tout membre
 * peut inviter » reste entière.
 */
export const load: PageServerLoad = async ({ locals, platform }) => {
	const d1 = platform?.env?.DB;
	if (!d1 || !locals.member) return { liens: [] };

	const maintenant = Date.now();
	const rangs = await getDb(d1)
		.select()
		.from(invitations)
		.where(eq(invitations.createdBy, locals.member.id))
		.orderBy(desc(invitations.createdAt));

	return {
		liens: rangs.map((invitation) => ({
			id: invitation.id,
			creeLe: invitation.createdAt,
			expireLe: invitation.expiresAt,
			etat: invitationState(invitation, maintenant)
		}))
	};
};

export const actions: Actions = {
	emettre: async ({ locals, platform, url }) => {
		const d1 = platform?.env?.DB;
		if (!d1 || !locals.member) return fail(401, { message: 'Session requise.' });

		const emise = await createInvitation(getDb(d1), { createdBy: locals.member.id });
		// R38 — un membre parti ne fait plus entrer personne, et la règle est
		// vérifiée par l'émission elle-même, pas seulement par la session.
		if (!emise.ok) return fail(403, { message: 'Tu as quitté le groupe.' });

		return { lien: new URL(`/invitation/${emise.token}`, url.origin).toString() };
	},

	revoquer: async ({ request, locals, platform }) => {
		const d1 = platform?.env?.DB;
		if (!d1 || !locals.member) return fail(401, { message: 'Session requise.' });

		const id = String((await request.formData()).get('id') ?? '');
		const db = getDb(d1);

		// Vérification de propriétaire avant l'écriture : sans elle, un identifiant
		// forgé permettrait de révoquer le lien de quelqu'un d'autre.
		const invitation = await db.query.invitations.findFirst({
			where: eq(invitations.id, id)
		});
		if (!invitation || invitation.createdBy !== locals.member.id) {
			return fail(404, { message: 'Lien introuvable.' });
		}

		const resultat = await revokeInvitation(db, id);
		if (resultat !== 'révoquée') return fail(400, { message: `Lien ${resultat}.` });
		return { revoque: true };
	}
};
