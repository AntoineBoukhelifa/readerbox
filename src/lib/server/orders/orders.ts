import { and, asc, count, desc, eq, gt, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';
import {
	entities,
	journalEntries,
	members,
	orderEntries,
	orderFollows,
	orders,
	works,
	type Order
} from '../db/schema';
import type { Db } from '../db';
import type { TypeOeuvre } from '../catalog/sources/types';
import { titresCorriges } from '../catalog/corrections';
import { estAtteinte } from '../journal/atteinte';
import { journaliserOrdreCree, journaliserOrdreSuivi, retracterOrdre } from '../feed/events';
import { calculerProgression, type EntreeDOrdre, type Progression } from './progression';

/**
 * Les ordres : création, suivi, fork, progression.
 *
 * C'est la primitive centrale du produit — « il n'existe pas d'ordre canonique,
 * donc l'ordre est un objet créé par les membres », dit le document d'origine, et
 * c'est aussi ce qui supprime le besoin de curation du catalogue : la curation,
 * ce sont les ordres.
 *
 * **Ce module est le seul à écrire dans `orders`, `order_entries` et
 * `order_follows`.** Trois invariants en dépendent et aucun n'est portable par un
 * appelant :
 *
 * 1. **Les rangs sont contigus de 0 à n-1.** Aucun index unique ne le garantit —
 *    voir le schéma pour la raison — donc c'est ici, et seulement ici, que les
 *    décalages de plage se font.
 * 2. **Seul l'auteur modifie** (R16). La vérification est faite avant toute
 *    écriture, dans `ordreModifiable`, appelée par chaque mutation.
 * 3. **La progression n'est écrite nulle part** (KTD8). Elle se calcule à la
 *    lecture, par `calculerProgression`, à partir des œuvres atteintes du membre.
 *
 * **Les gestes de suivi sont désignés par le couple membre-ordre**, jamais par
 * l'identifiant d'une ligne de suivi : c'est ce qui rend structurellement
 * impossible de modifier le suivi d'un autre par manipulation d'identifiant. Il
 * n'y a pas de paramètre à forger — les surfaces passent `locals.member.id`.
 *
 * **Rien ne lève d'exception pour un refus attendu**, comme en U2, U3a et U4 :
 * un ordre inconnu, un titre vide, une œuvre déjà présente sont des réponses
 * typées.
 */

// ---------------------------------------------------------------------------
// Bornes
// ---------------------------------------------------------------------------

/**
 * Le nombre d'entrées qu'un versement en masse ajoute d'un coup.
 *
 * Le document d'origine parle d'ordres allant jusqu'à trois cents entrées ;
 * « ajouter toute la série X » sur une série de soixante ans en produirait
 * davantage, dans une seule invocation Worker bornée à 10 ms de temps processeur
 * (KTD2). Le versement s'arrête donc là et le dit — l'auteur relance s'il en veut
 * plus, ce qui est un geste conscient plutôt qu'une requête qui échoue.
 */
export const VERSEMENT_MAX = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MotifRefusOrdre =
	| 'ordre introuvable'
	| 'membre introuvable'
	| 'œuvre introuvable'
	| 'entrée introuvable'
	| 'série introuvable'
	| 'titre vide'
	| 'œuvre déjà présente'
	| 'rang invalide'
	/** R16 — un suiveur, ou n'importe qui d'autre, reçoit ce refus. */
	| "seul l'auteur peut modifier"
	/** R38 — l'auteur a quitté le groupe : l'ordre reste, il ne bouge plus. */
	| 'ordre sans auteur';

export type ResultatOrdre = { ok: true; ordreId: string } | { ok: false; motif: MotifRefusOrdre };

export type ResultatEntree =
	{ ok: true; entreeId: string; rang: number } | { ok: false; motif: MotifRefusOrdre };

export type ResultatVersement =
	| { ok: true; ajoutees: number; dejaPresentes: number; tronque: boolean }
	| { ok: false; motif: MotifRefusOrdre };

export type ResultatSimple = { ok: true } | { ok: false; motif: MotifRefusOrdre };

/** L'auteur d'un ordre, tel que les surfaces l'affichent (R38). */
export interface AuteurDOrdre {
	id: string;
	nom: string;
	/** R38 — l'ordre reste en place, marqué comme sans auteur. */
	parti: boolean;
}

export interface EntreeDetaillee extends EntreeDOrdre {
	/** `null` quand l'œuvre a disparu du catalogue. */
	oeuvre: { id: string; titre: string; type: TypeOeuvre } | null;
	/** Pour le lecteur courant, jamais pour tout le monde. */
	atteinte: boolean;
}

export interface ResumeOrdre {
	id: string;
	titre: string;
	description: string;
	auteur: AuteurDOrdre;
	forkDe: { id: string; titre: string } | null;
	nombreDEntrees: number;
	/** R22 — combien de membres du groupe le suivent. */
	nombreDeSuiveurs: number;
	/** Le lecteur courant le suit-il ? */
	suivi: boolean;
	/** R16 — le lecteur courant peut-il le modifier ? */
	modifiable: boolean;
	progression: Progression;
	creeLe: number;
	misAJourLe: number;
}

export interface OrdreDetaille extends ResumeOrdre {
	entrees: EntreeDetaillee[];
}

/** R22 — un suiveur et son avancement. */
export interface SuiveurDOrdre {
	membreId: string;
	nom: string;
	parti: boolean;
	suitDepuis: number;
	progression: Progression;
}

// ---------------------------------------------------------------------------
// Autorisation (R16, R38)
// ---------------------------------------------------------------------------

/**
 * L'ordre désigné, s'il existe et si ce membre a le droit de le modifier.
 *
 * **Le refus est explicite plutôt que déguisé en « introuvable ».** C'est
 * l'inverse du traitement des avis en U4, et la différence est réelle : un avis
 * qui appartient à quelqu'un d'autre est rapporté inexistant parce que lui dire
 * qu'il existe apprendrait déjà quelque chose, alors qu'un ordre est visible par
 * tout le groupe (R17). Cacher son existence à qui le lit sur la page d'à côté
 * ne protégerait rien et rendrait l'interface incompréhensible.
 *
 * Un ordre dont l'auteur a quitté le groupe n'est plus modifiable par personne
 * (R38) : il reste en place, suivable, forkable, et marqué comme sans auteur.
 * La vérification est ici et pas seulement dans les sessions — un membre parti
 * n'a plus de session valide, mais faire dépendre une règle du produit de
 * l'expiration d'un jeton serait la faire dépendre d'autre chose qu'elle-même.
 */
async function ordreModifiable(
	db: Db,
	ordreId: string,
	membreId: string
): Promise<{ ok: true; ordre: Order } | { ok: false; motif: MotifRefusOrdre }> {
	const ordre = await db.query.orders.findFirst({ where: eq(orders.id, ordreId) });
	if (!ordre) return { ok: false, motif: 'ordre introuvable' };
	if (ordre.authorId !== membreId) return { ok: false, motif: "seul l'auteur peut modifier" };

	const auteur = await db.query.members.findFirst({ where: eq(members.id, ordre.authorId) });
	if (!auteur || auteur.leftAt !== null) return { ok: false, motif: 'ordre sans auteur' };

	return { ok: true, ordre };
}

/** Marque l'ordre comme touché. Sert au tri des listes, à rien d'autre. */
async function toucher(db: Db, ordreId: string, now: number): Promise<void> {
	await db.update(orders).set({ updatedAt: now }).where(eq(orders.id, ordreId));
}

// ---------------------------------------------------------------------------
// Création et cycle de vie (R14, R16, R17)
// ---------------------------------------------------------------------------

/** R14 — un membre crée un ordre : un titre, une description, et rien encore dedans. */
export async function creerOrdre(
	db: Db,
	options: { membreId: string; titre: string; description?: string; now?: number }
): Promise<ResultatOrdre> {
	const now = options.now ?? Date.now();
	const titre = options.titre.trim();
	if (titre === '') return { ok: false, motif: 'titre vide' };

	const membre = await db.query.members.findFirst({ where: eq(members.id, options.membreId) });
	if (!membre) return { ok: false, motif: 'membre introuvable' };

	const [ligne] = await db
		.insert(orders)
		.values({
			authorId: options.membreId,
			title: titre,
			description: options.description?.trim() ?? '',
			createdAt: now,
			updatedAt: now
		})
		.returning({ id: orders.id });

	// R41 — un ordre créé est un événement du fil, et c'est le plus rare des sept :
	// écrire un ordre est le geste coûteux qu'une personne fait pour tout le groupe.
	await journaliserOrdreCree(db, { membreId: options.membreId, ordreId: ligne.id, now });

	return { ok: true, ordreId: ligne.id };
}

/** R16 — l'auteur modifie le titre et la description de son ordre. */
export async function modifierOrdre(
	db: Db,
	options: {
		membreId: string;
		ordreId: string;
		titre?: string;
		description?: string;
		now?: number;
	}
): Promise<ResultatSimple> {
	const now = options.now ?? Date.now();
	const autorise = await ordreModifiable(db, options.ordreId, options.membreId);
	if (!autorise.ok) return autorise;

	const titre = options.titre?.trim();
	if (titre !== undefined && titre === '') return { ok: false, motif: 'titre vide' };

	await db
		.update(orders)
		.set({
			...(titre !== undefined ? { title: titre } : {}),
			...(options.description !== undefined ? { description: options.description.trim() } : {}),
			updatedAt: now
		})
		.where(eq(orders.id, options.ordreId));

	return { ok: true };
}

/**
 * Supprime un ordre, ses entrées et ses suivis.
 *
 * **Les forks survivent** et perdent seulement leur référence à l'original.
 * R17 fait du fork un objet à part entière, modifiable sans altérer celui dont
 * il est parti ; le faire disparaître avec son original inverserait exactement
 * la propriété. La référence, elle, ne peut pas rester : elle désignerait un
 * ordre qui n'existe plus.
 *
 * Les consignations dont la provenance était cet ordre (R42) ne sont pas
 * touchées : la provenance est un fait constaté au moment de la consignation, et
 * le fait que l'ordre ait depuis disparu ne le rend pas faux.
 */
export async function supprimerOrdre(
	db: Db,
	options: { membreId: string; ordreId: string }
): Promise<ResultatSimple> {
	const autorise = await ordreModifiable(db, options.ordreId, options.membreId);
	if (!autorise.ok) return autorise;

	await db
		.update(orders)
		.set({ forkedFromId: null })
		.where(eq(orders.forkedFromId, options.ordreId));
	await db.delete(orderFollows).where(eq(orderFollows.orderId, options.ordreId));
	await db.delete(orderEntries).where(eq(orderEntries.orderId, options.ordreId));
	await db.delete(orders).where(eq(orders.id, options.ordreId));
	// Les événements du fil qui le désignaient ne mènent plus nulle part : « X a
	// suivi un ordre supprimé » n'apprend rien et ne se clique pas.
	await retracterOrdre(db, options.ordreId);

	return { ok: true };
}

/**
 * R17 — un membre part de l'ordre d'un autre et le modifie sans altérer
 * l'original.
 *
 * Les entrées sont **copiées**, avec de nouvelles identités : c'est ce qui rend
 * l'indépendance structurelle plutôt que déclarative. Un fork qui partagerait
 * les lignes de son original serait un alias, et la première insertion dans le
 * fork apparaîtrait chez tout le monde.
 *
 * Le rang, le caractère facultatif et l'ordre de la séquence sont conservés :
 * on part de l'ordre de quelqu'un pour le réarranger, pas pour le redécouvrir.
 * Forker un fork est permis et ne demande aucun traitement particulier — la
 * référence pointe vers l'ordre dont on est effectivement parti, pas vers une
 * racine qu'il faudrait remonter.
 */
export async function forker(
	db: Db,
	options: { membreId: string; ordreId: string; titre?: string; now?: number }
): Promise<ResultatOrdre> {
	const now = options.now ?? Date.now();

	const original = await db.query.orders.findFirst({ where: eq(orders.id, options.ordreId) });
	if (!original) return { ok: false, motif: 'ordre introuvable' };

	const membre = await db.query.members.findFirst({ where: eq(members.id, options.membreId) });
	if (!membre) return { ok: false, motif: 'membre introuvable' };

	const titre = options.titre?.trim() || `${original.title} (variante)`;

	const [copie] = await db
		.insert(orders)
		.values({
			authorId: options.membreId,
			title: titre,
			description: original.description,
			forkedFromId: original.id,
			createdAt: now,
			updatedAt: now
		})
		.returning({ id: orders.id });

	const entrees = await db.query.orderEntries.findMany({
		where: eq(orderEntries.orderId, original.id),
		orderBy: [asc(orderEntries.rank)]
	});

	if (entrees.length > 0) {
		await db.insert(orderEntries).values(
			entrees.map((entree, index) => ({
				orderId: copie.id,
				workId: entree.workId,
				rank: index,
				optional: entree.optional,
				createdAt: now
			}))
		);
	}

	// R41 — un fork est un ordre créé. R17 en fait un objet à part entière ; le
	// fil le dit comme tel plutôt que d'inventer un huitième type d'événement.
	await journaliserOrdreCree(db, { membreId: options.membreId, ordreId: copie.id, now });

	return { ok: true, ordreId: copie.id };
}

// ---------------------------------------------------------------------------
// Entrées (R14, R15, R16, R18)
// ---------------------------------------------------------------------------

/** Le nombre d'entrées d'un ordre, qui est aussi le rang du prochain ajout. */
async function nombreDEntrees(db: Db, ordreId: string): Promise<number> {
	const [ligne] = await db
		.select({ n: count() })
		.from(orderEntries)
		.where(eq(orderEntries.orderId, ordreId));
	return ligne.n;
}

/**
 * Verse une œuvre dans un ordre, à la fin par défaut ou au rang demandé.
 *
 * **L'œuvre n'a pas à être consignée par qui que ce soit.** C'est tout le sens
 * de KTD1 appliqué ici : le catalogue conserve les œuvres qu'il connaît sans
 * qu'aucun membre ne les ait posées sur une étagère, et un ordre se bâtit sur
 * des numéros que personne du groupe n'a encore lus — c'est même le cas normal,
 * puisqu'un ordre existe pour orienter ceux qui n'ont pas lu.
 *
 * L'insertion à un rang décale les suivantes d'une mise à jour de plage, à coût
 * constant. Elle ne retire **rien** de l'ensemble atteint d'un suiveur (AE6) :
 * les entrées existantes gardent leur identité (R15) et leur œuvre ; seul leur
 * rang bouge, et le rang n'entre dans aucun calcul d'avancement.
 */
export async function ajouterEntree(
	db: Db,
	options: {
		membreId: string;
		ordreId: string;
		oeuvreId: string;
		facultative?: boolean;
		/** Par défaut : à la fin. */
		rang?: number;
		now?: number;
	}
): Promise<ResultatEntree> {
	const now = options.now ?? Date.now();
	const autorise = await ordreModifiable(db, options.ordreId, options.membreId);
	if (!autorise.ok) return autorise;

	const oeuvre = await db.query.works.findFirst({ where: eq(works.id, options.oeuvreId) });
	if (!oeuvre) return { ok: false, motif: 'œuvre introuvable' };

	const deja = await db.query.orderEntries.findFirst({
		where: and(eq(orderEntries.orderId, options.ordreId), eq(orderEntries.workId, options.oeuvreId))
	});
	if (deja) return { ok: false, motif: 'œuvre déjà présente' };

	const total = await nombreDEntrees(db, options.ordreId);
	const rang = options.rang ?? total;
	if (!Number.isInteger(rang) || rang < 0 || rang > total) {
		return { ok: false, motif: 'rang invalide' };
	}

	if (rang < total) {
		await db
			.update(orderEntries)
			.set({ rank: sql`${orderEntries.rank} + 1` })
			.where(and(eq(orderEntries.orderId, options.ordreId), gte(orderEntries.rank, rang)));
	}

	const [ligne] = await db
		.insert(orderEntries)
		.values({
			orderId: options.ordreId,
			workId: options.oeuvreId,
			rank: rang,
			optional: options.facultative ?? false,
			createdAt: now
		})
		.returning({ id: orderEntries.id });

	await toucher(db, options.ordreId, now);
	return { ok: true, entreeId: ligne.id, rang };
}

/**
 * Verse une série entière, dans l'ordre de parution.
 *
 * Le second mode de versement de F2, et celui sans lequel l'éditeur serait
 * inutilisable : un ordre de trois cents entrées ne se construit pas une œuvre à
 * la fois. L'œuvre de type `serie` elle-même est exclue — on verse ses numéros,
 * pas la série prise comme un tout, qui est une autre consignation.
 *
 * L'ordre de parution est celui du numéro dans la série, puis de la date, puis
 * du titre. Les numéros sans rang connu passent après ceux qui en ont un : les
 * intercaler à zéro les ferait ouvrir la séquence, ce qui est le pire endroit
 * pour une œuvre dont on ne sait pas où elle va.
 *
 * Les œuvres déjà présentes sont ignorées sans erreur : verser deux fois la même
 * série est un geste banal quand elle s'est allongée entre-temps.
 */
export async function ajouterSerie(
	db: Db,
	options: {
		membreId: string;
		ordreId: string;
		serieEntityId: string;
		facultative?: boolean;
		now?: number;
	}
): Promise<ResultatVersement> {
	const now = options.now ?? Date.now();
	const autorise = await ordreModifiable(db, options.ordreId, options.membreId);
	if (!autorise.ok) return autorise;

	const serie = await db.query.entities.findFirst({
		where: and(eq(entities.id, options.serieEntityId), eq(entities.type, 'serie'))
	});
	if (!serie) return { ok: false, motif: 'série introuvable' };

	const [candidates, presentes, total] = await Promise.all([
		db
			.select({
				id: works.id,
				numero: works.numberInSeries,
				date: works.releaseDate,
				titre: works.title
			})
			.from(works)
			.where(and(eq(works.seriesEntityId, options.serieEntityId), ne(works.type, 'serie'))),
		db
			.select({ oeuvre: orderEntries.workId })
			.from(orderEntries)
			.where(eq(orderEntries.orderId, options.ordreId)),
		nombreDEntrees(db, options.ordreId)
	]);

	const dejaLa = new Set(presentes.map((ligne) => ligne.oeuvre));
	const aVerser = candidates
		.filter((oeuvre) => !dejaLa.has(oeuvre.id))
		.sort(
			(a, b) =>
				rangDeParution(a.numero) - rangDeParution(b.numero) ||
				(a.date ?? '').localeCompare(b.date ?? '') ||
				a.titre.localeCompare(b.titre)
		);

	const retenues = aVerser.slice(0, VERSEMENT_MAX);
	if (retenues.length > 0) {
		await db.insert(orderEntries).values(
			retenues.map((oeuvre, index) => ({
				orderId: options.ordreId,
				workId: oeuvre.id,
				rank: total + index,
				optional: options.facultative ?? false,
				createdAt: now
			}))
		);
		await toucher(db, options.ordreId, now);
	}

	return {
		ok: true,
		ajoutees: retenues.length,
		dejaPresentes: candidates.length - aVerser.length,
		tronque: aVerser.length > retenues.length
	};
}

/** Les numéros sans rang connu ferment la séquence au lieu de l'ouvrir. */
function rangDeParution(numero: number | null): number {
	return numero ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Retire une entrée, et referme les rangs derrière elle.
 *
 * Retirer une entrée qu'un suiveur avait atteinte **ajuste son pourcentage sans
 * erreur** : le numérateur et le dénominateur perdent la même unité, ce qui est
 * arithmétiquement sans piège précisément parce que rien n'est stocké. Un
 * compteur de progression aurait fallu le décrémenter chez chaque suiveur, et un
 * suiveur oublié aurait porté un pourcentage supérieur à 100.
 */
export async function retirerEntree(
	db: Db,
	options: { membreId: string; ordreId: string; entreeId: string; now?: number }
): Promise<ResultatSimple> {
	const now = options.now ?? Date.now();
	const autorise = await ordreModifiable(db, options.ordreId, options.membreId);
	if (!autorise.ok) return autorise;

	const entree = await db.query.orderEntries.findFirst({
		where: and(eq(orderEntries.id, options.entreeId), eq(orderEntries.orderId, options.ordreId))
	});
	if (!entree) return { ok: false, motif: 'entrée introuvable' };

	await db.delete(orderEntries).where(eq(orderEntries.id, entree.id));
	await db
		.update(orderEntries)
		.set({ rank: sql`${orderEntries.rank} - 1` })
		.where(and(eq(orderEntries.orderId, options.ordreId), gt(orderEntries.rank, entree.rank)));

	await toucher(db, options.ordreId, now);
	return { ok: true };
}

/**
 * Déplace une entrée à un nouveau rang.
 *
 * **Réordonner ne change aucun ensemble atteint** — c'est le corollaire précieux
 * de R15, et il n'a pas besoin d'être défendu ici : rien dans le calcul de la
 * progression ne lit le rang, sauf pour désigner l'entrée suivante. Cette
 * fonction ne touche donc littéralement rien de ce qu'un suiveur a acquis.
 *
 * Le décalage se fait par une mise à jour de plage puis une écriture, soit deux
 * instructions quelle que soit la longueur de l'ordre.
 */
export async function deplacerEntree(
	db: Db,
	options: {
		membreId: string;
		ordreId: string;
		entreeId: string;
		nouveauRang: number;
		now?: number;
	}
): Promise<ResultatSimple> {
	const now = options.now ?? Date.now();
	const autorise = await ordreModifiable(db, options.ordreId, options.membreId);
	if (!autorise.ok) return autorise;

	const entree = await db.query.orderEntries.findFirst({
		where: and(eq(orderEntries.id, options.entreeId), eq(orderEntries.orderId, options.ordreId))
	});
	if (!entree) return { ok: false, motif: 'entrée introuvable' };

	const total = await nombreDEntrees(db, options.ordreId);
	const cible = options.nouveauRang;
	if (!Number.isInteger(cible) || cible < 0 || cible >= total) {
		return { ok: false, motif: 'rang invalide' };
	}
	if (cible === entree.rank) return { ok: true };

	if (cible < entree.rank) {
		await db
			.update(orderEntries)
			.set({ rank: sql`${orderEntries.rank} + 1` })
			.where(
				and(
					eq(orderEntries.orderId, options.ordreId),
					gte(orderEntries.rank, cible),
					lt(orderEntries.rank, entree.rank)
				)
			);
	} else {
		await db
			.update(orderEntries)
			.set({ rank: sql`${orderEntries.rank} - 1` })
			.where(
				and(
					eq(orderEntries.orderId, options.ordreId),
					gt(orderEntries.rank, entree.rank),
					lte(orderEntries.rank, cible)
				)
			);
	}

	await db.update(orderEntries).set({ rank: cible }).where(eq(orderEntries.id, entree.id));

	await toucher(db, options.ordreId, now);
	return { ok: true };
}

/**
 * Déplace une entrée d'un rang vers le haut ou vers le bas.
 *
 * Le repli clavier du glisser-déposer, et le seul geste de réordonnancement qui
 * n'exige pas de savoir où l'on va. Le rang courant est relu ici plutôt que
 * reçu de la surface : un rang lu à l'écran puis renvoyé serait périmé dès que
 * l'auteur a déplacé autre chose entre-temps, et le décalage porterait alors sur
 * une entrée voisine.
 *
 * Un décalage qui sortirait de la séquence est **sans effet plutôt qu'en
 * erreur** : la première entrée qu'on essaie de monter n'est pas une faute, et
 * refuser bruyamment ferait clignoter un message pour un bouton que l'interface
 * désactive déjà.
 */
export async function decalerEntree(
	db: Db,
	options: { membreId: string; ordreId: string; entreeId: string; decalage: number; now?: number }
): Promise<ResultatSimple> {
	const autorise = await ordreModifiable(db, options.ordreId, options.membreId);
	if (!autorise.ok) return autorise;

	const entree = await db.query.orderEntries.findFirst({
		where: and(eq(orderEntries.id, options.entreeId), eq(orderEntries.orderId, options.ordreId))
	});
	if (!entree) return { ok: false, motif: 'entrée introuvable' };

	const total = await nombreDEntrees(db, options.ordreId);
	const cible = entree.rank + options.decalage;
	if (cible < 0 || cible >= total) return { ok: true };

	return deplacerEntree(db, {
		membreId: options.membreId,
		ordreId: options.ordreId,
		entreeId: options.entreeId,
		nouveauRang: cible,
		now: options.now
	});
}

/**
 * R18 — l'auteur marque une entrée comme facultative, ou la remet essentielle.
 *
 * La bascule est le seul geste de l'éditeur qui déplace le dénominateur de tous
 * les suiveurs d'un coup. C'est voulu : R18 existe pour dire « ce passage vaut
 * le détour mais ne conditionne rien », et un membre qui saute les entrées
 * facultatives doit pouvoir atteindre 100 %.
 */
export async function marquerFacultative(
	db: Db,
	options: {
		membreId: string;
		ordreId: string;
		entreeId: string;
		facultative: boolean;
		now?: number;
	}
): Promise<ResultatSimple> {
	const now = options.now ?? Date.now();
	const autorise = await ordreModifiable(db, options.ordreId, options.membreId);
	if (!autorise.ok) return autorise;

	const entree = await db.query.orderEntries.findFirst({
		where: and(eq(orderEntries.id, options.entreeId), eq(orderEntries.orderId, options.ordreId))
	});
	if (!entree) return { ok: false, motif: 'entrée introuvable' };

	await db
		.update(orderEntries)
		.set({ optional: options.facultative })
		.where(eq(orderEntries.id, entree.id));

	await toucher(db, options.ordreId, now);
	return { ok: true };
}

// ---------------------------------------------------------------------------
// Suivi (R17, R22, R36)
// ---------------------------------------------------------------------------

/**
 * Suit un ordre.
 *
 * Idempotent, et sans le moindre calcul : il n'y a pas de progression à amorcer.
 * Un membre qui suit un ordre dont il a déjà lu la moitié des œuvres arrive
 * directement à 50 %, sans qu'aucun code n'ait eu à s'en occuper — c'est
 * littéralement la seconde phrase de R36.
 *
 * **L'auteur peut suivre son propre ordre** et rien ne l'y oblige : le suivi dit
 * « je le parcours », pas « je l'ai écrit ». Les deux se lisent séparément sur la
 * page d'un membre.
 */
export async function suivre(
	db: Db,
	options: { membreId: string; ordreId: string; now?: number }
): Promise<ResultatSimple> {
	const now = options.now ?? Date.now();

	const ordre = await db.query.orders.findFirst({ where: eq(orders.id, options.ordreId) });
	if (!ordre) return { ok: false, motif: 'ordre introuvable' };

	const membre = await db.query.members.findFirst({ where: eq(members.id, options.membreId) });
	if (!membre) return { ok: false, motif: 'membre introuvable' };

	// R41 — seul le premier suivi entre au fil. Le geste est idempotent (R36 le
	// veut : cesser de suivre puis suivre à nouveau ne perd rien) et un fil qui
	// répéterait « X suit cet ordre » à chaque aller-retour serait du bruit.
	const deja = await db.query.orderFollows.findFirst({
		where: and(
			eq(orderFollows.orderId, options.ordreId),
			eq(orderFollows.memberId, options.membreId)
		)
	});

	await db
		.insert(orderFollows)
		.values({ orderId: options.ordreId, memberId: options.membreId, createdAt: now })
		.onConflictDoNothing();

	if (!deja) {
		await journaliserOrdreSuivi(db, { membreId: options.membreId, ordreId: options.ordreId, now });
	}

	return { ok: true };
}

/**
 * R36 — cesser de suivre un ordre, sans rien perdre.
 *
 * Une suppression de ligne, et c'est tout. Aucune consignation n'est touchée,
 * aucune note, aucun avis, aucun appui de graphe. Suivre à nouveau restitue la
 * progression exacte parce qu'elle n'a jamais quitté le journal du membre.
 */
export async function cesserDeSuivre(
	db: Db,
	options: { membreId: string; ordreId: string }
): Promise<ResultatSimple> {
	const ordre = await db.query.orders.findFirst({ where: eq(orders.id, options.ordreId) });
	if (!ordre) return { ok: false, motif: 'ordre introuvable' };

	await db
		.delete(orderFollows)
		.where(
			and(eq(orderFollows.orderId, options.ordreId), eq(orderFollows.memberId, options.membreId))
		);

	return { ok: true };
}

// ---------------------------------------------------------------------------
// Lectures
// ---------------------------------------------------------------------------

/**
 * R42 — l'ordre qu'une surface déclare comme provenance, s'il peut l'être.
 *
 * La provenance arrive par l'URL — un membre suit un ordre, clique vers une
 * œuvre, la consigne — donc elle est **forgeable** : rien n'empêche de poster
 * l'identifiant d'un ordre quelconque. Ce qui la rend vérifiable est qu'elle
 * énonce un fait contrôlable : « je suis arrivé sur cette œuvre par cet ordre »
 * n'est possible que si l'ordre existe et **contient l'œuvre**. Un ordre qui ne
 * la contient pas ne mène nulle part, et la prétention tombe d'elle-même.
 *
 * Le suivi, lui, n'est délibérément pas exigé : R17 rend les ordres visibles par
 * tout le groupe, et parcourir un ordre sans le suivre est le geste normal de
 * qui le découvre. L'exiger transformerait une constatation en permission.
 *
 * Rend le titre avec l'identifiant parce que la surface qui vérifie est celle qui
 * annonce « tu arrives depuis *Par où entrer* » : deux lectures pour la même
 * chose seraient une de trop.
 */
export async function ordreProvenant(
	db: Db,
	ordreId: string,
	oeuvreId: string
): Promise<{ id: string; titre: string } | null> {
	if (ordreId === '' || oeuvreId === '') return null;

	const [ligne] = await db
		.select({ id: orders.id, titre: orders.title })
		.from(orders)
		.innerJoin(orderEntries, eq(orderEntries.orderId, orders.id))
		.where(and(eq(orders.id, ordreId), eq(orderEntries.workId, oeuvreId)))
		.limit(1);

	return ligne ?? null;
}

/**
 * Les œuvres qu'un membre a atteintes, parmi celles qu'on lui demande.
 *
 * L'atteinte est dérivée par `journal/atteinte.ts`, ici comme partout ailleurs :
 * la lire depuis une colonne serait ouvrir la porte à ce qu'elle diverge de
 * l'étagère, et le jour où elle divergerait un ordre avancerait tout seul.
 *
 * Une seule requête pour le lot : une page d'ordre à trois cents entrées ne doit
 * pas coûter trois cents allers-retours (KTD2).
 */
async function oeuvresAtteintes(
	db: Db,
	membreId: string,
	oeuvreIds: readonly string[]
): Promise<Set<string>> {
	const ids = [...new Set(oeuvreIds)];
	if (ids.length === 0) return new Set();

	const entrees = await db.query.journalEntries.findMany({
		where: and(eq(journalEntries.memberId, membreId), inArray(journalEntries.workId, ids))
	});

	return new Set(
		entrees
			.filter((entree) =>
				estAtteinte({ etagere: entree.shelf, abandonnee: entree.abandonedAt !== null })
			)
			.map((entree) => entree.workId)
	);
}

/** Les entrées d'un ordre, œuvre jointe à gauche pour survivre à sa disparition. */
async function entreesDe(db: Db, ordreId: string) {
	return db
		.select({
			id: orderEntries.id,
			oeuvreId: orderEntries.workId,
			rang: orderEntries.rank,
			facultative: orderEntries.optional,
			type: works.type
		})
		.from(orderEntries)
		.leftJoin(works, eq(works.id, orderEntries.workId))
		.where(eq(orderEntries.orderId, ordreId))
		.orderBy(asc(orderEntries.rank));
}

/**
 * Un ordre complet, du point de vue d'un lecteur donné.
 *
 * Le lecteur n'est pas un détail d'affichage : la progression, le fait de
 * suivre et le droit de modifier sont **les siens**. Deux membres qui ouvrent la
 * même page reçoivent deux charges utiles différentes, et c'est la forme juste —
 * un ordre est un objet partagé, sa progression ne l'est pas.
 */
export async function lireOrdre(
	db: Db,
	ordreId: string,
	lecteurId: string
): Promise<OrdreDetaille | null> {
	const ordre = await db.query.orders.findFirst({ where: eq(orders.id, ordreId) });
	if (!ordre) return null;

	const lignes = await entreesDe(db, ordreId);

	const [auteur, original, suiveurs, suivi, titres, atteintes] = await Promise.all([
		db.query.members.findFirst({ where: eq(members.id, ordre.authorId) }),
		ordre.forkedFromId === null
			? Promise.resolve(undefined)
			: db.query.orders.findFirst({ where: eq(orders.id, ordre.forkedFromId) }),
		db
			.select({ n: count() })
			.from(orderFollows)
			.where(eq(orderFollows.orderId, ordreId))
			.then(([ligne]) => ligne.n),
		db.query.orderFollows.findFirst({
			where: and(eq(orderFollows.orderId, ordreId), eq(orderFollows.memberId, lecteurId))
		}),
		titresCorriges(
			db,
			lignes.filter((ligne) => ligne.type !== null).map((ligne) => ligne.oeuvreId)
		),
		oeuvresAtteintes(
			db,
			lecteurId,
			lignes.map((ligne) => ligne.oeuvreId)
		)
	]);

	const entrees: EntreeDetaillee[] = lignes.map((ligne) => {
		const introuvable = ligne.type === null;
		return {
			id: ligne.id,
			oeuvreId: ligne.oeuvreId,
			rang: ligne.rang,
			facultative: ligne.facultative,
			introuvable,
			oeuvre: introuvable
				? null
				: {
						id: ligne.oeuvreId,
						titre: titres.get(ligne.oeuvreId) ?? '',
						type: ligne.type as TypeOeuvre
					},
			atteinte: !introuvable && atteintes.has(ligne.oeuvreId)
		};
	});

	return {
		...resume(
			ordre,
			auteur ?? null,
			original ?? null,
			entrees.length,
			suiveurs,
			suivi !== undefined,
			lecteurId,
			calculerProgression(entrees, atteintes)
		),
		entrees
	};
}

/** L'assemblage commun aux deux formes de lecture. */
function resume(
	ordre: Order,
	auteur: { id: string; displayName: string; leftAt: number | null } | null,
	original: { id: string; title: string } | null,
	nombreDEntrees: number,
	nombreDeSuiveurs: number,
	suivi: boolean,
	lecteurId: string,
	progression: Progression
): ResumeOrdre {
	const parti = auteur === null || auteur.leftAt !== null;

	return {
		id: ordre.id,
		titre: ordre.title,
		description: ordre.description,
		auteur: {
			id: ordre.authorId,
			nom: auteur?.displayName ?? '',
			parti
		},
		forkDe: original === null ? null : { id: original.id, titre: original.title },
		nombreDEntrees,
		nombreDeSuiveurs,
		suivi,
		// R16 et R38 réunis : l'auteur, et seulement lui, tant qu'il est là.
		modifiable: ordre.authorId === lecteurId && !parti,
		progression,
		creeLe: ordre.createdAt,
		misAJourLe: ordre.updatedAt
	};
}

/**
 * Tous les ordres du groupe, du plus récemment touché au plus ancien.
 *
 * R17 les rend visibles par le groupe entier, sans filtre : la découverte d'un
 * ordre est exactement le parcours F3 du document d'origine — « il trouve les
 * ordres créés par le groupe, en choisit un, le suit ».
 *
 * Le nombre de requêtes est constant, pas proportionnel au nombre d'ordres.
 */
export async function listerOrdres(db: Db, lecteurId: string): Promise<ResumeOrdre[]> {
	const lignes = await db.select().from(orders).orderBy(desc(orders.updatedAt), desc(orders.id));
	if (lignes.length === 0) return [];

	const ids = lignes.map((ordre) => ordre.id);

	const [auteurs, originaux, entrees, suivis, mesSuivis] = await Promise.all([
		db.query.members.findMany({
			where: inArray(
				members.id,
				lignes.map((ordre) => ordre.authorId)
			)
		}),
		db.query.orders.findMany({
			where: inArray(
				orders.id,
				lignes.map((ordre) => ordre.forkedFromId).filter((id): id is string => id !== null)
			)
		}),
		db
			.select({
				ordreId: orderEntries.orderId,
				oeuvreId: orderEntries.workId,
				id: orderEntries.id,
				rang: orderEntries.rank,
				facultative: orderEntries.optional
			})
			.from(orderEntries)
			.where(inArray(orderEntries.orderId, ids)),
		db
			.select({ ordreId: orderFollows.orderId, membreId: orderFollows.memberId })
			.from(orderFollows)
			.where(inArray(orderFollows.orderId, ids)),
		db
			.select({ ordreId: orderFollows.orderId })
			.from(orderFollows)
			.where(and(inArray(orderFollows.orderId, ids), eq(orderFollows.memberId, lecteurId)))
	]);

	const atteintes = await oeuvresAtteintes(
		db,
		lecteurId,
		entrees.map((entree) => entree.oeuvreId)
	);

	const parOrdre = new Map<string, EntreeDOrdre[]>();
	for (const entree of entrees) {
		const liste = parOrdre.get(entree.ordreId) ?? [];
		liste.push({
			id: entree.id,
			oeuvreId: entree.oeuvreId,
			rang: entree.rang,
			facultative: entree.facultative
		});
		parOrdre.set(entree.ordreId, liste);
	}

	const parAuteur = new Map(auteurs.map((membre) => [membre.id, membre]));
	const parOriginal = new Map(originaux.map((ordre) => [ordre.id, ordre]));
	const suiveursParOrdre = new Map<string, number>();
	for (const { ordreId } of suivis)
		suiveursParOrdre.set(ordreId, (suiveursParOrdre.get(ordreId) ?? 0) + 1);
	const jeSuis = new Set(mesSuivis.map((ligne) => ligne.ordreId));

	return lignes.map((ordre) => {
		const contenu = parOrdre.get(ordre.id) ?? [];
		return resume(
			ordre,
			parAuteur.get(ordre.authorId) ?? null,
			ordre.forkedFromId === null ? null : (parOriginal.get(ordre.forkedFromId) ?? null),
			contenu.length,
			suiveursParOrdre.get(ordre.id) ?? 0,
			jeSuis.has(ordre.id),
			lecteurId,
			calculerProgression(contenu, atteintes)
		);
	});
}

/**
 * R22 — qui suit cet ordre, et où chacun en est.
 *
 * Deux requêtes pour l'ensemble des suiveurs, quel que soit leur nombre : les
 * entrées d'un côté, les consignations de tous les suiveurs sur ces œuvres de
 * l'autre. La progression de chacun se calcule ensuite en mémoire, avec la même
 * fonction pure que partout ailleurs — vingt membres et trois cents entrées ne
 * font pas six mille lignes à lire mais deux requêtes indexées.
 */
export async function suiveursDOrdre(db: Db, ordreId: string): Promise<SuiveurDOrdre[]> {
	const [lignes, suivis] = await Promise.all([
		entreesDe(db, ordreId),
		db
			.select({ membre: members, depuis: orderFollows.createdAt })
			.from(orderFollows)
			.innerJoin(members, eq(members.id, orderFollows.memberId))
			.where(eq(orderFollows.orderId, ordreId))
			.orderBy(asc(orderFollows.createdAt))
	]);

	if (suivis.length === 0) return [];

	const entrees: EntreeDOrdre[] = lignes.map((ligne) => ({
		id: ligne.id,
		oeuvreId: ligne.oeuvreId,
		rang: ligne.rang,
		facultative: ligne.facultative,
		introuvable: ligne.type === null
	}));

	const oeuvreIds = [...new Set(entrees.map((entree) => entree.oeuvreId))];
	const consignations =
		oeuvreIds.length === 0
			? []
			: await db.query.journalEntries.findMany({
					where: and(
						inArray(journalEntries.workId, oeuvreIds),
						inArray(
							journalEntries.memberId,
							suivis.map((suivi) => suivi.membre.id)
						)
					)
				});

	const atteintesParMembre = new Map<string, Set<string>>();
	for (const consignation of consignations) {
		if (
			!estAtteinte({
				etagere: consignation.shelf,
				abandonnee: consignation.abandonedAt !== null
			})
		) {
			continue;
		}
		const jeu = atteintesParMembre.get(consignation.memberId) ?? new Set<string>();
		jeu.add(consignation.workId);
		atteintesParMembre.set(consignation.memberId, jeu);
	}

	return suivis.map(({ membre, depuis }) => ({
		membreId: membre.id,
		nom: membre.displayName,
		parti: membre.leftAt !== null,
		suitDepuis: depuis,
		progression: calculerProgression(entrees, atteintesParMembre.get(membre.id) ?? new Set())
	}));
}

/**
 * R6 — les ordres qu'un membre a créés et ceux qu'il suit.
 *
 * Deux listes distinctes et non une seule marquée d'un drapeau : ce ne sont pas
 * les mêmes gestes, et le document d'origine les nomme séparément. Un ordre peut
 * légitimement figurer dans les deux.
 */
export async function ordresDUnMembre(
	db: Db,
	membreId: string,
	lecteurId: string
): Promise<{ crees: ResumeOrdre[]; suivis: ResumeOrdre[] }> {
	const tous = await listerOrdres(db, lecteurId);

	const suivisParLeMembre = await db
		.select({ ordreId: orderFollows.orderId })
		.from(orderFollows)
		.where(eq(orderFollows.memberId, membreId));
	const jeu = new Set(suivisParLeMembre.map((ligne) => ligne.ordreId));

	return {
		crees: tous.filter((ordre) => ordre.auteur.id === membreId),
		suivis: tous.filter((ordre) => jeu.has(ordre.id))
	};
}

/**
 * La progression d'un membre dans un ordre, sans le reste de la page.
 *
 * Sert là où seule l'avancée compte — AE4, qui demande que trois ordres suivis
 * avancent d'un coup, se lit exactement comme ça.
 */
export async function progressionDansOrdre(
	db: Db,
	ordreId: string,
	membreId: string
): Promise<Progression | null> {
	const ordre = await db.query.orders.findFirst({ where: eq(orders.id, ordreId) });
	if (!ordre) return null;

	const lignes = await entreesDe(db, ordreId);
	const entrees: EntreeDOrdre[] = lignes.map((ligne) => ({
		id: ligne.id,
		oeuvreId: ligne.oeuvreId,
		rang: ligne.rang,
		facultative: ligne.facultative,
		introuvable: ligne.type === null
	}));

	return calculerProgression(
		entrees,
		await oeuvresAtteintes(
			db,
			membreId,
			entrees.map((entree) => entree.oeuvreId)
		)
	);
}
