import { and, asc, count, eq, inArray, like, ne, sql } from 'drizzle-orm';
import { entities, journalEntries, orderEntries, workCorrections, works } from '../db/schema';
import type { Db } from '../db';
import type { TypeOeuvre } from '../catalog/sources/types';
import { titresCorriges } from '../catalog/corrections';

/**
 * Ce que l'éditeur d'ordre propose de verser.
 *
 * F2 décrit trois modes de versement — depuis une série entière, depuis son
 * propre journal, une par une depuis la recherche — pour des ordres allant
 * jusqu'à trois cents entrées. Deux surfaces les portent : une recherche
 * incrémentale et un versement en masse par série.
 *
 * **Ce module interroge le catalogue local, et le dit.** KTD1 veut qu'une
 * recherche interroge systématiquement les sources amont et fusionne avec le
 * local — mais les adaptateurs de source sont U3b, bloquée sur des clés d'API que
 * nous n'avons pas. Le versement porte donc, pour l'instant, sur les œuvres que
 * le catalogue connaît déjà. Ce qui compte pour U7 est ailleurs et tient dès
 * maintenant : **une œuvre du catalogue n'a pas à être consignée par qui que ce
 * soit pour entrer dans un ordre.** Le jour où U3b existera, cette fonction se
 * bornera à fusionner ses résultats avec ceux de l'amont ; rien de ce que U7
 * garantit ne bougera.
 */

/** Un résultat de recherche, tel que l'éditeur l'affiche. */
export interface OeuvreVersable {
	id: string;
	titre: string;
	type: TypeOeuvre;
	dateDeParution: string | null;
	serie: string | null;
	numeroDansLaSerie: number | null;
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

/**
 * Cherche des œuvres à verser dans un ordre.
 *
 * La recherche porte sur le titre **de source et corrigé** : un membre qui a
 * corrigé une fiche fausse (R47) doit retrouver l'œuvre sous le titre qu'il a
 * posé, pas sous celui qu'il a justement corrigé. Deux requêtes plutôt qu'une
 * jointure, parce qu'une correction est rare et que la jointure la ferait payer
 * à toutes les recherches.
 *
 * Une requête vide ne rend rien plutôt que tout le catalogue : rendre les vingt
 * premières œuvres par ordre d'insertion n'orienterait personne et coûterait une
 * lecture à chaque frappe effacée.
 */
export async function chercherOeuvresAVerser(
	db: Db,
	options: { requete: string; ordreId?: string; limite?: number }
): Promise<OeuvreVersable[]> {
	const requete = options.requete.trim();
	if (requete === '') return [];

	const limite = options.limite ?? RESULTATS_MAX;
	const motif = `%${echapperLike(requete)}%`;

	const [directes, parCorrection] = await Promise.all([
		db
			.select({ id: works.id })
			.from(works)
			.where(like(works.title, sql`${motif} escape '\\'`))
			.limit(limite),
		db
			.select({ id: workCorrections.workId })
			.from(workCorrections)
			.where(
				and(
					eq(workCorrections.field, 'titre'),
					like(workCorrections.value, sql`${motif} escape '\\'`)
				)
			)
			.limit(limite)
	]);

	const ids = [...new Set([...directes, ...parCorrection].map((ligne) => ligne.id))].slice(
		0,
		limite
	);
	if (ids.length === 0) return [];

	const [lignes, titres, dejaLa, consignees] = await Promise.all([
		db
			.select({
				id: works.id,
				type: works.type,
				date: works.releaseDate,
				numero: works.numberInSeries,
				serie: entities.name
			})
			.from(works)
			.leftJoin(entities, eq(entities.id, works.seriesEntityId))
			.where(inArray(works.id, ids)),
		titresCorriges(db, ids),
		options.ordreId === undefined
			? Promise.resolve([])
			: db
					.select({ oeuvre: orderEntries.workId })
					.from(orderEntries)
					.where(and(eq(orderEntries.orderId, options.ordreId), inArray(orderEntries.workId, ids))),
		db
			.selectDistinct({ oeuvre: journalEntries.workId })
			.from(journalEntries)
			.where(inArray(journalEntries.workId, ids))
	]);

	const presentes = new Set(dejaLa.map((ligne) => ligne.oeuvre));
	const connues = new Set(consignees.map((ligne) => ligne.oeuvre));

	return lignes
		.map((ligne) => ({
			id: ligne.id,
			titre: titres.get(ligne.id) ?? '',
			type: ligne.type,
			dateDeParution: ligne.date,
			serie: ligne.serie,
			numeroDansLaSerie: ligne.numero,
			dejaPresente: presentes.has(ligne.id),
			connueDuGroupe: connues.has(ligne.id)
		}))
		.sort((a, b) => a.titre.localeCompare(b.titre));
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

/**
 * Échappe les caractères que `LIKE` interprète.
 *
 * Sans ça, une recherche contenant `%` rendrait tout le catalogue et un `_`
 * rendrait n'importe quoi — ce n'est pas une faille, les titres viennent du
 * catalogue et pas d'un texte exécuté, mais c'est un résultat faux.
 */
function echapperLike(valeur: string): string {
	return valeur.replace(/[\\%_]/g, (caractere) => `\\${caractere}`);
}
