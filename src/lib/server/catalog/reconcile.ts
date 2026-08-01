import { and, eq, ne } from 'drizzle-orm';
import {
	workCharacters,
	workContents,
	workCorrections,
	workCreators,
	workSources,
	works,
	type Work
} from '../db/schema';
import type { Db } from '../db';
import type { ReferenceSource, TypeOeuvre } from './sources/types';
import { signalerRattachementsModifies } from './rematerialisation';

/**
 * Rapprocher deux descriptions de la même œuvre, sans jamais se tromper de
 * sens : **une œuvre en double est un désagrément, une fusion erronée est une
 * perte de données.** Tout ce fichier penche de ce côté-là.
 *
 * Deux chemins, dans cet ordre :
 *
 * 1. L'identifiant de source. C'est une identité, pas une ressemblance : si
 *    Metron a déjà décrit son œuvre 4021, c'est la même.
 * 2. Le triplet série + numéro + date de parution. C'est une ressemblance, et
 *    elle ne suffit qu'entièrement instruite. Sans date des deux côtés, le
 *    verdict est « douteux » et rien n'est fusionné.
 *
 * Le doute ne se résout pas par une heuristique plus agressive mais par un
 * geste de membre : `fusionnerManuellement`.
 */

/**
 * L'écart de date toléré entre deux descriptions du même numéro.
 *
 * Les sources ne datent pas la même chose : Metron donne volontiers la date de
 * couverture, Comic Vine la date de mise en vente, et les deux divergent
 * couramment de deux à trois mois sur les comics américains. Quatre mois
 * absorbent cet écart sans absorber ce qui compte : une réédition ou un reboot
 * qui reprend la numérotation à 1 est à des années de distance, jamais à des
 * semaines.
 */
export const FENETRE_DE_RAPPROCHEMENT_MS = 120 * 24 * 60 * 60 * 1000;

/** Ce qu'il faut savoir d'une œuvre pour la rapprocher d'une autre. */
export interface SignatureOeuvre {
	type: TypeOeuvre;
	serieEntityId: string | null;
	numeroDansLaSerie: number | null;
	dateDeParution: string | null;
}

export type Verdict = 'identique' | 'douteux' | 'distinct';

/**
 * Le verdict de rapprochement sur le triplet. Fonction pure — c'est elle qui
 * porte la règle, et c'est elle qu'on teste.
 *
 * `douteux` n'est pas un demi-`identique` : c'est un refus. Il existe pour que
 * l'appelant ne puisse pas confondre « ces deux œuvres diffèrent » et « je n'ai
 * pas de quoi trancher », et pour que le second cas devienne une proposition de
 * fusion soumise à un membre plutôt qu'une décision de la machine.
 */
export function verdictDeRapprochement(a: SignatureOeuvre, b: SignatureOeuvre): Verdict {
	if (a.type !== b.type) return 'distinct';

	// Sans série ni numéro des deux côtés, le triplet n'existe pas : un film ou
	// un roman ne se rapproche que par identifiant de source.
	if (a.serieEntityId === null || b.serieEntityId === null) return 'distinct';
	if (a.numeroDansLaSerie === null || b.numeroDansLaSerie === null) return 'distinct';
	if (a.serieEntityId !== b.serieEntityId) return 'distinct';
	if (a.numeroDansLaSerie !== b.numeroDansLaSerie) return 'distinct';

	const dateA = horodater(a.dateDeParution);
	const dateB = horodater(b.dateDeParution);
	if (dateA === null || dateB === null) return 'douteux';

	return Math.abs(dateA - dateB) <= FENETRE_DE_RAPPROCHEMENT_MS ? 'identique' : 'distinct';
}

/**
 * Une date ISO 8601 en millisecondes, ou null si elle est absente ou illisible.
 *
 * L'analyse est volontairement stricte plutôt que déléguée à `Date.parse`, dont
 * la tolérance rendrait « circa 1981 » indiscernable d'une vraie date — et
 * transformerait une donnée qu'on ne sait pas lire en certitude de
 * rapprochement. Une date illisible vaut date absente : verdict douteux, aucune
 * fusion.
 */
function horodater(date: string | null): number | null {
	if (date === null) return null;
	const iso = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(date.trim());
	if (!iso) return null;
	const valeur = Date.parse(`${iso[1]}-${iso[2] ?? '01'}-${iso[3] ?? '01'}T00:00:00Z`);
	return Number.isNaN(valeur) ? null : valeur;
}

/** La signature d'une œuvre locale, pour la confronter à une description amont. */
export function signatureDe(oeuvre: Work): SignatureOeuvre {
	return {
		type: oeuvre.type,
		serieEntityId: oeuvre.seriesEntityId,
		numeroDansLaSerie: oeuvre.numberInSeries,
		dateDeParution: oeuvre.releaseDate
	};
}

export interface Rapprochement {
	oeuvreId: string;
	/** Par quel chemin le rapprochement a été établi — utile au diagnostic et aux tests. */
	par: 'identifiant de source' | 'triplet';
}

/**
 * Cherche l'œuvre locale qui décrit déjà celle-ci. `null` si aucune, ou si
 * plusieurs candidates se disputent le rapprochement.
 *
 * L'ambiguïté est traitée comme une absence, pas comme un choix : deux
 * candidates « identiques » signalent un doublon local préexistant, et en
 * choisir une au hasard écraserait la donnée de l'autre.
 */
export async function rapprocher(
	db: Db,
	candidate: SignatureOeuvre & { reference: ReferenceSource }
): Promise<Rapprochement | null> {
	const parSource = await db.query.workSources.findFirst({
		where: and(
			eq(workSources.source, candidate.reference.source),
			eq(workSources.externalId, candidate.reference.idExterne)
		)
	});
	if (parSource) return { oeuvreId: parSource.workId, par: 'identifiant de source' };

	if (candidate.serieEntityId === null || candidate.numeroDansLaSerie === null) return null;

	const memeRang = await db.query.works.findMany({
		where: and(
			eq(works.seriesEntityId, candidate.serieEntityId),
			eq(works.numberInSeries, candidate.numeroDansLaSerie),
			eq(works.type, candidate.type)
		)
	});

	const identiques = memeRang.filter(
		(locale) => verdictDeRapprochement(signatureDe(locale), candidate) === 'identique'
	);
	if (identiques.length !== 1) return null;

	return { oeuvreId: identiques[0].id, par: 'triplet' };
}

/**
 * Les rapprochements que la machine refuse de trancher, à soumettre à un
 * membre.
 *
 * C'est la contrepartie de la prudence de `rapprocher` : sans cette liste, les
 * doublons douteux s'accumuleraient sans que personne ne les voie.
 */
export async function doublonsDouteux(
	db: Db,
	oeuvreId: string
): Promise<{ oeuvre: Work; verdict: Verdict }[]> {
	const oeuvre = await db.query.works.findFirst({ where: eq(works.id, oeuvreId) });
	if (!oeuvre || oeuvre.seriesEntityId === null || oeuvre.numberInSeries === null) return [];

	const memeRang = await db.query.works.findMany({
		where: and(
			eq(works.seriesEntityId, oeuvre.seriesEntityId),
			eq(works.numberInSeries, oeuvre.numberInSeries),
			eq(works.type, oeuvre.type),
			ne(works.id, oeuvre.id)
		)
	});

	const signature = signatureDe(oeuvre);
	return memeRang
		.map((autre) => ({
			oeuvre: autre,
			verdict: verdictDeRapprochement(signature, signatureDe(autre))
		}))
		.filter(({ verdict }) => verdict !== 'distinct');
}

export type MotifRefusFusion = 'œuvre introuvable' | 'même œuvre' | 'types incompatibles';

export type ResultatFusion =
	{ ok: true; oeuvreId: string } | { ok: false; motif: MotifRefusFusion };

/**
 * Fusionne deux œuvres, sur décision d'un membre.
 *
 * Tout ce que portait l'œuvre absorbée passe sur celle qui reste :
 * identifiants de source, personnages, créateurs, contenus, corrections. Rien
 * n'est jeté — c'est la raison d'être des identifiants multi-sources, et c'est
 * ce qui permettra de rejouer l'ingestion auprès des deux sources.
 *
 * La fusion change les rattachements de l'œuvre conservée : elle notifie donc
 * la re-matérialisation du graphe, au même titre qu'une correction.
 *
 * Ce que cette fonction ne fait pas : décider. Elle est appelée après un geste
 * de membre, jamais par une heuristique.
 */
export async function fusionnerManuellement(
	db: Db,
	options: { conservee: string; absorbee: string; now?: number }
): Promise<ResultatFusion> {
	const maintenant = options.now ?? Date.now();
	if (options.conservee === options.absorbee) return { ok: false, motif: 'même œuvre' };

	const conservee = await db.query.works.findFirst({ where: eq(works.id, options.conservee) });
	const absorbee = await db.query.works.findFirst({ where: eq(works.id, options.absorbee) });
	if (!conservee || !absorbee) return { ok: false, motif: 'œuvre introuvable' };
	if (conservee.type !== absorbee.type) return { ok: false, motif: 'types incompatibles' };

	// Les identifiants de source ne peuvent pas entrer en collision : leur clé
	// est (source, id externe), et deux œuvres distinctes n'en partagent aucune.
	await db
		.update(workSources)
		.set({ workId: conservee.id })
		.where(eq(workSources.workId, absorbee.id));

	const personnages = aDeplacer(
		await db.query.workCharacters.findMany({ where: eq(workCharacters.workId, absorbee.id) }),
		await db.query.workCharacters.findMany({ where: eq(workCharacters.workId, conservee.id) }),
		(l) => `${l.entityId}\0${l.source}`
	);
	if (personnages.length > 0) {
		await db
			.insert(workCharacters)
			.values(personnages.map((l) => ({ ...l, workId: conservee.id })));
	}
	await db.delete(workCharacters).where(eq(workCharacters.workId, absorbee.id));

	const createurs = aDeplacer(
		await db.query.workCreators.findMany({ where: eq(workCreators.workId, absorbee.id) }),
		await db.query.workCreators.findMany({ where: eq(workCreators.workId, conservee.id) }),
		(l) => `${l.entityId}\0${l.source}\0${l.role}`
	);
	if (createurs.length > 0) {
		await db.insert(workCreators).values(createurs.map((l) => ({ ...l, workId: conservee.id })));
	}
	await db.delete(workCreators).where(eq(workCreators.workId, absorbee.id));

	const contenus = aDeplacer(
		await db.query.workContents.findMany({ where: eq(workContents.containerWorkId, absorbee.id) }),
		await db.query.workContents.findMany({ where: eq(workContents.containerWorkId, conservee.id) }),
		(l) => `${l.source}\0${l.externalId}`
	);
	if (contenus.length > 0) {
		await db
			.insert(workContents)
			.values(contenus.map((l) => ({ ...l, containerWorkId: conservee.id })));
	}
	await db.delete(workContents).where(eq(workContents.containerWorkId, absorbee.id));

	// L'œuvre absorbée peut aussi figurer dans le contenu d'un recueil.
	await db
		.update(workContents)
		.set({ contentWorkId: conservee.id })
		.where(eq(workContents.contentWorkId, absorbee.id));

	// Les corrections suivent l'œuvre : R39 vaut aussi à travers une fusion.
	await db
		.update(workCorrections)
		.set({ workId: conservee.id })
		.where(eq(workCorrections.workId, absorbee.id));

	// Les champs scalaires de l'absorbée comblent les trous de la conservée,
	// sans jamais écraser une valeur déjà connue.
	await db
		.update(works)
		.set({
			releaseDate: conservee.releaseDate ?? absorbee.releaseDate,
			seriesEntityId: conservee.seriesEntityId ?? absorbee.seriesEntityId,
			numberInSeries: conservee.numberInSeries ?? absorbee.numberInSeries,
			eventEntityId: conservee.eventEntityId ?? absorbee.eventEntityId,
			coverUrl: conservee.coverUrl ?? absorbee.coverUrl,
			updatedAt: maintenant
		})
		.where(eq(works.id, conservee.id));

	await db.delete(works).where(eq(works.id, absorbee.id));
	await signalerRattachementsModifies(db, conservee.id, 'fusion', maintenant);

	return { ok: true, oeuvreId: conservee.id };
}

/** Les lignes de l'œuvre absorbée que la conservée ne porte pas déjà. Fonction pure. */
function aDeplacer<T>(source: T[], cible: T[], cle: (ligne: T) => string): T[] {
	const deja = new Set(cible.map(cle));
	return source.filter((ligne) => !deja.has(cle(ligne)));
}
