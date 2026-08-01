import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { lireOeuvre } from '$lib/server/catalog/corrections';
import { agregatDOeuvre, lecteursDOeuvre, lireAvisDOeuvre } from '$lib/server/journal/entries';
import { masquer, reveler } from '$lib/server/masking/visibility';
import type { Actions, PageServerLoad } from './$types';

/**
 * La page d'une œuvre : la première surface où le masquage se voit.
 *
 * Trois choses y cohabitent, et leur séparation est la règle du produit :
 *
 * - **l'agrégat traverse toujours** (R28). Note moyenne, nombre de notes,
 *   nombre d'avis : rien de tout cela ne passe par le masquage, et c'est ce qui
 *   rend la règle unique vivable — un membre qui parcourt voit les notes
 *   partout, et les textes de ce qu'il a atteint.
 * - **les lecteurs traversent aussi** (R26). Qui a atteint l'œuvre, qui est en
 *   train de la lire, et où il en est.
 * - **les textes passent par `masquer`** (R27), et par lui seul. Ce qui sort
 *   d'ici ne contient pas les textes refusés : ils ne sont pas mis à `null`
 *   après coup dans le rendu, ils ne sont jamais entrés dans la charge utile.
 *   Un masquage appliqué côté client enverrait le texte au navigateur, ce qui
 *   n'est pas du masquage (KTD3).
 */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const d1 = platform?.env?.DB;
	if (!d1 || !locals.member) error(401, 'Session requise.');

	const db = getDb(d1);
	const membreId = locals.member.id;

	const oeuvre = await lireOeuvre(db, params.id);
	if (!oeuvre) error(404, 'Œuvre introuvable.');

	const [agregat, lecteurs, avis] = await Promise.all([
		agregatDOeuvre(db, oeuvre.id),
		lecteursDOeuvre(db, oeuvre.id),
		lireAvisDOeuvre(db, oeuvre.id).then((contenus) => masquer(db, membreId, contenus))
	]);

	const moi = lecteurs.find((lecteur) => lecteur.membreId === membreId) ?? null;

	return {
		oeuvre: {
			id: oeuvre.id,
			titre: oeuvre.titre,
			type: oeuvre.type,
			dateDeParution: oeuvre.dateDeParution,
			serie: oeuvre.serie?.nom ?? null,
			numeroDansLaSerie: oeuvre.numeroDansLaSerie
		},
		agregat,
		lecteurs,
		moi: moi === null ? null : { atteinte: moi.atteinte, position: moi.position },
		// La reconstruction est explicite plutôt qu'un `...avis` : ce qui part au
		// navigateur se lit ici, champ par champ.
		avis: avis.map((contenu) => ({
			id: contenu.id,
			oeuvreId: contenu.oeuvreId,
			auteur: {
				id: contenu.auteurId,
				nom: contenu.auteurParti ? 'Un membre parti' : contenu.auteurNom
			},
			note: contenu.note,
			ecritLe: contenu.ecritLe,
			masque: contenu.masque,
			texte: contenu.texte
		}))
	};
};

export const actions: Actions = {
	/**
	 * R31 — la révélation est un aller-retour serveur, jamais un basculement côté
	 * client. Puisque le texte n'est pas dans la charge utile, il n'y a rien à
	 * dévoiler côté navigateur : le bouton **demande** le texte, le serveur
	 * enregistre la révélation, et la page rechargée le contient enfin.
	 *
	 * **L'œuvre vient de l'URL et le membre de la session.** Ni l'un ni l'autre
	 * n'est lu du formulaire : il n'y a donc aucun identifiant à forger pour
	 * révéler au nom d'un autre.
	 */
	reveler: async ({ params, locals, platform }) => {
		const d1 = platform?.env?.DB;
		if (!d1 || !locals.member) return fail(401, { message: 'Session requise.' });

		const resultat = await reveler(getDb(d1), {
			membreId: locals.member.id,
			oeuvreId: params.id
		});
		if (!resultat.ok) return fail(404, { message: 'Œuvre introuvable.' });

		return { revele: true };
	}
};
