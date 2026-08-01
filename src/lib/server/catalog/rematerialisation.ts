import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
	graphRematerializations,
	type GraphRematerialization,
	type MotifRematerialisation
} from '../db/schema';
import type { Db } from '../db';

/**
 * Le point d'appel de KTD4 que U9 viendra brancher.
 *
 * Trois choses changent les rattachements d'une œuvre sans qu'aucun état de
 * lecture ne bouge : une correction de membre (R47), une ré-ingestion (R39) et
 * une fusion manuelle de doublons. Dans les trois cas les appuis du graphe
 * doivent être rejoués pour tous les membres qui ont atteint l'œuvre. Sans ça,
 * un personnage ajouté après coup n'apparaîtrait jamais dans aucun graphe —
 * silencieusement, et définitivement.
 *
 * Le choix retenu est une **file durable en base** plutôt qu'une fonction de
 * rappel enregistrée en mémoire :
 *
 * - une fonction de rappel disparaît avec l'invocation Worker ; la demande
 *   serait perdue sans laisser de trace, ce qui est exactement le mode de
 *   défaillance qu'on cherche à éliminer ;
 * - le rejeu porte sur tous les membres ayant atteint l'œuvre, ce qui ne tient
 *   pas dans les 10 ms de temps processeur d'une requête. Il appartient au Cron
 *   Trigger, et un ordonnanceur a besoin d'une file à lire, pas d'un rappel ;
 * - une file lisible est vérifiable : les tests de U3a constatent la demande,
 *   ceux de U9 constateront son traitement, sans que les deux unités aient à se
 *   connaître.
 *
 * U3a produit ; U9 consommera `enAttente` et appellera `marquerTraitees`.
 */

/** Enfile une demande de re-matérialisation pour une œuvre.
 *
 * Idempotent tant que la demande n'est pas traitée : dix corrections
 * successives sur la même œuvre n'en produisent qu'une, puisque le rejeu lit
 * l'état final et non le delta. L'unicité partielle est portée par l'index, ce
 * qui la rend vraie même si deux invocations écrivent en même temps.
 */
export async function signalerRattachementsModifies(
	db: Db,
	oeuvreId: string,
	motif: MotifRematerialisation,
	now = Date.now()
): Promise<void> {
	await db
		.insert(graphRematerializations)
		.values({ workId: oeuvreId, reason: motif, createdAt: now })
		.onConflictDoNothing();
}

/** Les demandes non encore traitées, les plus anciennes d'abord. */
export async function enAttente(db: Db, limite = 100): Promise<GraphRematerialization[]> {
	return db.query.graphRematerializations.findMany({
		where: isNull(graphRematerializations.processedAt),
		orderBy: [asc(graphRematerializations.createdAt), asc(graphRematerializations.id)],
		limit: limite
	});
}

/**
 * Marque des demandes comme traitées.
 *
 * Le marquage est distinct de la suppression pour que le rattrapage du Cron
 * Trigger puisse constater ce qui a été rejoué et quand.
 */
export async function marquerTraitees(db: Db, ids: string[], now = Date.now()): Promise<void> {
	if (ids.length === 0) return;
	await db
		.update(graphRematerializations)
		.set({ processedAt: now })
		.where(
			and(inArray(graphRematerializations.id, ids), isNull(graphRematerializations.processedAt))
		);
}

/** Y a-t-il une demande en attente pour cette œuvre ? Lecture de confort pour les tests et U9. */
export async function estEnAttente(db: Db, oeuvreId: string): Promise<boolean> {
	const ligne = await db.query.graphRematerializations.findFirst({
		where: and(
			eq(graphRematerializations.workId, oeuvreId),
			isNull(graphRematerializations.processedAt)
		)
	});
	return ligne !== undefined;
}
