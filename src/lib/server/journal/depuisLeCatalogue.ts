import type { Db } from '../db';
import { oeuvreLocaleDe } from '../catalog/amont';
import type { AdaptateurDeSource, ReferenceSource } from '../catalog/sources/types';
import { consigner, type MotifRefusJournal } from './entries';
import type { Etagere } from './atteinte';

/**
 * Consigner une œuvre trouvée dans le catalogue, qu'elle y soit déjà entrée ou
 * non — c'est-à-dire le seul déclencheur d'écriture de KTD1.
 *
 * Le geste est le même pour un résultat local et pour un résultat amont ; ce qui
 * change est qu'un résultat amont doit d'abord devenir une œuvre. Un module
 * plutôt que deux copies dans deux pages, parce que la règle qui compte — **une
 * ingestion partielle ne bloque pas la consignation** — se réimplémenterait de
 * travers à la troisième surface.
 *
 * L'ordre des deux écritures n'est pas indifférent : l'ingestion d'abord, la
 * consignation ensuite. L'inverse serait impossible — il n'y a rien à consigner
 * tant que l'œuvre n'a pas d'identifiant local — et l'ingestion seule, si la
 * consignation échouait, laisserait au catalogue une œuvre que personne n'a
 * demandée, ce qui est sans conséquence : le catalogue n'appartient à personne.
 */

export type MotifRefusConsignationAmont =
	| MotifRefusJournal
	| 'référence invalide'
	| 'quota'
	| 'indisponible'
	| 'non-autorise'
	| 'illisible'
	| 'source inconnue';

export type ResultatConsignationAmont =
	| {
			ok: true;
			oeuvreId: string;
			/** L'ingestion a-t-elle laissé des trous ? La surface le dit sans dramatiser. */
			partielle: boolean;
	  }
	| { ok: false; motif: MotifRefusConsignationAmont };

export interface OptionsConsignationAmont {
	membreId: string;
	/** L'œuvre locale, quand le catalogue la connaît déjà. */
	oeuvreId?: string;
	/** Sa référence amont, quand il ne la connaît pas encore. */
	reference?: ReferenceSource;
	etagere: Etagere;
	adaptateurs: AdaptateurDeSource[];
	now?: number;
}

export async function consignerDepuisLeCatalogue(
	db: Db,
	options: OptionsConsignationAmont
): Promise<ResultatConsignationAmont> {
	let oeuvreId = options.oeuvreId ?? '';
	let partielle = false;

	if (oeuvreId === '') {
		if (!options.reference) return { ok: false, motif: 'référence invalide' };

		const ingeree = await oeuvreLocaleDe(db, {
			reference: options.reference,
			adaptateurs: options.adaptateurs,
			...(options.now !== undefined ? { now: options.now } : {})
		});
		if (!ingeree.ok) {
			return {
				ok: false,
				motif: ingeree.motif === 'œuvre introuvable' ? 'œuvre introuvable' : ingeree.motif
			};
		}

		oeuvreId = ingeree.oeuvreId;
		// Une source qui a échoué sur une sous-ressource ne bloque pas le geste : le
		// membre a lu ce numéro, et il le dit. Le rattrapage complètera la fiche.
		partielle = ingeree.etat !== 'complete';
	}

	const consignation = await consigner(db, {
		membreId: options.membreId,
		oeuvreId,
		etagere: options.etagere,
		provenance: { type: 'catalogue' },
		...(options.now !== undefined ? { now: options.now } : {})
	});
	if (!consignation.ok) return { ok: false, motif: consignation.motif };

	return { ok: true, oeuvreId, partielle };
}

/**
 * Ce qu'un refus dit au membre, et sous quel code.
 *
 * Le quota mérite sa propre phrase : c'est le seul refus qui n'est la faute de
 * personne et qui se lève tout seul. Le présenter comme une erreur ferait croire
 * à une panne — exactement la confusion que `MotifEchec` existe pour éviter — et
 * pousserait le membre à réessayer en boucle, ce qui prolongerait l'étranglement.
 */
export function messageDeRefusAmont(motif: MotifRefusConsignationAmont): {
	code: number;
	message: string;
} {
	switch (motif) {
		case 'quota':
			return {
				code: 429,
				message:
					'La source a reçu trop de demandes d’un coup. Réessaie dans un instant : rien n’est perdu.'
			};
		case 'indisponible':
			return { code: 502, message: 'La source ne répond pas en ce moment. Réessaie plus tard.' };
		case 'non-autorise':
			return { code: 502, message: 'La source refuse nos identifiants.' };
		case 'illisible':
			return { code: 502, message: 'La source a répondu quelque chose d’inattendu.' };
		case 'source inconnue':
			return { code: 400, message: 'Cette source n’est pas configurée.' };
		case 'référence invalide':
			return { code: 400, message: 'Résultat de recherche incomplet.' };
		case 'œuvre introuvable':
			return { code: 404, message: 'La source ne connaît plus cette œuvre.' };
		default:
			return { code: 400, message: `Refusé : ${motif}.` };
	}
}
