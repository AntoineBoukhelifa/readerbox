import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { ouvrirGraphe } from '$lib/server/graph/query';
import { analyserDimensions, messageDeRefus } from '$lib/graph/rendu';
import { consigner } from '$lib/server/journal/entries';
import { ETAGERES, type Etagere } from '$lib/server/journal/atteinte';
import type { Actions, PageServerLoad } from './$types';

/**
 * Le graphe de l'univers, tel qu'un membre le voit (F6, R48 à R53).
 *
 * **Le membre vient de la session, jamais de l'URL.** Cette page n'a pas de
 * paramètre de route et n'en aura pas : le graphe est celui de `locals.member`,
 * et les seules valeurs que l'URL porte — les dimensions actives et le nœud
 * ouvert — ne désignent personne. Il n'y a donc rien à forger pour obtenir le
 * graphe d'un autre, et rien à vérifier pour l'en empêcher. C'est le même parti
 * pris que les gestes de suivi de U7 et que la révélation de U6.
 *
 * **Aucun calcul de graphe ici.** La page appelle `ouvrirGraphe`, qui fait une
 * lecture indexée sur la table matérialisée par U9 et projette en mémoire. Rien
 * ne parcourt le graphe, rien ne joint deux nœuds visibles : R52 est portée par
 * la matérialisation à l'écriture, et une surface qui recalculerait la ruinerait
 * (KTD4).
 */
export const load: PageServerLoad = async ({ url, locals, platform }) => {
	const d1 = platform?.env?.DB;
	if (!d1 || !locals.member) error(401, 'Session requise.');

	const choix = analyserDimensions(url.searchParams.getAll('dimension'));

	const vue = await ouvrirGraphe(getDb(d1), locals.member.id, {
		dimensions: choix.dimensions,
		refus: choix.refus,
		noeud: url.searchParams.get('noeud')
	});

	return {
		dimensions: vue.dimensions,
		/** Le plafond de R49 se dit, il ne se subit pas. */
		message: vue.refus === null ? null : messageDeRefus(vue.refus),
		graphe: vue.graphe,
		filtrageClient: vue.filtrageClient,
		volume: vue.volume,
		/** `null` quand aucun nœud n'est demandé, ou quand il n'est pas dans ce graphe. */
		noeud: vue.noeud,
		/** L'ordre proposé à qui n'a encore rien atteint. */
		suggestion: vue.suggestion
	};
};

function estEtagere(valeur: string): valeur is Etagere {
	return (ETAGERES as readonly string[]).includes(valeur);
}

export const actions: Actions = {
	/**
	 * R42 — consigner depuis un nœud, sans quitter le graphe.
	 *
	 * C'est le geste que le critère de réussite du produit attend : un membre
	 * trouve, dans les apparitions non atteintes d'un nœud, une œuvre qu'il
	 * n'aurait pas trouvée par la recherche, et la pose sur une étagère d'un clic.
	 * L'obliger à ouvrir la fiche pour ça briserait le fil de F6 au moment
	 * précis où il aboutit.
	 *
	 * La provenance est **le catalogue** : ni un membre ni un ordre ne l'a
	 * recommandée, c'est le parcours qui l'a fait trouver. R42 range explicitement
	 * le graphe de ce côté-là.
	 *
	 * Le membre vient de la session ; seule l'œuvre vient du formulaire, et
	 * `consigner` refuse une œuvre inconnue.
	 */
	consigner: async ({ request, locals, platform }) => {
		const d1 = platform?.env?.DB;
		if (!d1 || !locals.member) return fail(401, { message: 'Session requise.' });

		const champs = await request.formData();
		const oeuvreId = String(champs.get('oeuvre') ?? '');
		const demandee = String(champs.get('etagere') ?? 'a_decouvrir');
		if (!estEtagere(demandee)) return fail(400, { message: 'Étagère inconnue.' });

		const resultat = await consigner(getDb(d1), {
			membreId: locals.member.id,
			oeuvreId,
			etagere: demandee,
			provenance: { type: 'catalogue' }
		});

		return resultat.ok
			? { fait: true, message: 'Posée sur ton étagère. Ton graphe s’étendra quand tu l’auras lue.' }
			: fail(404, { message: `Refusé : ${resultat.motif}.` });
	}
};
