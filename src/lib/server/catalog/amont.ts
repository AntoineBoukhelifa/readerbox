import type { Db } from '../db';
import type { EtatIngestion } from '../db/schema';
import { ingererOeuvre } from './ingest';
import { oeuvresParReference } from './recherche';
import type { AdaptateurDeSource, MotifEchec, ReferenceSource } from './sources/types';

/**
 * Le pont entre un résultat de recherche et le catalogue : **l'ingestion
 * paresseuse de KTD1, à son seul point de déclenchement.**
 *
 * Une recherche n'écrit rien. C'est le geste d'un membre — consigner, verser dans
 * un ordre, atteindre — qui fait entrer l'œuvre en base, et il passe par ici.
 *
 * **La fiche détaillée est relue avant d'ingérer, toujours.** Un résultat de
 * recherche ne porte ni personnages ni crédits : la liste ne les propose pas.
 * Ingérer ce qu'on a déjà sous la main économiserait un appel et créerait une
 * œuvre sans rattachements, donc un trou permanent dans le graphe du membre. Le
 * coût est un appel cadencé au moment où quelqu'un clique, ce qui est exactement
 * le moment où l'attente est acceptable.
 *
 * **Un échec de sous-ressource ne fait pas échouer la consignation.** Si la fiche
 * répond mais sans sa liste de personnages, l'œuvre entre en base en état
 * partiel, avec ce qui a pu être lu, et le rattrapage la reprendra
 * (`oeuvresARejouer`). Refuser d'ingérer parce qu'une dimension manque
 * empêcherait un membre de consigner ce qu'il vient de lire pour une raison qui
 * ne le regarde pas.
 */

export type MotifRefusAmont = MotifEchec | 'source inconnue' | 'œuvre introuvable';

export type ResultatAmont =
	| { ok: true; oeuvreId: string; etat: EtatIngestion; creee: boolean }
	| { ok: false; motif: MotifRefusAmont };

export interface OptionsAmont {
	reference: ReferenceSource;
	adaptateurs: AdaptateurDeSource[];
	now?: number;
	signal?: AbortSignal;
}

/**
 * Lit une œuvre chez sa source et la persiste.
 *
 * Idempotente par construction : `reconcile.ts` rapproche sur l'identifiant de
 * source, donc consigner deux fois la même référence enrichit l'œuvre au lieu
 * d'en créer une seconde.
 */
export async function ingererDepuisLAmont(db: Db, options: OptionsAmont): Promise<ResultatAmont> {
	const adaptateur = options.adaptateurs.find(
		(candidat) => candidat.nom === options.reference.source
	);
	if (!adaptateur) return { ok: false, motif: 'source inconnue' };

	const lue = await adaptateur.lireOeuvre(options.reference.idExterne, options.signal);
	if (!lue.ok) return { ok: false, motif: lue.motif };
	if (lue.valeur === null) return { ok: false, motif: 'œuvre introuvable' };

	const { oeuvreId, creee, etat } = await ingererOeuvre(db, lue.valeur, {
		...(options.now !== undefined ? { now: options.now } : {})
	});

	return { ok: true, oeuvreId, etat, creee };
}

/**
 * L'œuvre locale d'une référence amont, en l'ingérant si le catalogue ne la
 * connaît pas encore.
 *
 * C'est la forme dont toutes les surfaces ont besoin : elles manipulent des
 * identifiants d'œuvre locale — un ordre, une consignation, un graphe — et un
 * résultat de recherche n'en a pas tant que personne n'a agi dessus.
 *
 * Le catalogue est consulté d'abord, et c'est la seule place où c'est légitime :
 * il ne s'agit pas de *chercher* — KTD1 l'interdit — mais de ne pas redemander à
 * la source une fiche dont on a déjà l'identifiant local. Une ré-ingestion
 * gratuite coûterait un appel cadencé sur le geste le plus fréquent du produit.
 */
export async function oeuvreLocaleDe(db: Db, options: OptionsAmont): Promise<ResultatAmont> {
	const connues = await oeuvresParReference(db, [options.reference]);
	const cle = `${options.reference.source}:${options.reference.idExterne}`;
	const deja = connues.get(cle);
	if (deja !== undefined) {
		const oeuvre = await db.query.works.findFirst({
			where: (works, { eq }) => eq(works.id, deja)
		});
		if (oeuvre) {
			return { ok: true, oeuvreId: deja, etat: oeuvre.ingestionState, creee: false };
		}
	}

	return ingererDepuisLAmont(db, options);
}
