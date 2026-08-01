import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listerOrdres } from '$lib/server/orders/orders';
import { pourcentageAffiche } from '$lib/server/orders/progression';
import type { PageServerLoad } from './$types';

/**
 * Les ordres du groupe — le point d'entrée de F3.
 *
 * « Il trouve les ordres créés par le groupe, en choisit un, le suit. » Aucun
 * filtre : R17 les rend visibles par tout le groupe, et un ordre que personne ne
 * voit ne sert à rien.
 *
 * **La progression affichée est celle du membre connecté**, calculée à la
 * lecture pour chaque ordre. Elle vaut même pour un ordre qu'il ne suit pas, ce
 * qui est exactement ce qui rend l'objet attirant : on découvre qu'on en a déjà
 * lu un tiers sans le savoir.
 */
export const load: PageServerLoad = async ({ locals, platform }) => {
	const d1 = platform?.env?.DB;
	if (!d1 || !locals.member) error(401, 'Session requise.');

	const ordres = await listerOrdres(getDb(d1), locals.member.id);

	return {
		ordres: ordres.map((ordre) => ({
			id: ordre.id,
			titre: ordre.titre,
			description: ordre.description,
			// R38 — un ordre dont l'auteur est parti reste en place, sans son nom.
			auteur: ordre.auteur.parti ? 'un membre parti' : ordre.auteur.nom,
			nombreDEntrees: ordre.nombreDEntrees,
			nombreDeSuiveurs: ordre.nombreDeSuiveurs,
			suivi: ordre.suivi,
			mien: ordre.modifiable,
			pourcentage: pourcentageAffiche(ordre.progression)
		}))
	};
};
