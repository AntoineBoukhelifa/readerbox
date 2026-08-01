import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	ajouterEntree,
	ajouterSerie,
	cesserDeSuivre,
	decalerEntree,
	deplacerEntree,
	forker,
	lireOrdre,
	marquerFacultative,
	modifierOrdre,
	retirerEntree,
	suiveursDOrdre,
	suivre,
	supprimerOrdre,
	type MotifRefusOrdre,
	type ResultatSimple
} from '$lib/server/orders/orders';
import { pourcentageAffiche } from '$lib/server/orders/progression';
import { chercherAVerser, seriesVersables } from '$lib/server/orders/versement';
import { adaptateursDe } from '$lib/server/catalog/sources';
import { cacheDeRecherche } from '$lib/server/catalog/cache';
import { oeuvreLocaleDe } from '$lib/server/catalog/amont';
import { NOMS_DE_SOURCE, type NomDeSource } from '$lib/server/catalog/sources/types';
import type { Actions, PageServerLoad } from './$types';

/**
 * La page d'un ordre : ce qu'un suiveur y lit, et ce que son auteur y fait.
 *
 * **La progression est calculée à la lecture, jamais lue** (KTD8). Il n'y a pas
 * de colonne à consulter et rien à tenir à jour : la page dérive l'ensemble des
 * entrées atteintes du membre connecté, et c'est ce qui fait qu'une insertion de
 * l'auteur ne casse la progression de personne.
 *
 * **Le membre vient de la session, l'ordre de l'URL, et rien d'autre n'est lu du
 * formulaire.** Suivre, cesser de suivre et forker sont donc structurellement
 * impossibles à faire au nom d'un autre : il n'y a pas d'identifiant de membre à
 * forger. Les gestes d'édition passent en plus par la vérification d'auteur de
 * `orders.ts`, avant toute écriture (R16).
 */
export const load: PageServerLoad = async ({ params, url, locals, platform }) => {
	const d1 = platform?.env?.DB;
	if (!d1 || !locals.member) error(401, 'Session requise.');

	const db = getDb(d1);
	const ordre = await lireOrdre(db, params.id, locals.member.id);
	if (!ordre) error(404, 'Ordre introuvable.');

	const requete = url.searchParams.get('q') ?? '';

	// La recherche et la liste des séries ne servent qu'à l'éditeur : les charger
	// pour un suiveur serait deux requêtes — et un appel amont — payés pour rien à
	// chaque visite.
	//
	// KTD1 : la recherche de versement interroge les sources comme toutes les
	// autres. C'est ce qui permet de bâtir un ordre sur des numéros que personne
	// n'a encore consignés, ce que le plan attend explicitement de U7.
	const [suiveurs, versement, series] = await Promise.all([
		suiveursDOrdre(db, ordre.id),
		ordre.modifiable && requete !== ''
			? chercherAVerser(db, {
					requete,
					ordreId: ordre.id,
					adaptateurs: adaptateursDe(platform?.env ?? {}),
					cache: cacheDeRecherche
				})
			: Promise.resolve({ resultats: [], degradations: [] }),
		ordre.modifiable ? seriesVersables(db) : Promise.resolve([])
	]);

	return {
		ordre: {
			id: ordre.id,
			titre: ordre.titre,
			description: ordre.description,
			auteur: {
				id: ordre.auteur.id,
				// R38 — l'ordre reste, marqué comme sans auteur.
				nom: ordre.auteur.parti ? 'un membre parti' : ordre.auteur.nom,
				parti: ordre.auteur.parti
			},
			forkDe: ordre.forkDe,
			suivi: ordre.suivi,
			modifiable: ordre.modifiable,
			nombreDeSuiveurs: ordre.nombreDeSuiveurs,
			creeLe: ordre.creeLe
		},
		progression: {
			pourcentage: pourcentageAffiche(ordre.progression),
			essentielles: ordre.progression.essentielles,
			essentiellesAtteintes: ordre.progression.essentiellesAtteintes,
			nombreAtteintes: ordre.progression.atteintes.length,
			total: ordre.progression.total,
			entreeSuivante:
				ordre.progression.entreeSuivante === null
					? null
					: {
							id: ordre.progression.entreeSuivante.id,
							oeuvreId: ordre.progression.entreeSuivante.oeuvreId
						}
		},
		entrees: ordre.entrees.map((entree) => ({
			id: entree.id,
			rang: entree.rang,
			facultative: entree.facultative,
			introuvable: entree.introuvable === true,
			atteinte: entree.atteinte,
			oeuvre: entree.oeuvre
		})),
		suiveurs: suiveurs.map((suiveur) => ({
			membreId: suiveur.membreId,
			nom: suiveur.parti ? 'un membre parti' : suiveur.nom,
			pourcentage: pourcentageAffiche(suiveur.progression),
			nombreAtteintes: suiveur.progression.atteintes.length
		})),
		requete,
		resultats: versement.resultats,
		degradations: versement.degradations.map((degradation) => ({
			source: degradation.source,
			message:
				degradation.motif === 'quota'
					? `${degradation.source} a reçu trop de demandes d’un coup : ses résultats reviendront dans un instant.`
					: `${degradation.source} n’a pas répondu (${degradation.motif}).`
		})),
		series
	};
};

/** Les refus du modèle, tels qu'ils s'affichent — et le code qui leur convient. */
const CODES: Record<MotifRefusOrdre, number> = {
	'ordre introuvable': 404,
	'membre introuvable': 404,
	'œuvre introuvable': 404,
	'entrée introuvable': 404,
	'série introuvable': 404,
	'titre vide': 400,
	'œuvre déjà présente': 400,
	'rang invalide': 400,
	"seul l'auteur peut modifier": 403,
	'ordre sans auteur': 403
};

function rendre(resultat: ResultatSimple) {
	if (resultat.ok) return { fait: true };
	return fail(CODES[resultat.motif], { message: message(resultat.motif) });
}

function message(motif: MotifRefusOrdre): string {
	switch (motif) {
		case "seul l'auteur peut modifier":
			return 'Seul l’auteur de cet ordre peut le modifier. Tu peux le forker.';
		case 'ordre sans auteur':
			return 'Son auteur a quitté le groupe : l’ordre reste en place mais ne bouge plus.';
		case 'œuvre déjà présente':
			return 'Cette œuvre est déjà dans l’ordre.';
		default:
			return `Refusé : ${motif}.`;
	}
}

/** Le contexte commun de toutes les actions. */
async function contexte(evenement: {
	locals: App.Locals;
	platform?: Readonly<App.Platform> | undefined;
	params: { id: string };
	request: Request;
}) {
	const d1 = evenement.platform?.env?.DB;
	if (!d1 || !evenement.locals.member) return null;

	return {
		db: getDb(d1),
		membreId: evenement.locals.member.id,
		ordreId: evenement.params.id,
		champs: await evenement.request.formData()
	};
}

const REFUS_SANS_SESSION = { message: 'Session requise.' };

function estSource(valeur: string): valeur is NomDeSource {
	return (NOMS_DE_SOURCE as readonly string[]).includes(valeur);
}

export const actions: Actions = {
	modifier: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		return rendre(
			await modifierOrdre(ctx.db, {
				membreId: ctx.membreId,
				ordreId: ctx.ordreId,
				titre: String(ctx.champs.get('titre') ?? ''),
				description: String(ctx.champs.get('description') ?? '')
			})
		);
	},

	supprimer: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const resultat = await supprimerOrdre(ctx.db, {
			membreId: ctx.membreId,
			ordreId: ctx.ordreId
		});
		if (!resultat.ok) return rendre(resultat);
		redirect(303, '/orders');
	},

	/**
	 * Verser une œuvre — locale, ou amont et pas encore au catalogue.
	 *
	 * Dans le second cas l'ingestion précède l'ajout : une entrée d'ordre référence
	 * une œuvre locale, et il n'y en a pas tant que personne n'a agi. C'est le
	 * troisième déclencheur d'écriture de KTD1, à côté de la consignation et de
	 * l'atteinte.
	 */
	ajouter: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		let oeuvreId = String(ctx.champs.get('oeuvre') ?? '');
		if (oeuvreId === '') {
			const source = String(ctx.champs.get('source') ?? '');
			const idExterne = String(ctx.champs.get('idExterne') ?? '');
			if (!estSource(source) || idExterne === '') {
				return fail(400, { message: 'Résultat de recherche incomplet.' });
			}

			const ingeree = await oeuvreLocaleDe(ctx.db, {
				reference: { source, idExterne },
				adaptateurs: adaptateursDe(evenement.platform?.env ?? {})
			});
			if (!ingeree.ok) {
				return fail(ingeree.motif === 'quota' ? 429 : 502, {
					message:
						ingeree.motif === 'quota'
							? 'La source a reçu trop de demandes d’un coup. Réessaie dans un instant.'
							: `La source n’a pas pu être lue (${ingeree.motif}).`
				});
			}
			oeuvreId = ingeree.oeuvreId;
		}

		const resultat = await ajouterEntree(ctx.db, {
			membreId: ctx.membreId,
			ordreId: ctx.ordreId,
			oeuvreId,
			facultative: ctx.champs.get('facultative') === '1'
		});
		return resultat.ok ? { fait: true } : rendre(resultat);
	},

	ajouterSerie: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const resultat = await ajouterSerie(ctx.db, {
			membreId: ctx.membreId,
			ordreId: ctx.ordreId,
			serieEntityId: String(ctx.champs.get('serie') ?? ''),
			facultative: ctx.champs.get('facultative') === '1'
		});
		if (!resultat.ok) return rendre(resultat);

		return {
			fait: true,
			message: resultat.tronque
				? `${resultat.ajoutees} œuvres versées. La série en compte davantage : relance pour la suite.`
				: `${resultat.ajoutees} œuvres versées.`
		};
	},

	retirer: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		return rendre(
			await retirerEntree(ctx.db, {
				membreId: ctx.membreId,
				ordreId: ctx.ordreId,
				entreeId: String(ctx.champs.get('entree') ?? '')
			})
		);
	},

	/**
	 * Le rang saisi est affiché à partir de 1 — un ordre de lecture se lit
	 * « la troisième entrée », pas « l'entrée d'indice 2 » — et converti ici.
	 */
	deplacer: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const saisi = Number(ctx.champs.get('rang'));
		if (!Number.isInteger(saisi)) return fail(400, { message: 'Rang invalide.' });

		return rendre(
			await deplacerEntree(ctx.db, {
				membreId: ctx.membreId,
				ordreId: ctx.ordreId,
				entreeId: String(ctx.champs.get('entree') ?? ''),
				nouveauRang: saisi - 1
			})
		);
	},

	monter: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		return rendre(
			await decalerEntree(ctx.db, {
				membreId: ctx.membreId,
				ordreId: ctx.ordreId,
				entreeId: String(ctx.champs.get('entree') ?? ''),
				decalage: -1
			})
		);
	},

	descendre: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		return rendre(
			await decalerEntree(ctx.db, {
				membreId: ctx.membreId,
				ordreId: ctx.ordreId,
				entreeId: String(ctx.champs.get('entree') ?? ''),
				decalage: 1
			})
		);
	},

	basculer: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		return rendre(
			await marquerFacultative(ctx.db, {
				membreId: ctx.membreId,
				ordreId: ctx.ordreId,
				entreeId: String(ctx.champs.get('entree') ?? ''),
				facultative: ctx.champs.get('facultative') === '1'
			})
		);
	},

	/** R17 — suivre. Le membre est celui de la session, jamais un champ reçu. */
	suivre: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		return rendre(await suivre(ctx.db, { membreId: ctx.membreId, ordreId: ctx.ordreId }));
	},

	/** R36 — cesser de suivre ne fait rien perdre : aucune consignation n'est touchée. */
	cesserDeSuivre: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		return rendre(await cesserDeSuivre(ctx.db, { membreId: ctx.membreId, ordreId: ctx.ordreId }));
	},

	/** R17 — partir de l'ordre d'un autre, et atterrir sur le sien. */
	forker: async (evenement) => {
		const ctx = await contexte(evenement);
		if (!ctx) return fail(401, REFUS_SANS_SESSION);

		const resultat = await forker(ctx.db, {
			membreId: ctx.membreId,
			ordreId: ctx.ordreId,
			titre: String(ctx.champs.get('titre') ?? '')
		});
		if (!resultat.ok) return fail(CODES[resultat.motif], { message: message(resultat.motif) });

		redirect(303, `/order/${resultat.ordreId}`);
	}
};
