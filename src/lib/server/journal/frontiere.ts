import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { reachCrossings, type ReachCrossing } from '../db/schema';
import type { Db } from '../db';
import type { SensDeFranchissement } from './atteinte';

/**
 * Le point d'appel unique de U4.
 *
 * Trois mécaniques se croisent sur le franchissement de la frontière
 * « atteint » et doivent rester cohérentes (« Impact transverse » du plan) :
 * la visibilité des textes (U6), la progression des ordres (U7) et les appuis
 * du graphe (U9). Deux d'entre elles n'ont **rien à recevoir** :
 *
 * - le masquage se décide à la lecture, à partir de l'état atteint (R27) ;
 * - la progression dans un ordre n'est jamais stockée : c'est l'intersection
 *   entre les entrées de l'ordre et les œuvres atteintes du membre (KTD8, R19).
 *
 * Les deux suivent donc d'elles-mêmes, et leur envoyer une notification serait
 * un canal de plus à maintenir juste. La troisième, en revanche, est
 * matérialisée à l'écriture (KTD4) parce qu'un parcours de graphe au rendu ne
 * tient pas dans les 10 ms de temps processeur d'une requête — et c'est elle
 * que cette file sert.
 *
 * **Pourquoi une file durable, et pourquoi une file à part.** U3a a posé
 * `catalog/rematerialisation.ts` pour les modifications de catalogue, et la
 * forme est reprise telle quelle : une table plutôt qu'une fonction de rappel,
 * parce qu'un rappel en mémoire disparaît avec l'invocation Worker sans laisser
 * de trace, et parce que le Cron Trigger — seul ordonnanceur du palier gratuit
 * — a besoin de lire une file. Mais la table est distincte, et le grain est la
 * raison :
 *
 * | file | grain | ce qu'il faut rejouer |
 * | --- | --- | --- |
 * | `graph_rematerializations` | une œuvre | pour **tous** les membres qui l'ont atteinte |
 * | `reach_crossings` | un couple membre-œuvre | pour **ce membre** seul |
 *
 * Les confondre reviendrait à recalculer vingt graphes chaque fois qu'un membre
 * termine un numéro — sur le geste le plus fréquent du produit, et pour dix-neuf
 * membres dont rien n'a bougé. Deux natures d'événement, deux files.
 *
 * U4 produit ; U9 consommera `franchissementsEnAttente` et appellera
 * `marquerFranchissementsTraites`. Rien dans ce module ne connaît le graphe.
 */

export interface Franchissement {
	membreId: string;
	oeuvreId: string;
	sens: SensDeFranchissement;
}

/**
 * Enfile un franchissement.
 *
 * Une seule demande en attente par couple membre-œuvre, portant le **dernier**
 * sens franchi. C'est légitime parce que le rejeu lit l'état final et non le
 * delta : les appuis d'une œuvre pour un membre sont présents si et seulement
 * si elle est atteinte, donc deux franchissements successifs se résument au
 * dernier. Conserver le premier serait faux — un membre qui termine puis
 * reprend une œuvre avant le passage du Cron laisserait des appuis fantômes.
 *
 * L'unicité est portée par l'index partiel, ce qui la rend vraie même si deux
 * invocations écrivent en même temps.
 *
 * Ce n'est **pas un journal d'événements** : le fil d'activité de U8 a besoin de
 * chaque transition, pas de l'état final, et devra les écrire de son côté.
 */
export async function signalerFranchissement(
	db: Db,
	franchissement: Franchissement,
	now = Date.now()
): Promise<void> {
	await db
		.insert(reachCrossings)
		.values({
			memberId: franchissement.membreId,
			workId: franchissement.oeuvreId,
			direction: franchissement.sens,
			createdAt: now
		})
		.onConflictDoUpdate({
			target: [reachCrossings.memberId, reachCrossings.workId],
			targetWhere: sql`processed_at is null`,
			set: { direction: franchissement.sens, createdAt: now }
		});
}

/** Les franchissements non encore traités, les plus anciens d'abord. */
export async function franchissementsEnAttente(db: Db, limite = 100): Promise<ReachCrossing[]> {
	return db.query.reachCrossings.findMany({
		where: isNull(reachCrossings.processedAt),
		orderBy: [asc(reachCrossings.createdAt), asc(reachCrossings.id)],
		limit: limite
	});
}

/**
 * Marque des franchissements comme traités.
 *
 * Le marquage est distinct de la suppression pour que le rattrapage du Cron
 * Trigger puisse constater ce qui a été rejoué et quand — même raison qu'en
 * U3a.
 */
export async function marquerFranchissementsTraites(
	db: Db,
	ids: string[],
	now = Date.now()
): Promise<void> {
	if (ids.length === 0) return;
	await db
		.update(reachCrossings)
		.set({ processedAt: now })
		.where(and(inArray(reachCrossings.id, ids), isNull(reachCrossings.processedAt)));
}

/** Le franchissement en attente pour ce couple, s'il y en a un. Lecture de confort. */
export async function franchissementEnAttente(
	db: Db,
	membreId: string,
	oeuvreId: string
): Promise<ReachCrossing | null> {
	const ligne = await db.query.reachCrossings.findFirst({
		where: and(
			eq(reachCrossings.memberId, membreId),
			eq(reachCrossings.workId, oeuvreId),
			isNull(reachCrossings.processedAt)
		)
	});
	return ligne ?? null;
}
