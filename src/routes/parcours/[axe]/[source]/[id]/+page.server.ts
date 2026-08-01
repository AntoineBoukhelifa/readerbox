import { error, fail, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { entities, entitySources } from '$lib/server/db/schema';
import { cacheDeRecherche } from '$lib/server/catalog/cache';
import { parcourirLeCatalogue, type Degradation } from '$lib/server/catalog/recherche';
import { adaptateursDe, adaptateursPourLAxe } from '$lib/server/catalog/sources';
import {
	consignerDepuisLeCatalogue,
	messageDeRefusAmont
} from '$lib/server/journal/depuisLeCatalogue';
import { etatsDuMembre } from '$lib/server/journal/entries';
import { ETAGERES, type Etagere } from '$lib/server/journal/atteinte';
import {
	NOMS_DE_SOURCE,
	type AxeDeParcours,
	type NomDeSource
} from '$lib/server/catalog/sources/types';
import type { Actions, PageServerLoad } from './$types';

/**
 * Le parcours par facette — R46.
 *
 * « Les apparitions d'un personnage, y compris celles qu'aucun membre n'a
 * consignées. » C'est la moitié de la découverte que le catalogue local ne peut
 * pas rendre, et c'est aussi le troisième volet qu'un nœud de graphe ouvrira en
 * U10.
 *
 * **La facette est désignée par sa référence de source**, pas par son
 * identifiant local, et c'est ce qui rend la page atteignable depuis un résultat
 * de recherche portant une entité que le catalogue ne connaît pas encore. Le nom
 * affiché vient du catalogue quand il y est, et de rien sinon : inventer un nom
 * à partir de l'identifiant serait pire que de n'en pas avoir.
 */

const AXES = ['personnage', 'serie', 'createur', 'event'] as const;

const TYPE_DENTITE = {
	personnage: 'personnage',
	serie: 'serie',
	createur: 'createur',
	event: 'event'
} as const;

const LIBELLES: Record<AxeDeParcours, string> = {
	personnage: 'Personnage',
	serie: 'Série',
	createur: 'Créateur',
	event: 'Event'
};

function estAxe(valeur: string): valeur is AxeDeParcours {
	return (AXES as readonly string[]).includes(valeur);
}

function estSource(valeur: string): valeur is NomDeSource {
	return (NOMS_DE_SOURCE as readonly string[]).includes(valeur);
}

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const d1 = platform?.env?.DB;
	if (!d1 || !locals.member) error(401, 'Session requise.');

	if (!estAxe(params.axe)) error(404, 'Axe de parcours inconnu.');
	if (!estSource(params.source)) error(404, 'Source inconnue.');

	const db = getDb(d1);
	const reference = { source: params.source, idExterne: params.id };
	const adaptateurs = adaptateursDe(platform?.env ?? {});

	// Le nom local, s'il existe. C'est le seul nom sûr : celui que la source donne
	// n'arrive qu'avec ses œuvres, et une facette sans résultat n'en aurait aucun.
	const [entite] = await db
		.select({ nom: entities.name })
		.from(entities)
		.innerJoin(entitySources, eq(entitySources.entityId, entities.id))
		.where(
			and(
				eq(entitySources.source, reference.source),
				eq(entitySources.entityType, TYPE_DENTITE[params.axe]),
				eq(entitySources.externalId, reference.idExterne)
			)
		)
		.limit(1);

	const trouvees = await parcourirLeCatalogue(db, {
		axe: params.axe,
		reference,
		adaptateurs,
		cache: cacheDeRecherche
	});

	// Mon état sur ce que la facette a rendu : c'est lui que la grille montre,
	// pas celui du groupe. Une requête pour tout le lot.
	const miens = await etatsDuMembre(
		db,
		locals.member.id,
		trouvees.resultats
			.map((resultat) => resultat.oeuvreId)
			.filter((id): id is string => id !== null)
	);

	return {
		axe: params.axe,
		libelle: LIBELLES[params.axe],
		nom: entite?.nom ?? null,
		source: params.source,
		idExterne: params.id,
		/** Aucune source ne couvre cet axe : c'est une limite déclarée, pas une panne. */
		axeCouvert: adaptateursPourLAxe(adaptateurs, params.axe).some(
			(adaptateur) => adaptateur.nom === params.source
		),
		resultats: trouvees.resultats.map((resultat) => ({
			cle: resultat.cle,
			oeuvreId: resultat.oeuvreId,
			source: resultat.reference?.source ?? null,
			idExterne: resultat.reference?.idExterne ?? null,
			titre: resultat.titre,
			type: resultat.type,
			dateDeParution: resultat.dateDeParution,
			serie: resultat.serie,
			numeroDansLaSerie: resultat.numeroDansLaSerie,
			couvertureUrl: resultat.couvertureUrl,
			connueDuGroupe: resultat.connueDuGroupe,
			consignee: resultat.consignee,
			mien: resultat.oeuvreId === null ? null : (miens.get(resultat.oeuvreId) ?? null)
		})),
		degradations: trouvees.degradations.map(messageDe)
	};
};

function messageDe(degradation: Degradation): { source: string; message: string } {
	const message =
		degradation.motif === 'quota'
			? `${degradation.source} a reçu trop de demandes d’un coup : ses résultats reviendront dans un instant.`
			: degradation.motif === 'indisponible'
				? `${degradation.source} ne répond pas en ce moment.`
				: degradation.motif === 'non-autorise'
					? `${degradation.source} refuse nos identifiants.`
					: `${degradation.source} a répondu quelque chose d’inattendu.`;
	return { source: degradation.source, message };
}

function estEtagere(valeur: string): valeur is Etagere {
	return (ETAGERES as readonly string[]).includes(valeur);
}

export const actions: Actions = {
	/**
	 * Consigner depuis une apparition amont — le geste que R46 rend possible :
	 * partir d'un personnage et prendre un numéro que personne du groupe n'a lu.
	 *
	 * Même règle que sur la recherche, et le même module la porte : une ingestion
	 * partielle n'empêche pas de consigner.
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

		if (consignation.partielle) {
			return {
				fait: true,
				message:
					'Consignée. La source n’a pas tout donné : la fiche se complétera d’elle-même plus tard.'
			};
		}

		redirect(303, `/work/${consignation.oeuvreId}`);
	}
};
