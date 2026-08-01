import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { cacheDeRecherche } from '$lib/server/catalog/cache';
import {
	chercherDansLeCatalogue,
	type Degradation,
	type ReponseDeCatalogue
} from '$lib/server/catalog/recherche';
import { adaptateursDe } from '$lib/server/catalog/sources';
import {
	consignerDepuisLeCatalogue,
	messageDeRefusAmont
} from '$lib/server/journal/depuisLeCatalogue';
import { ETAGERES, type Etagere } from '$lib/server/journal/atteinte';
import { NOMS_DE_SOURCE, type NomDeSource } from '$lib/server/catalog/sources/types';
import type { Actions, PageServerLoad } from './$types';

/**
 * La recherche — R44, R45, et la porte d'entrée du catalogue.
 *
 * **Elle interroge les sources et fusionne avec le local** (KTD1). Le catalogue
 * du groupe n'est jamais une condition d'arrêt : chercher « Immortal X-Men »
 * rend les dix-huit numéros de la série même si un seul est consigné, et celui
 * qui l'est est simplement marqué comme déjà connu.
 *
 * **Aucune écriture au chargement.** L'ingestion attend la consignation, qui est
 * l'action ci-dessous.
 *
 * Une source qui ne répond pas dégrade la page au lieu de la faire échouer : le
 * motif est annoncé, les résultats des autres s'affichent. Un quota atteint n'est
 * pas une panne et ne se dit pas comme telle.
 */
export const load: PageServerLoad = async ({ url, locals, platform }) => {
	const d1 = platform?.env?.DB;
	if (!d1 || !locals.member) error(401, 'Session requise.');

	const requete = url.searchParams.get('q') ?? '';

	// Une requête vide n'interroge personne — et rend la même forme, pour que la
	// page n'ait pas deux charges utiles à savoir lire.
	const trouvees: ReponseDeCatalogue =
		requete.trim() === ''
			? { resultats: [], degradations: [], depuisLeCache: false }
			: await chercherDansLeCatalogue(getDb(d1), {
					requete,
					adaptateurs: adaptateursDe(platform?.env ?? {}),
					cache: cacheDeRecherche
				});

	return {
		requete,
		// La reconstruction est explicite : ce qui part au navigateur se lit ici.
		resultats: trouvees.resultats.map((resultat) => ({
			cle: resultat.cle,
			oeuvreId: resultat.oeuvreId,
			source: resultat.reference?.source ?? null,
			idExterne: resultat.reference?.idExterne ?? null,
			titre: resultat.titre,
			type: resultat.type,
			dateDeParution: resultat.dateDeParution,
			serie: resultat.serie,
			serieSource: resultat.serieReference?.source ?? null,
			serieIdExterne: resultat.serieReference?.idExterne ?? null,
			numeroDansLaSerie: resultat.numeroDansLaSerie,
			couvertureUrl: resultat.couvertureUrl,
			connueDuGroupe: resultat.connueDuGroupe,
			consignee: resultat.consignee
		})),
		degradations: trouvees.degradations.map(afficher)
	};
};

interface DegradationAffichee {
	source: string;
	motif: string;
	message: string;
}

/** Ce qu'une source injoignable dit au membre, sans jargon et sans dramatiser. */
function afficher(degradation: Degradation): DegradationAffichee {
	return {
		source: degradation.source,
		motif: degradation.motif,
		message: libelleDeDegradation(degradation)
	};
}

function libelleDeDegradation(degradation: Degradation): string {
	switch (degradation.motif) {
		case 'quota':
			return `${degradation.source} a reçu trop de demandes d’un coup : ses résultats reviendront dans un instant.`;
		case 'indisponible':
			return `${degradation.source} ne répond pas en ce moment.`;
		case 'non-autorise':
			return `${degradation.source} refuse nos identifiants.`;
		case 'illisible':
			return `${degradation.source} a répondu quelque chose d’inattendu.`;
	}
}

function estSource(valeur: string): valeur is NomDeSource {
	return (NOMS_DE_SOURCE as readonly string[]).includes(valeur);
}

function estEtagere(valeur: string): valeur is Etagere {
	return (ETAGERES as readonly string[]).includes(valeur);
}

export const actions: Actions = {
	/**
	 * Consigner depuis un résultat de recherche : le geste qui fait entrer l'œuvre
	 * au catalogue (KTD1).
	 *
	 * Deux écritures, dans cet ordre : l'ingestion depuis la source, puis la
	 * consignation. La première relit la fiche détaillée pour en tirer les
	 * personnages, la série et l'event — sans quoi l'œuvre entrerait sans
	 * rattachements et le graphe du membre garderait un trou.
	 *
	 * **Une ingestion partielle ne bloque pas.** Si la source répond sans sa liste
	 * de personnages, l'œuvre entre quand même, marquée comme telle et rejouable :
	 * un membre qui vient de lire un numéro n'a pas à attendre que l'amont se
	 * rétablisse pour le dire.
	 */
	consigner: async ({ request, locals, platform }) => {
		const d1 = platform?.env?.DB;
		if (!d1 || !locals.member) return fail(401, { message: 'Session requise.' });

		const champs = await request.formData();
		const etagere = String(champs.get('etagere') ?? 'a_decouvrir');
		if (!estEtagere(etagere)) return fail(400, { message: 'Étagère inconnue.' });

		const oeuvreId = String(champs.get('oeuvre') ?? '');
		const source = String(champs.get('source') ?? '');
		const idExterne = String(champs.get('idExterne') ?? '');

		const consignation = await consignerDepuisLeCatalogue(getDb(d1), {
			membreId: locals.member.id,
			etagere,
			adaptateurs: adaptateursDe(platform?.env ?? {}),
			...(oeuvreId !== '' ? { oeuvreId } : {}),
			...(estSource(source) && idExterne !== '' ? { reference: { source, idExterne } } : {})
		});

		if (!consignation.ok) {
			const refus = messageDeRefusAmont(consignation.motif);
			return fail(refus.code, { message: refus.message });
		}

		// Une ingestion partielle ne se solde pas par un aller sur la fiche : le
		// membre reste sur ses résultats, et la page lui dit ce qui manque.
		if (consignation.partielle) {
			return {
				fait: true,
				oeuvreId: consignation.oeuvreId,
				message:
					'Consignée. La source n’a pas tout donné : la fiche se complétera d’elle-même plus tard.'
			};
		}

		redirect(303, `/work/${consignation.oeuvreId}`);
	}
};
