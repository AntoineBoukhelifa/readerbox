import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { members } from '$lib/server/db/schema';
import { lireJournal } from '$lib/server/journal/entries';
import type { PageServerLoad } from './$types';

/**
 * R6 — le journal d'un membre est consultable comme une page.
 *
 * Les ordres qu'il suit et ceux qu'il a créés complètent la page ; ils
 * appartiennent à U7 et viendront s'ajouter ici.
 *
 * **Le texte des avis n'est servi qu'à leur auteur, provisoirement.** R27 est
 * plus large — un texte est visible pour qui a atteint l'œuvre — mais la règle
 * de visibilité est une pièce de U6, et KTD5 exige qu'elle vive en un seul
 * endroit. En attendant, cette page applique une restriction plus stricte que la
 * règle finale : se tromper dans ce sens ne gâche rien à personne, alors que
 * servir le texte à tout le monde en attendant U6 serait exactement la fuite que
 * le masquage existe pour empêcher — et elle partirait dans la charge utile,
 * hors de portée de tout correctif côté client.
 */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const d1 = platform?.env?.DB;
	if (!d1 || !locals.member) error(401, 'Session requise.');

	const db = getDb(d1);
	const membre = await db.query.members.findFirst({ where: eq(members.id, params.id) });
	if (!membre) error(404, 'Membre introuvable.');

	const soiMeme = locals.member.id === membre.id;
	const entrees = await lireJournal(db, membre.id);

	return {
		membre: { id: membre.id, nom: membre.displayName, parti: membre.leftAt !== null },
		soiMeme,
		entrees: entrees.map((entree) => ({
			entreeId: entree.entreeId,
			oeuvre: entree.oeuvre,
			etagere: entree.etagere,
			abandonnee: entree.abandonnee,
			atteinte: entree.atteinte,
			position: entree.position,
			note: entree.note,
			avis:
				entree.avis === null
					? null
					: { id: entree.avis.id, texte: soiMeme ? entree.avis.texte : null }
		}))
	};
};
