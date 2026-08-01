import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import {
	journalEntries,
	members,
	orderEntries,
	orders,
	workCharacters,
	workCorrections,
	works,
	TYPES_DE_RELATION,
	type TypeDeRelation
} from '../db/schema';
import type { Db } from '../db';
import type { TypeOeuvre } from '../catalog/sources/types';
import { analyserCorrection, titresCorriges, type Correction } from '../catalog/corrections';
import { estAtteinte } from '../journal/atteinte';
import { grapheDuMembre, type AreteDuGraphe } from './materialize';
import {
	DIMENSIONS,
	SEUIL_FILTRAGE_CLIENT,
	mesurerVolume,
	projeter,
	restreindre,
	type Dimension,
	type GrapheRendu,
	type RefusDeDimension
} from '$lib/graph/rendu';

/**
 * La lecture du graphe pour le rendu (U10), et la navigation depuis un nœud (R53).
 *
 * **Une seule lecture indexée, et aucun parcours.** Le graphe visible d'un membre
 * est déjà en base, matérialisé à l'écriture par U9 : ce module le lit par
 * `grapheDuMembre` — un `where member_id = ?` sur un index — puis travaille en
 * mémoire. C'est ce que les 10 ms de temps processeur d'une requête Cloudflare
 * imposent (KTD2), et c'est aussi ce qui rend R52 tenable : rien ici ne recalcule
 * d'arête, donc rien ici ne peut joindre deux nœuds déjà visibles par une œuvre
 * que le membre n'a pas atteinte.
 *
 * **Le graphe est celui de la session, jamais celui d'un identifiant reçu.**
 * Aucune fonction de ce module ne prend un membre depuis une URL ou un
 * formulaire : la route passe `locals.member.id`, et l'ouverture d'un nœud
 * travaille sur les arêtes déjà lues pour ce membre-là. Il n'y a donc pas de
 * paramètre à forger pour obtenir le graphe d'un autre — la question ne se pose
 * pas plus que pour les gestes de suivi de U7.
 */

// ---------------------------------------------------------------------------
// L'accord des deux listes de dimensions
// ---------------------------------------------------------------------------

/**
 * `DIMENSIONS` est partagée avec le navigateur et ne peut pas importer le
 * schéma ; `TYPES_DE_RELATION` vient du schéma et ne peut pas partir au
 * navigateur. Ces deux affectations sont l'accord entre elles, vérifié à la
 * compilation dans les deux sens — une valeur ajoutée d'un côté sans l'autre ne
 * passe pas `svelte-check`. Un test compare aussi leur contenu, pour le cas où
 * les deux listes auraient la même longueur et pas les mêmes membres.
 */
export const ACCORD_DES_DIMENSIONS: readonly Dimension[] = TYPES_DE_RELATION;
export const ACCORD_DES_RELATIONS: readonly TypeDeRelation[] = DIMENSIONS;

// ---------------------------------------------------------------------------
// Bornes
// ---------------------------------------------------------------------------

/** Combien d'ordres couvrants un nœud affiche. Au-delà, ce n'est plus une orientation. */
export const MAX_ORDRES_COUVRANTS = 10;

/** Combien d'apparitions non atteintes un nœud propose (troisième volet de R53). */
export const MAX_APPARITIONS = 20;

/**
 * Combien de candidates le catalogue rend avant filtrage.
 *
 * Un personnage populaire compte des milliers d'apparitions ; les ramener toutes
 * pour n'en garder que vingt coûterait la requête la plus chère de la page.
 */
const PLAFOND_CANDIDATES = 200;

// ---------------------------------------------------------------------------
// Ce que la page reçoit
// ---------------------------------------------------------------------------

export interface OeuvreEtablissante {
	id: string;
	titre: string;
	type: TypeOeuvre;
	dateDeParution: string | null;
}

/** R53 — un ordre du groupe qui couvre les œuvres de ce nœud. */
export interface OrdreCouvrant {
	id: string;
	titre: string;
	/** `null` quand l'auteur a quitté le groupe (R38). L'ordre, lui, reste. */
	auteur: string | null;
	/** Combien d'œuvres de ce nœud il couvre. */
	couvertes: number;
	nombreDEntrees: number;
}

/** Le troisième volet : une apparition que le membre n'a pas encore atteinte. */
export interface Apparition {
	id: string;
	titre: string;
	type: TypeOeuvre;
	dateDeParution: string | null;
	/** Déjà sur une étagère, mais pas atteinte — « à découvrir » ou « en cours ». */
	consignee: boolean;
}

export interface NoeudOuvert {
	id: string;
	nom: string;
	dimension: Dimension;
	/** R53, premier volet — les œuvres atteintes qui l'ont établi. Jamais vide. */
	oeuvres: OeuvreEtablissante[];
	/** R53, deuxième volet — les ordres du groupe qui les couvrent. */
	ordres: OrdreCouvrant[];
	/** Troisième volet — ce qui reste à lire. Sans lui le graphe n'est qu'un rétroviseur. */
	apparitions: Apparition[];
	/** D'autres apparitions existent au catalogue mais ne sont pas montrées. */
	apparitionsTronquees: boolean;
}

export interface VueDuGraphe {
	/** Les dimensions effectivement appliquées (R49). */
	dimensions: Dimension[];
	refus: RefusDeDimension | null;
	/**
	 * Ce que la charge utile porte. Filtré ou non selon le volume — la surface
	 * applique `filtrer` de toute façon, et le filtre est idempotent.
	 */
	graphe: GrapheRendu;
	/**
	 * Le filtrage tient-il dans le navigateur ? Vrai : cocher une case ne coûte
	 * aucun aller-retour. Faux : le graphe complet est trop lourd à envoyer, la
	 * surface repasse par le serveur à chaque changement.
	 */
	filtrageClient: boolean;
	/** Le volume du graphe complet, toutes dimensions confondues. */
	volume: { noeuds: number; appuis: number; aretesEstimees: number };
	/** Le nœud ouvert (R53), quand la surface en demande un et qu'il est dans le graphe. */
	noeud: NoeudOuvert | null;
	/** L'ordre proposé à qui n'a encore rien lu. Pour l'état d'accueil, et lui seul. */
	suggestion: { id: string; titre: string } | null;
}

// ---------------------------------------------------------------------------
// La lecture
// ---------------------------------------------------------------------------

/**
 * Le graphe d'un membre, prêt à rendre.
 *
 * **Le point de bascule du filtrage est décidé ici**, sur un majorant calculé en
 * un passage linéaire (`mesurerVolume`) plutôt qu'en projetant pour voir. En
 * dessous du seuil, tout part au navigateur et le filtrage y est instantané.
 * Au-dessus, les appuis sont restreints aux dimensions actives **avant** la
 * projection — la partie quadratique — et la charge utile fond d'autant.
 *
 * Les deux chemins donnent le même graphe affiché, et ce n'est pas une
 * coïncidence à surveiller : filtrer les appuis puis projeter, ou projeter puis
 * filtrer les nœuds, produisent le même ensemble, puisqu'une adjacence n'existe
 * que si ses deux extrémités sont créditées par la même œuvre. Un test le
 * vérifie plutôt que de le supposer.
 */
export async function ouvrirGraphe(
	db: Db,
	membreId: string,
	options: {
		dimensions: readonly Dimension[];
		refus?: RefusDeDimension | null;
		noeud?: string | null;
	}
): Promise<VueDuGraphe> {
	// La seule lecture du graphe, et elle est indexée sur `member_id`.
	const appuis: AreteDuGraphe[] = await grapheDuMembre(db, membreId);

	const volume = mesurerVolume(appuis);
	const filtrageClient = volume.aretesEstimees <= SEUIL_FILTRAGE_CLIENT;
	const graphe = filtrageClient
		? projeter(appuis)
		: projeter(restreindre(appuis, options.dimensions));

	const [noeud, suggestion] = await Promise.all([
		options.noeud ? ouvrirNoeud(db, membreId, options.noeud, appuis) : Promise.resolve(null),
		volume.noeuds === 0 ? ordreAProposer(db) : Promise.resolve(null)
	]);

	return {
		dimensions: [...options.dimensions],
		refus: options.refus ?? null,
		graphe,
		filtrageClient,
		volume,
		noeud,
		suggestion
	};
}

/**
 * L'état d'accueil de F7 a besoin d'un renvoi concret, pas d'un lien vers une
 * liste : « suis celui-là » oriente là où « va voir les ordres » ne fait que
 * déplacer la question. Le plus récemment touché est le plus vivant.
 */
async function ordreAProposer(db: Db): Promise<{ id: string; titre: string } | null> {
	const [ligne] = await db
		.select({ id: orders.id, titre: orders.title })
		.from(orders)
		.orderBy(desc(orders.updatedAt))
		.limit(1);
	return ligne ?? null;
}

// ---------------------------------------------------------------------------
// R53 — l'ouverture d'un nœud
// ---------------------------------------------------------------------------

/**
 * Ce qu'un nœud ouvre : les œuvres atteintes qui l'ont établi, les ordres du
 * groupe qui les couvrent, et les apparitions que le membre n'a pas atteintes.
 *
 * **Le nœud est cherché dans les arêtes déjà lues pour ce membre**, et c'est ce
 * qui rend R51 structurel plutôt que vérifié : un nœud absent du graphe du membre
 * n'ouvre rien, donc aucun identifiant d'entité forgé dans l'URL ne peut rendre
 * la liste des œuvres qui l'établissent chez quelqu'un d'autre. Il n'y a pas de
 * contrôle à ne pas oublier, il n'y a rien à contrôler.
 *
 * **Le troisième volet est le seul à sortir du graphe, et c'est délibéré.** Les
 * deux premiers ne montrent que des œuvres atteintes et des ordres visibles par
 * tout le groupe (R17). Le troisième dit « ce personnage apparaît aussi là », ce
 * que la page de l'œuvre et le parcours par facette de R46 disent déjà, et sans
 * lui le graphe serait une rétrospective de ce qu'on a lu — alors que le critère
 * de réussite attend qu'un membre y trouve une œuvre qu'il n'aurait pas trouvée
 * par la recherche. Il ne crée **aucune arête** : il ne modifie pas le graphe,
 * il l'ouvre sur le catalogue.
 */
export async function ouvrirNoeud(
	db: Db,
	membreId: string,
	entiteId: string,
	appuis: readonly AreteDuGraphe[]
): Promise<NoeudOuvert | null> {
	const arete = appuis.find((ligne) => ligne.entiteId === entiteId);
	if (!arete) return null;

	const [oeuvres, ordres, apparitions] = await Promise.all([
		lireOeuvres(db, arete.appuis),
		ordresCouvrants(db, arete.appuis),
		apparitionsNonAtteintes(db, membreId, entiteId, arete.relation, arete.appuis)
	]);

	return {
		id: entiteId,
		nom: arete.nom,
		dimension: arete.relation,
		oeuvres,
		ordres,
		...apparitions
	};
}

/** Les œuvres d'un lot, titres corrigés (R39, R47) et triées par parution. */
async function lireOeuvres(db: Db, oeuvreIds: readonly string[]): Promise<OeuvreEtablissante[]> {
	const ids = [...new Set(oeuvreIds)];
	if (ids.length === 0) return [];

	const [lignes, titres] = await Promise.all([
		db
			.select({ id: works.id, type: works.type, date: works.releaseDate })
			.from(works)
			.where(inArray(works.id, ids)),
		titresCorriges(db, ids)
	]);

	return lignes
		.map((ligne) => ({
			id: ligne.id,
			titre: titres.get(ligne.id) ?? '',
			type: ligne.type,
			dateDeParution: ligne.date
		}))
		.sort(parDatePuisTitre);
}

function parDatePuisTitre(
	a: { dateDeParution: string | null; titre: string },
	b: { dateDeParution: string | null; titre: string }
): number {
	// Les œuvres sans date passent après : une date inconnue n'est pas une date
	// ancienne, et les faire ouvrir la liste ferait croire le contraire.
	const gauche = a.dateDeParution ?? '￿';
	const droite = b.dateDeParution ?? '￿';
	return gauche.localeCompare(droite) || a.titre.localeCompare(b.titre);
}

/**
 * R53 — les ordres du groupe qui couvrent les œuvres de ce nœud.
 *
 * Trois requêtes pour l'ensemble, quel que soit le nombre d'ordres : les entrées
 * qui touchent ces œuvres, les ordres et leurs auteurs, puis les tailles. Le
 * classement met en tête celui qui couvre le plus — c'est celui qui a le plus de
 * chances d'être le bon chemin d'entrée, et F6 se termine exactement là.
 *
 * Aucun filtre sur l'auteur ni sur le suivi : R17 rend les ordres visibles par
 * tout le groupe, et ceux qu'on ne suit pas encore sont précisément ceux qu'on
 * vient découvrir.
 */
async function ordresCouvrants(db: Db, oeuvreIds: readonly string[]): Promise<OrdreCouvrant[]> {
	const ids = [...new Set(oeuvreIds)];
	if (ids.length === 0) return [];

	const entrees = await db
		.select({ ordreId: orderEntries.orderId, oeuvreId: orderEntries.workId })
		.from(orderEntries)
		.where(inArray(orderEntries.workId, ids));
	if (entrees.length === 0) return [];

	const couvertes = new Map<string, Set<string>>();
	for (const entree of entrees) {
		const jeu = couvertes.get(entree.ordreId) ?? new Set<string>();
		jeu.add(entree.oeuvreId);
		couvertes.set(entree.ordreId, jeu);
	}
	const ordreIds = [...couvertes.keys()];

	const [lus, tailles] = await Promise.all([
		db
			.select({
				id: orders.id,
				titre: orders.title,
				nom: members.displayName,
				parti: members.leftAt
			})
			.from(orders)
			.innerJoin(members, eq(members.id, orders.authorId))
			.where(inArray(orders.id, ordreIds)),
		db
			.select({ ordreId: orderEntries.orderId, n: count() })
			.from(orderEntries)
			.where(inArray(orderEntries.orderId, ordreIds))
			.groupBy(orderEntries.orderId)
	]);

	const parTaille = new Map(tailles.map((ligne) => [ligne.ordreId, ligne.n]));

	return lus
		.map((ordre) => ({
			id: ordre.id,
			titre: ordre.titre,
			// R38 — le nom d'un membre parti n'est pas remplacé au rendu : il n'entre
			// pas dans la charge utile.
			auteur: ordre.parti === null ? ordre.nom : null,
			couvertes: couvertes.get(ordre.id)?.size ?? 0,
			nombreDEntrees: parTaille.get(ordre.id) ?? 0
		}))
		.sort((a, b) => b.couvertes - a.couvertes || a.titre.localeCompare(b.titre))
		.slice(0, MAX_ORDRES_COUVRANTS);
}

/**
 * Le troisième volet : ce que ce nœud recouvre et que le membre n'a pas atteint.
 *
 * **La limite, plutôt que son contournement.** Le parcours amont — demander à
 * Comic Vine ou Metron toutes les apparitions d'un personnage — appartient à
 * U3b, bloquée sur des clés d'API. Ce volet lit donc le **catalogue local** : ce
 * qui a déjà été ingéré, et rien d'autre. Concrètement, un personnage dont le
 * groupe n'a lu qu'un pan de la carrière ne propose que ce pan-là. C'est une
 * borne connue, pas un défaut : elle disparaîtra le jour où les adaptateurs
 * existeront, sans que rien d'ici ne bouge.
 *
 * Les corrections de membre sont appliquées (R47, R39) : un personnage ajouté à
 * une fiche apparaît dans ses apparitions, un personnage retiré en sort. Sans
 * ça, ce volet contredirait le graphe lui-même, qui est dérivé de l'œuvre
 * corrigée.
 */
async function apparitionsNonAtteintes(
	db: Db,
	membreId: string,
	entiteId: string,
	dimension: Dimension,
	deja: readonly string[]
): Promise<{ apparitions: Apparition[]; apparitionsTronquees: boolean }> {
	const candidates = await candidatesDuCatalogue(db, entiteId, dimension);

	const { ajoutees, retirees } = await correctionsSurEntite(db, entiteId, dimension);
	// `null` marque une œuvre qu'une correction rattache alors que le catalogue ne
	// l'avait pas rendue : il faudra la lire, une fois, en fin de tri.
	const retenues = new Map<string, CandidateDuCatalogue | null>(
		candidates.map((oeuvre) => [oeuvre.id, oeuvre])
	);
	for (const id of retirees) retenues.delete(id);
	for (const id of ajoutees) if (!retenues.has(id)) retenues.set(id, null);

	// Les œuvres qui portent déjà le nœud sont atteintes par définition : les
	// écarter d'abord évite de les relire.
	for (const id of deja) retenues.delete(id);
	if (retenues.size === 0) return { apparitions: [], apparitionsTronquees: false };

	const manquantes = [...retenues.entries()]
		.filter(([, oeuvre]) => oeuvre === null)
		.map(([id]) => id);
	if (manquantes.length > 0) {
		for (const ligne of await db
			.select({ id: works.id, type: works.type, date: works.releaseDate })
			.from(works)
			.where(inArray(works.id, manquantes))) {
			retenues.set(ligne.id, ligne);
		}
	}

	const ids = [...retenues.keys()];
	const entrees = await db.query.journalEntries.findMany({
		where: and(eq(journalEntries.memberId, membreId), inArray(journalEntries.workId, ids))
	});

	const consignees = new Set<string>();
	for (const entree of entrees) {
		if (estAtteinte({ etagere: entree.shelf, abandonnee: entree.abandonedAt !== null })) {
			retenues.delete(entree.workId);
		} else {
			consignees.add(entree.workId);
		}
	}

	const restantes = [...retenues.values()].filter(
		(oeuvre): oeuvre is CandidateDuCatalogue => oeuvre !== null
	);
	const titres = await titresCorriges(
		db,
		restantes.map((oeuvre) => oeuvre.id)
	);

	const apparitions = restantes
		.map((oeuvre) => ({
			id: oeuvre.id,
			titre: titres.get(oeuvre.id) ?? '',
			type: oeuvre.type,
			dateDeParution: oeuvre.date,
			consignee: consignees.has(oeuvre.id)
		}))
		.sort(parDatePuisTitre);

	return {
		apparitions: apparitions.slice(0, MAX_APPARITIONS),
		apparitionsTronquees: apparitions.length > MAX_APPARITIONS
	};
}

interface CandidateDuCatalogue {
	id: string;
	type: TypeOeuvre;
	date: string | null;
}

/** Les œuvres que le catalogue rattache à cette entité, dans sa couche de source. */
async function candidatesDuCatalogue(
	db: Db,
	entiteId: string,
	dimension: Dimension
): Promise<CandidateDuCatalogue[]> {
	const colonnes = { id: works.id, type: works.type, date: works.releaseDate };

	if (dimension === 'personnage') {
		return db
			.select(colonnes)
			.from(workCharacters)
			.innerJoin(works, eq(works.id, workCharacters.workId))
			.where(eq(workCharacters.entityId, entiteId))
			.orderBy(asc(works.releaseDate))
			.limit(PLAFOND_CANDIDATES);
	}

	return db
		.select(colonnes)
		.from(works)
		.where(eq(dimension === 'serie' ? works.seriesEntityId : works.eventEntityId, entiteId))
		.orderBy(asc(works.releaseDate))
		.limit(PLAFOND_CANDIDATES);
}

/** Le champ de correction qui porte chaque dimension (voir `CHAMPS_DE_RATTACHEMENT`). */
const CHAMP_DE_DIMENSION: Record<Dimension, 'personnages' | 'serie' | 'event'> = {
	personnage: 'personnages',
	serie: 'serie',
	event: 'event'
};

/**
 * Ce que les corrections de membre changent au rattachement de cette entité.
 *
 * Une seule correction compte par œuvre et par champ, la plus récente : c'est la
 * règle de `appliquerCorrections`, et la réécrire autrement ici ferait diverger
 * ce volet de la fiche qu'il désigne. Le parcours passe par `analyserCorrection`
 * plutôt que par une lecture directe du JSON, pour la même raison — un seul
 * analyseur, celui qui a validé à l'écriture.
 */
async function correctionsSurEntite(
	db: Db,
	entiteId: string,
	dimension: Dimension
): Promise<{ ajoutees: Set<string>; retirees: Set<string> }> {
	const lignes = await db.query.workCorrections.findMany({
		where: eq(workCorrections.field, CHAMP_DE_DIMENSION[dimension]),
		orderBy: [asc(workCorrections.createdAt), asc(workCorrections.id)]
	});

	const derniere = new Map<string, Correction>();
	for (const ligne of lignes) {
		let brut: unknown;
		try {
			brut = JSON.parse(ligne.value);
		} catch {
			continue;
		}
		const analysee = analyserCorrection(brut);
		if (analysee.ok) derniere.set(ligne.workId, analysee.valeur);
	}

	const ajoutees = new Set<string>();
	const retirees = new Set<string>();

	for (const [oeuvreId, correction] of derniere) {
		if (correction.champ === 'personnages') {
			if (correction.ajoutes.includes(entiteId)) ajoutees.add(oeuvreId);
			if (correction.retires.includes(entiteId)) retirees.add(oeuvreId);
		} else if (correction.champ === 'serie' || correction.champ === 'event') {
			// Un rattachement unique se remplace : la correction dit ce qu'il doit
			// être, donc toute valeur autre que cette entité l'en détache.
			if (correction.valeur === entiteId) ajoutees.add(oeuvreId);
			else retirees.add(oeuvreId);
		}
	}

	return { ajoutees, retirees };
}
