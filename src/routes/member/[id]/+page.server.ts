import { error, fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { members } from '$lib/server/db/schema';
import { lireJournal } from '$lib/server/journal/entries';
import { masquer, reveler } from '$lib/server/masking/visibility';
import type { Actions, PageServerLoad } from './$types';

/**
 * R6 — le journal d'un membre est consultable comme une page.
 *
 * Les ordres qu'il suit et ceux qu'il a créés complètent la page ; ils
 * appartiennent à U7 et viendront s'ajouter ici.
 *
 * **Le masquage est celui de R27, et il vient d'ailleurs.** Cette page servait
 * provisoirement le texte des avis à leur seul auteur, faute de règle à appeler.
 * C'était plus strict que R27 — un membre qui a atteint l'œuvre a le droit de
 * lire — et surtout c'était une règle de plus, écrite dans une surface. KTD5 dit
 * exactement pourquoi il ne faut pas : le défaut relevé chez Goodreads vient
 * d'un masquage réimplémenté par surface. La page ne décide donc plus rien ;
 * elle passe les textes à `masquer` et affiche ce qui en revient.
 */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const d1 = platform?.env?.DB;
	if (!d1 || !locals.member) error(401, 'Session requise.');

	const db = getDb(d1);
	const membre = await db.query.members.findFirst({ where: eq(members.id, params.id) });
	if (!membre) error(404, 'Membre introuvable.');

	const entrees = await lireJournal(db, membre.id);

	// Le lot part d'un coup : le masquage coûte trois requêtes pour l'ensemble du
	// journal, pas trois par avis (KTD2).
	const avisVus = await masquer(
		db,
		locals.member.id,
		entrees.flatMap((entree) =>
			entree.avis === null
				? []
				: [
						{
							id: entree.avis.id,
							auteurId: entree.membreId,
							oeuvreId: entree.oeuvre.id,
							texte: entree.avis.texte,
							positionARedaction: entree.avis.positionARedaction
						}
					]
		)
	);
	const parAvis = new Map(avisVus.map((vu) => [vu.id, vu]));

	return {
		membre: { id: membre.id, nom: membre.displayName, parti: membre.leftAt !== null },
		soiMeme: locals.member.id === membre.id,
		entrees: entrees.map((entree) => {
			const vu = entree.avis === null ? undefined : parAvis.get(entree.avis.id);

			return {
				entreeId: entree.entreeId,
				oeuvre: entree.oeuvre,
				etagere: entree.etagere,
				abandonnee: entree.abandonnee,
				atteinte: entree.atteinte,
				position: entree.position,
				note: entree.note,
				avis:
					vu === undefined
						? null
						: { id: vu.id, oeuvreId: vu.oeuvreId, masque: vu.masque, texte: vu.texte }
			};
		})
	};
};

export const actions: Actions = {
	/**
	 * R31 — la même révélation que sur la page d'œuvre, et la même mécanique :
	 * un aller-retour serveur, l'identité prise de la session.
	 *
	 * L'œuvre, elle, vient du formulaire : cette page en liste plusieurs et
	 * l'URL ne désigne que le membre dont on lit le journal. Ce n'est pas une
	 * faiblesse — une œuvre n'est pas un privilège, et la révélation
	 * enregistrée est celle du membre connecté, sur l'œuvre qu'il désigne.
	 */
	reveler: async ({ request, locals, platform }) => {
		const d1 = platform?.env?.DB;
		if (!d1 || !locals.member) return fail(401, { message: 'Session requise.' });

		const oeuvreId = String((await request.formData()).get('oeuvre') ?? '');
		const resultat = await reveler(getDb(d1), { membreId: locals.member.id, oeuvreId });
		if (!resultat.ok) return fail(404, { message: 'Œuvre introuvable.' });

		return { revele: true };
	}
};
