import { fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { creerOrdre } from '$lib/server/orders/orders';
import type { Actions } from './$types';

/**
 * Créer un ordre : un titre, une description, et rien d'autre.
 *
 * Le versement des œuvres se fait ensuite, dans l'éditeur — F2 décrit bien deux
 * temps, « il crée un ordre, le titre, **puis** y verse des œuvres ». Demander
 * trois cents entrées avant d'avoir un objet à montrer serait le meilleur moyen
 * de perdre le travail d'un formulaire à la première erreur de saisie.
 */
export const actions: Actions = {
	default: async ({ request, locals, platform }) => {
		const champs = await request.formData();
		const titre = String(champs.get('titre') ?? '');
		const description = String(champs.get('description') ?? '');

		// La saisie est renvoyée dans tous les cas de refus : une description de
		// quatre lignes ne se retape pas parce que la session a expiré.
		const d1 = platform?.env?.DB;
		if (!d1 || !locals.member) {
			return fail(401, { message: 'Session requise.', titre, description });
		}

		const resultat = await creerOrdre(getDb(d1), {
			membreId: locals.member.id,
			titre,
			description
		});

		if (!resultat.ok) {
			return fail(400, {
				message: resultat.motif === 'titre vide' ? 'Un ordre a besoin d’un titre.' : 'Refusé.',
				titre,
				description
			});
		}

		redirect(303, `/order/${resultat.ordreId}`);
	}
};
