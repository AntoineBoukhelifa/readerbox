import { and, eq, inArray, like, sql } from 'drizzle-orm';
import {
	entities,
	entitySources,
	journalEntries,
	workCharacters,
	workCorrections,
	workCreators,
	workSources,
	works
} from '../db/schema';
import type { Db } from '../db';
import { titresCorriges } from './corrections';
import { cleDeParcours, cleDeRecherche, type CacheDeRecherche } from './cache';
import { adaptateursPourLAxe } from './sources';
import type {
	AdaptateurDeSource,
	AxeDeParcours,
	MotifEchec,
	NomDeSource,
	OeuvreDistante,
	ReferenceSource,
	TypeOeuvre
} from './sources/types';

/**
 * KTD1 — **le local n'est jamais une condition d'arrêt.**
 *
 * Toute recherche et tout parcours par facette interrogent les sources amont
 * *et* fusionnent avec le catalogue local, les œuvres déjà connues du groupe
 * étant simplement marquées comme telles.
 *
 * La règle inverse — servir depuis le local dès qu'il répond — a l'air d'une
 * optimisation évidente et c'est un défaut qui s'aggrave tout seul : chercher une
 * série dont un seul numéro est consigné ne ramènerait que ce numéro, et chaque
 * consignation rétrécirait un peu plus la découverte. Une revue l'a rattrapé une
 * fois ; ce fichier existe pour qu'il ne revienne pas.
 *
 * Trois conséquences, toutes visibles ici :
 *
 * 1. **L'amont est appelé d'abord, et l'ordre des résultats est le sien.** Le
 *    local ne fait qu'ajouter ce que l'amont n'a pas rendu.
 * 2. **Rien n'est persisté.** Une recherche ne fait aucune écriture — l'ingestion
 *    attend la consignation (`amont.ts`).
 * 3. **Une source qui échoue dégrade, elle ne fait pas échouer.** Le motif
 *    remonte dans `degradations`, la page s'affiche avec ce qui reste.
 */

/** Une ligne de résultat, quelle que soit sa provenance. */
export interface ResultatDeCatalogue {
	/** Une clé stable pour l'affichage : l'œuvre locale si elle existe, la référence amont sinon. */
	cle: string;
	/** L'œuvre du catalogue, si le groupe la connaît déjà. */
	oeuvreId: string | null;
	/** La référence amont, quand le résultat en vient. */
	reference: ReferenceSource | null;
	titre: string;
	type: TypeOeuvre;
	dateDeParution: string | null;
	serie: string | null;
	serieReference: ReferenceSource | null;
	numeroDansLaSerie: number | null;
	couvertureUrl: string | null;
	/** L'œuvre est-elle déjà au catalogue du groupe ? */
	connueDuGroupe: boolean;
	/** Quelqu'un l'a-t-il consignée ? Indicatif, mais c'est ce qui situe un résultat. */
	consignee: boolean;
}

/** Une source qui n'a pas répondu, et pourquoi. La page le dit plutôt que d'échouer. */
export interface Degradation {
	source: NomDeSource;
	motif: MotifEchec;
}

export interface ReponseDeCatalogue {
	resultats: ResultatDeCatalogue[];
	degradations: Degradation[];
	/** Les réponses amont venaient-elles du cache ? Pour le diagnostic et les tests. */
	depuisLeCache: boolean;
}

export const RESULTATS_MAX = 25;

export interface OptionsDeRecherche {
	requete: string;
	adaptateurs: AdaptateurDeSource[];
	cache?: CacheDeRecherche;
	limite?: number;
	signal?: AbortSignal;
}

/**
 * Cherche dans tout l'univers : les sources d'abord, le catalogue ensuite.
 *
 * **Aucune écriture.** Ce qui remonte de l'amont est une description, pas une
 * œuvre : elle n'entre en base que si un membre la consigne.
 */
export async function chercherDansLeCatalogue(
	db: Db,
	options: OptionsDeRecherche
): Promise<ReponseDeCatalogue> {
	const requete = options.requete.trim();
	if (requete === '') return { resultats: [], degradations: [], depuisLeCache: false };

	const limite = options.limite ?? RESULTATS_MAX;

	const amont = await interrogerLAmont(
		options.adaptateurs.filter((adaptateur) => adaptateur.capacites.rechercheParTitre),
		options.cache,
		(adaptateur) => ({
			cle: cleDeRecherche(adaptateur.nom, requete),
			appel: () => adaptateur.rechercher(requete, { limite, signal: options.signal })
		})
	);

	const locales = await chercherOeuvresLocales(db, requete, limite);

	return {
		resultats: await fusionner(db, amont.oeuvres, locales, limite),
		degradations: amont.degradations,
		depuisLeCache: amont.depuisLeCache
	};
}

export interface OptionsDeParcours {
	axe: AxeDeParcours;
	reference: ReferenceSource;
	adaptateurs: AdaptateurDeSource[];
	cache?: CacheDeRecherche;
	limite?: number;
	signal?: AbortSignal;
}

/**
 * Le parcours par facette — R46, et le troisième volet d'un nœud de graphe en
 * U10 : **les apparitions qu'aucun membre n'a encore consignées**.
 *
 * Sans lui, ouvrir un personnage ne montrerait que ce que le groupe a déjà lu,
 * c'est-à-dire une rétrospective là où le produit promet une découverte.
 *
 * Seules les sources qui déclarent l'axe sont interrogées, et seule celle qui
 * porte la référence : demander à TMDB les apparitions du personnage Metron 1391
 * n'a aucun sens — les espaces d'identifiants sont disjoints.
 */
export async function parcourirLeCatalogue(
	db: Db,
	options: OptionsDeParcours
): Promise<ReponseDeCatalogue> {
	const limite = options.limite ?? RESULTATS_MAX;
	const capables = adaptateursPourLAxe(options.adaptateurs, options.axe).filter(
		(adaptateur) => adaptateur.nom === options.reference.source
	);

	const amont = await interrogerLAmont(capables, options.cache, (adaptateur) => ({
		cle: cleDeParcours(adaptateur.nom, options.axe, options.reference.idExterne),
		appel: () =>
			adaptateur.parcourir(options.axe, options.reference.idExterne, {
				limite,
				signal: options.signal
			})
	}));

	const locales = await oeuvresLocalesDeLaFacette(db, options.axe, options.reference, limite);

	return {
		resultats: await fusionner(db, amont.oeuvres, locales, limite),
		degradations: amont.degradations,
		depuisLeCache: amont.depuisLeCache
	};
}

// ---------------------------------------------------------------------------
// L'amont
// ---------------------------------------------------------------------------

/**
 * Interroge toutes les sources en parallèle, cache à l'appui.
 *
 * En parallèle et non en série : une source lente ne doit pas retarder l'autre,
 * et la cadence de Metron est déjà tenue à l'intérieur de son propre adaptateur.
 *
 * Le cache est consulté **par source**, pas pour l'ensemble : une source en panne
 * ne doit pas empêcher de servir la réponse mémorisée de l'autre.
 */
interface ReponseDeSource {
	source: NomDeSource;
	oeuvres: OeuvreDistante[];
	motif: MotifEchec | null;
	depuisLeCache: boolean;
}

async function interrogerLAmont(
	adaptateurs: AdaptateurDeSource[],
	cache: CacheDeRecherche | undefined,
	plan: (adaptateur: AdaptateurDeSource) => {
		cle: string;
		appel: () => Promise<
			{ ok: true; valeur: { elements: OeuvreDistante[] } } | { ok: false; motif: MotifEchec }
		>;
	}
): Promise<{ oeuvres: OeuvreDistante[][]; degradations: Degradation[]; depuisLeCache: boolean }> {
	const reponses: ReponseDeSource[] = await Promise.all(
		adaptateurs.map(async (adaptateur) => {
			const { cle, appel } = plan(adaptateur);

			const memorisee = cache?.lire<OeuvreDistante[]>(cle);
			if (memorisee !== undefined) {
				return { source: adaptateur.nom, oeuvres: memorisee, motif: null, depuisLeCache: true };
			}

			const resultat = await appel();
			if (!resultat.ok) {
				return {
					source: adaptateur.nom,
					oeuvres: [],
					motif: resultat.motif,
					depuisLeCache: false
				};
			}

			// Seuls les succès sont gardés : mémoriser un échec ferait durer une
			// panne passagère au-delà d'elle-même.
			cache?.ecrire(cle, resultat.valeur.elements);
			return {
				source: adaptateur.nom,
				oeuvres: resultat.valeur.elements,
				motif: null,
				depuisLeCache: false
			};
		})
	);

	return {
		// Les listes restent séparées par source : la fusion en a besoin pour donner
		// à chacune sa part du plafond de résultats.
		oeuvres: reponses.map((reponse) => reponse.oeuvres),
		degradations: reponses
			.filter(
				(reponse): reponse is ReponseDeSource & { motif: MotifEchec } => reponse.motif !== null
			)
			.map((reponse) => ({ source: reponse.source, motif: reponse.motif })),
		depuisLeCache: reponses.length > 0 && reponses.every((reponse) => reponse.depuisLeCache)
	};
}

// ---------------------------------------------------------------------------
// Le local
// ---------------------------------------------------------------------------

/** Une œuvre du catalogue, telle que la fusion la manipule. */
export interface OeuvreLocaleTrouvee {
	id: string;
	titre: string;
	type: TypeOeuvre;
	dateDeParution: string | null;
	serie: string | null;
	serieEntityId: string | null;
	numeroDansLaSerie: number | null;
	couvertureUrl: string | null;
}

/**
 * Les œuvres du catalogue dont le titre correspond.
 *
 * La recherche porte sur le titre **de source et corrigé** : un membre qui a
 * corrigé une fiche fausse (R47) doit retrouver l'œuvre sous le titre qu'il a
 * posé, pas sous celui qu'il a justement corrigé. Deux requêtes plutôt qu'une
 * jointure, parce qu'une correction est rare et que la jointure la ferait payer à
 * toutes les recherches.
 */
export async function chercherOeuvresLocales(
	db: Db,
	requete: string,
	limite = RESULTATS_MAX
): Promise<OeuvreLocaleTrouvee[]> {
	const propre = requete.trim();
	if (propre === '') return [];

	const motif = `%${echapperLike(propre)}%`;

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
	return lireOeuvresLocales(db, ids);
}

/** Les œuvres du catalogue rattachées à une entité, pour la moitié locale d'un parcours. */
async function oeuvresLocalesDeLaFacette(
	db: Db,
	axe: AxeDeParcours,
	reference: ReferenceSource,
	limite: number
): Promise<OeuvreLocaleTrouvee[]> {
	const typeDEntite = {
		personnage: 'personnage',
		serie: 'serie',
		createur: 'createur',
		event: 'event'
	} as const;

	const entite = await db.query.entitySources.findFirst({
		where: and(
			eq(entitySources.source, reference.source),
			eq(entitySources.entityType, typeDEntite[axe]),
			eq(entitySources.externalId, reference.idExterne)
		)
	});
	if (!entite) return [];

	const lignes = await (axe === 'personnage'
		? db
				.selectDistinct({ id: workCharacters.workId })
				.from(workCharacters)
				.where(eq(workCharacters.entityId, entite.entityId))
				.limit(limite)
		: axe === 'createur'
			? db
					.selectDistinct({ id: workCreators.workId })
					.from(workCreators)
					.where(eq(workCreators.entityId, entite.entityId))
					.limit(limite)
			: db
					.select({ id: works.id })
					.from(works)
					.where(
						axe === 'serie'
							? eq(works.seriesEntityId, entite.entityId)
							: eq(works.eventEntityId, entite.entityId)
					)
					.limit(limite));

	return lireOeuvresLocales(
		db,
		lignes.map((ligne) => ligne.id)
	);
}

/** Charge les colonnes d'affichage d'un lot d'œuvres, titres corrigés compris. */
async function lireOeuvresLocales(db: Db, ids: string[]): Promise<OeuvreLocaleTrouvee[]> {
	if (ids.length === 0) return [];

	const [lignes, titres] = await Promise.all([
		db
			.select({
				id: works.id,
				type: works.type,
				date: works.releaseDate,
				numero: works.numberInSeries,
				couverture: works.coverUrl,
				serieEntityId: works.seriesEntityId,
				serie: entities.name
			})
			.from(works)
			.leftJoin(entities, eq(entities.id, works.seriesEntityId))
			.where(inArray(works.id, ids)),
		titresCorriges(db, ids)
	]);

	return lignes.map((ligne) => ({
		id: ligne.id,
		titre: titres.get(ligne.id) ?? '',
		type: ligne.type,
		dateDeParution: ligne.date,
		serie: ligne.serie,
		serieEntityId: ligne.serieEntityId,
		numeroDansLaSerie: ligne.numero,
		couvertureUrl: ligne.couverture
	}));
}

// ---------------------------------------------------------------------------
// La fusion
// ---------------------------------------------------------------------------

/**
 * Fusionne les descriptions amont et les œuvres locales, sans doublon.
 *
 * Le rapprochement se fait par **identifiant de source**, seule identité sûre :
 * une œuvre locale portant `metron:44467` et le résultat amont `metron:44467`
 * sont la même, et ne produisent qu'une ligne. C'est le même chemin que
 * `reconcile.ts` emprunte en premier, pour la même raison.
 *
 * Quand les deux existent, **le titre local l'emporte**. Il porte les corrections
 * de membre (R47), et R39 veut qu'elles tiennent partout — les afficher sur la
 * page de l'œuvre mais pas dans la recherche qui y mène serait une demi-mesure
 * visible.
 *
 * Les œuvres locales que l'amont n'a pas rendues sont **conservées**, jamais
 * substituées : c'est le sens précis de « le local n'est pas une condition
 * d'arrêt ».
 *
 * **Le plafond de résultats est réparti, pas consommé dans l'ordre**, et ce
 * détail se paie cher si on l'oublie. Metron rend cent numéros pour « Iron Man » ;
 * concaténer les sources puis couper à vingt-cinq ferait disparaître *tous* les
 * films — mesuré contre les vraies API, et invisible autrement, puisque la
 * recherche a l'air de marcher. Chaque source, et le catalogue local, reçoivent
 * donc une part garantie, et ce qui reste est repris par ceux qui en ont encore.
 */
async function fusionner(
	db: Db,
	amont: OeuvreDistante[][],
	locales: OeuvreLocaleTrouvee[],
	limite: number
): Promise<ResultatDeCatalogue[]> {
	const toutes = amont.flat();
	const connues = await oeuvresParReference(
		db,
		toutes.map((oeuvre) => oeuvre.reference)
	);

	const identifiants = new Set<string>([
		...connues.values(),
		...locales.map((locale) => locale.id)
	]);
	const consignees = await oeuvresConsignees(db, [...identifiants]);
	const titresLocaux = new Map(locales.map((locale) => [locale.id, locale]));

	const vues = new Set<string>();

	const parSource = amont.map((liste) => {
		const lignes: ResultatDeCatalogue[] = [];
		for (const oeuvre of liste) {
			const cleReference = `${oeuvre.reference.source}:${oeuvre.reference.idExterne}`;
			if (vues.has(cleReference)) continue;
			vues.add(cleReference);

			const oeuvreId = connues.get(cleReference) ?? null;
			if (oeuvreId !== null) vues.add(oeuvreId);

			const locale = oeuvreId === null ? undefined : titresLocaux.get(oeuvreId);

			lignes.push({
				cle: oeuvreId ?? cleReference,
				oeuvreId,
				reference: oeuvre.reference,
				// Le titre corrigé par un membre l'emporte sur celui de la source.
				titre: locale?.titre ?? oeuvre.titre,
				type: oeuvre.type,
				dateDeParution: oeuvre.dateDeParution ?? null,
				serie: oeuvre.serie?.nom ?? null,
				serieReference: oeuvre.serie?.reference ?? null,
				numeroDansLaSerie: oeuvre.numeroDansLaSerie ?? null,
				couvertureUrl: oeuvre.couvertureUrl ?? null,
				connueDuGroupe: oeuvreId !== null,
				consignee: oeuvreId !== null && consignees.has(oeuvreId)
			});
		}
		return lignes;
	});

	const seulementLocales: ResultatDeCatalogue[] = [];
	for (const locale of locales) {
		if (vues.has(locale.id)) continue;
		vues.add(locale.id);

		seulementLocales.push({
			cle: locale.id,
			oeuvreId: locale.id,
			reference: null,
			titre: locale.titre,
			type: locale.type,
			dateDeParution: locale.dateDeParution,
			serie: locale.serie,
			serieReference: null,
			numeroDansLaSerie: locale.numeroDansLaSerie,
			couvertureUrl: locale.couvertureUrl,
			connueDuGroupe: true,
			consignee: consignees.has(locale.id)
		});
	}

	return repartir([...parSource, seulementLocales], limite);
}

/**
 * Répartit un plafond entre plusieurs listes, sans en laisser aucune de côté.
 *
 * Chacune reçoit d'abord sa part égale, dans son propre ordre ; le reliquat va
 * ensuite à celles qui ont encore de quoi le remplir. Une liste vide ne consomme
 * rien, donc une source muette n'ampute pas les autres. Fonction pure.
 */
export function repartir<T>(listes: T[][], limite: number): T[] {
	const nonVides = listes.filter((liste) => liste.length > 0);
	if (nonVides.length === 0) return [];

	const part = Math.max(1, Math.ceil(limite / nonVides.length));
	const retenus = nonVides.map((liste) => liste.slice(0, part));
	let total = retenus.reduce((somme, liste) => somme + liste.length, 0);

	// Le reliquat : ce que les listes courtes n'ont pas pris revient aux longues.
	for (const [rang, liste] of nonVides.entries()) {
		while (total < limite && retenus[rang].length < liste.length) {
			retenus[rang].push(liste[retenus[rang].length]);
			total++;
		}
	}

	return retenus.flat().slice(0, limite);
}

/** Les œuvres locales portant ces références de source, par clé `source:id`. */
export async function oeuvresParReference(
	db: Db,
	references: ReferenceSource[]
): Promise<Map<string, string>> {
	if (references.length === 0) return new Map();

	const identifiants = [...new Set(references.map((reference) => reference.idExterne))];
	const lignes = await db
		.select({ source: workSources.source, id: workSources.externalId, oeuvre: workSources.workId })
		.from(workSources)
		.where(inArray(workSources.externalId, identifiants));

	const sources = new Set(
		references.map((reference) => `${reference.source}:${reference.idExterne}`)
	);
	const par = new Map<string, string>();
	for (const ligne of lignes) {
		const cle = `${ligne.source}:${ligne.id}`;
		if (sources.has(cle)) par.set(cle, ligne.oeuvre);
	}
	return par;
}

/**
 * La référence de source de chaque entité locale, pour rendre une facette
 * parcourable depuis la fiche d'une œuvre.
 *
 * Une entité peut être décrite par plusieurs sources ; la première suffit ici,
 * puisque le parcours n'interroge de toute façon que la source qui porte la
 * référence. Une entité sans source — créée par une correction de membre — n'a
 * rien à parcourir en amont, et son absence de la carte le dit.
 */
export async function referencesDEntites(
	db: Db,
	entityIds: string[]
): Promise<Map<string, ReferenceSource>> {
	const uniques = [...new Set(entityIds)];
	if (uniques.length === 0) return new Map();

	const lignes = await db
		.select({
			entite: entitySources.entityId,
			source: entitySources.source,
			id: entitySources.externalId
		})
		.from(entitySources)
		.where(inArray(entitySources.entityId, uniques));

	const par = new Map<string, ReferenceSource>();
	for (const ligne of lignes) {
		if (!par.has(ligne.entite))
			par.set(ligne.entite, { source: ligne.source, idExterne: ligne.id });
	}
	return par;
}

/** Celles que quelqu'un du groupe a consignées. */
async function oeuvresConsignees(db: Db, ids: string[]): Promise<Set<string>> {
	if (ids.length === 0) return new Set();
	const lignes = await db
		.selectDistinct({ oeuvre: journalEntries.workId })
		.from(journalEntries)
		.where(inArray(journalEntries.workId, ids));
	return new Set(lignes.map((ligne) => ligne.oeuvre));
}

/**
 * Échappe les caractères que `LIKE` interprète.
 *
 * Sans ça, une recherche contenant `%` rendrait tout le catalogue et un `_`
 * rendrait n'importe quoi — ce n'est pas une faille, les titres viennent du
 * catalogue et pas d'un texte exécuté, mais c'est un résultat faux.
 */
export function echapperLike(valeur: string): string {
	return valeur.replace(/[\\%_]/g, (caractere) => `\\${caractere}`);
}
