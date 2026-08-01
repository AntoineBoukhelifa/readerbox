import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';
import { entities, orderEntries, works } from '../db/schema';
import type { Db } from '../db';
import type { AdaptateurDeSource, ReferenceSource, TypeOeuvre } from '../catalog/sources/types';
import type { CacheDeRecherche } from '../catalog/cache';
import { chercherDansLeCatalogue, type Degradation } from '../catalog/recherche';

/**
 * Ce que l'éditeur d'ordre propose de verser.
 *
 * F2 décrit trois modes de versement — depuis une série entière, depuis son
 * propre journal, une par une depuis la recherche — pour des ordres allant
 * jusqu'à trois cents entrées. Deux surfaces les portent : une recherche
 * incrémentale et un versement en masse par série.
 *
 * **La recherche passe par le catalogue complet, sources amont comprises**
 * (KTD1). C'est ce que le plan attend de U7 : « on doit pouvoir bâtir un ordre
 * sur des numéros que personne n'a encore consignés ». Une œuvre amont n'a pas
 * encore d'identifiant local — elle porte une référence de source — et
 * l'obtiendra au versement, par l'ingestion paresseuse.
 *
 * Le versement en masse par série, lui, reste local : il verse ce que le
 * catalogue porte déjà. Verser une série amont entière voudrait dire ingérer
 * quarante fiches à la cadence de Metron dans une seule requête, ce qui est
 * exactement le fractionnement que U5 prévoit et qui n'a rien à faire ici.
 */

/** Un résultat de recherche, tel que l'éditeur l'affiche. */
export interface OeuvreVersable {
	/** L'œuvre du catalogue. `null` tant qu'elle n'y est pas entrée. */
	id: string | null;
	/** La référence amont, pour l'ingérer au moment du versement. */
	reference: ReferenceSource | null;
	titre: string;
	type: TypeOeuvre;
	dateDeParution: string | null;
	serie: string | null;
	numeroDansLaSerie: number | null;
	couvertureUrl: string | null;
	/** L'œuvre est-elle déjà dans l'ordre en cours d'édition ? */
	dejaPresente: boolean;
	/**
	 * Quelqu'un du groupe l'a-t-il consignée ?
	 *
	 * Purement indicatif — un ordre se bâtit tout autant sur des numéros que
	 * personne n'a lus — mais c'est l'information qui aide un auteur à situer ce
	 * qu'il verse.
	 */
	connueDuGroupe: boolean;
}

/** Une série que l'on peut verser d'un coup. */
export interface SerieVersable {
	entityId: string;
	nom: string;
	/** Combien d'œuvres elle porte, hors l'œuvre « série » elle-même. */
	nombreDOeuvres: number;
}

const RESULTATS_MAX = 25;

export interface OptionsDeVersement {
	requete: string;
	ordreId?: string;
	limite?: number;
	/** Les sources à interroger. Sans elles, la recherche se réduit au catalogue local. */
	adaptateurs?: AdaptateurDeSource[];
	cache?: CacheDeRecherche;
}

export interface RechercheDeVersement {
	resultats: OeuvreVersable[];
	/** Les sources qui n'ont pas répondu. L'éditeur le dit au lieu d'échouer. */
	degradations: Degradation[];
}

/**
 * Cherche des œuvres à verser dans un ordre.
 *
 * Une requête vide ne rend rien plutôt que tout le catalogue : rendre les vingt
 * premières œuvres par ordre d'insertion n'orienterait personne et coûterait une
 * lecture — et un appel amont — à chaque frappe effacée.
 */
export async function chercherAVerser(
	db: Db,
	options: OptionsDeVersement
): Promise<RechercheDeVersement> {
	const requete = options.requete.trim();
	if (requete === '') return { resultats: [], degradations: [] };

	const limite = options.limite ?? RESULTATS_MAX;
	const trouvees = await chercherDansLeCatalogue(db, {
		requete,
		adaptateurs: options.adaptateurs ?? [],
		...(options.cache !== undefined ? { cache: options.cache } : {}),
		limite
	});

	const locales = trouvees.resultats
		.map((resultat) => resultat.oeuvreId)
		.filter((id): id is string => id !== null);

	const dejaLa =
		options.ordreId === undefined || locales.length === 0
			? []
			: await db
					.select({ oeuvre: orderEntries.workId })
					.from(orderEntries)
					.where(
						and(eq(orderEntries.orderId, options.ordreId), inArray(orderEntries.workId, locales))
					);

	const presentes = new Set(dejaLa.map((ligne) => ligne.oeuvre));

	return {
		resultats: trouvees.resultats.map((resultat) => ({
			id: resultat.oeuvreId,
			reference: resultat.reference,
			titre: resultat.titre,
			type: resultat.type,
			dateDeParution: resultat.dateDeParution,
			serie: resultat.serie,
			numeroDansLaSerie: resultat.numeroDansLaSerie,
			couvertureUrl: resultat.couvertureUrl,
			dejaPresente: resultat.oeuvreId !== null && presentes.has(resultat.oeuvreId),
			connueDuGroupe: resultat.consignee
		})),
		degradations: trouvees.degradations
	};
}

/** La forme courte, quand seule la liste importe. */
export async function chercherOeuvresAVerser(
	db: Db,
	options: OptionsDeVersement
): Promise<OeuvreVersable[]> {
	return (await chercherAVerser(db, options)).resultats;
}

/**
 * Les séries que le catalogue connaît, avec le nombre d'œuvres qu'elles portent.
 *
 * Une série sans œuvre n'est pas proposée : « ajouter toute la série X » n'aurait
 * rien à ajouter, et laisser l'auteur le découvrir après coup est une perte de
 * temps évitable.
 */
export async function seriesVersables(db: Db, limite = 100): Promise<SerieVersable[]> {
	const lignes = await db
		.select({ entityId: entities.id, nom: entities.name, n: count(works.id) })
		.from(entities)
		.innerJoin(works, and(eq(works.seriesEntityId, entities.id), ne(works.type, 'serie')))
		.where(eq(entities.type, 'serie'))
		.groupBy(entities.id, entities.name)
		.orderBy(asc(entities.name))
		.limit(limite);

	return lignes.map((ligne) => ({
		entityId: ligne.entityId,
		nom: ligne.nom,
		nombreDOeuvres: ligne.n
	}));
}
