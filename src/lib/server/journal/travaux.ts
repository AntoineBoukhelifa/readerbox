import { and, asc, count, desc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
	cascades,
	entryOrigins,
	journalEntries,
	workContents,
	type ActionDeCascade,
	type Cascade
} from '../db/schema';
import type { Db } from '../db';

/**
 * La file des cascades fractionnées.
 *
 * Même forme que `frontiere.ts` et que `catalog/rematerialisation.ts`, et pour
 * les mêmes raisons : une table plutôt qu'une fonction de rappel, parce qu'un
 * rappel en mémoire disparaît avec l'invocation Worker sans laisser de trace, et
 * parce que le Cron Trigger — seul ordonnanceur du palier gratuit — a besoin
 * d'une file à lire.
 *
 * Ce module ne connaît **que** la table `cascades`. Il n'écrit ni dans
 * `journal_entries` ni dans `entry_origins` : `entries.ts` reste le seul à le
 * faire. C'est ce découpage qui évite un cycle d'imports — `entries.ts` planifie
 * en appelant ce module, `cascade.ts` exécute en appelant les deux.
 */

/** Un lot d'éléments à traiter, tel que l'exécuteur le consomme. */
export interface ProgressionCascade {
	action: ActionDeCascade;
	/** Combien d'éléments la cascade comptait à sa planification. */
	total: number;
	traites: number;
	terminee: boolean;
}

/**
 * Le nombre d'éléments qu'une cascade aura à traiter.
 *
 * Compté à la planification pour que l'état de progression soit affichable dès
 * la consignation — KTD2 exige que le geste soit immédiat *et* que son avancement
 * se voie. Le chiffre reste indicatif : une ligne de contenu non encore résolue
 * (`content_work_id` nul) n'y figure pas et s'y ajoutera quand l'ingestion la
 * résoudra.
 */
async function compter(
	db: Db,
	membreId: string,
	contenantId: string,
	action: ActionDeCascade
): Promise<number> {
	if (action === 'propager') {
		const [ligne] = await db
			.select({ nombre: count() })
			.from(workContents)
			.where(
				and(
					eq(workContents.containerWorkId, contenantId),
					isNotNull(workContents.contentWorkId),
					ne(workContents.contentWorkId, contenantId)
				)
			);
		return ligne.nombre;
	}

	const [ligne] = await db
		.select({ nombre: count() })
		.from(entryOrigins)
		.innerJoin(journalEntries, eq(journalEntries.id, entryOrigins.entryId))
		.where(
			and(eq(entryOrigins.containerWorkId, contenantId), eq(journalEntries.memberId, membreId))
		);
	return ligne.nombre;
}

/**
 * Planifie — ou replanifie — la cascade d'un contenant pour un membre.
 *
 * Une seule cascade en attente par couple membre-contenant, portée par l'index
 * partiel : consigner un omnibus puis le terminer avant le passage du Cron ne
 * produit pas deux travaux concurrents, mais un seul, **repris depuis le début**.
 * Le curseur est remis à zéro et c'est délibéré : les éléments déjà traités
 * l'avaient été avec l'état précédent du contenant, et les rejouer est sans
 * effet là où les laisser figerait la moitié d'un omnibus en « en cours » alors
 * que le membre l'a terminé.
 */
export async function planifierCascade(
	db: Db,
	options: { membreId: string; contenantId: string; action: ActionDeCascade; now?: number }
): Promise<void> {
	const now = options.now ?? Date.now();
	const total = await compter(db, options.membreId, options.contenantId, options.action);

	await db
		.insert(cascades)
		.values({
			memberId: options.membreId,
			containerWorkId: options.contenantId,
			action: options.action,
			totalCount: total,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: [cascades.memberId, cascades.containerWorkId],
			targetWhere: sql`completed_at is null`,
			set: {
				action: options.action,
				lastSource: null,
				lastExternalId: null,
				processedCount: 0,
				totalCount: total,
				updatedAt: now
			}
		});
}

/** Les cascades non terminées, les plus anciennes d'abord. */
export async function cascadesEnAttente(db: Db, limite = 10): Promise<Cascade[]> {
	return db.query.cascades.findMany({
		where: isNull(cascades.completedAt),
		orderBy: [asc(cascades.createdAt), asc(cascades.id)],
		limit: limite
	});
}

/** Avance le curseur de reprise après un lot. */
export async function avancerCascade(
	db: Db,
	id: string,
	position: {
		source?: string | null;
		idExterne?: string | null;
		traites: number;
		now?: number;
	}
): Promise<void> {
	const now = position.now ?? Date.now();
	await db
		.update(cascades)
		.set({
			...(position.source !== undefined
				? { lastSource: position.source as Cascade['lastSource'] }
				: {}),
			...(position.idExterne !== undefined ? { lastExternalId: position.idExterne } : {}),
			processedCount: sql`${cascades.processedCount} + ${position.traites}`,
			updatedAt: now
		})
		.where(eq(cascades.id, id));
}

/**
 * Marque une cascade terminée.
 *
 * Terminée n'est pas supprimée, pour la même raison qu'ailleurs : le rattrapage
 * doit pouvoir constater ce qui a été fait et quand. L'index d'unicité étant
 * partiel sur les cascades non terminées, une nouvelle consignation du même
 * recueil crée bien une nouvelle ligne sans buter dessus.
 */
export async function terminerCascade(db: Db, id: string, now = Date.now()): Promise<void> {
	await db
		.update(cascades)
		.set({ completedAt: now, updatedAt: now })
		.where(and(eq(cascades.id, id), isNull(cascades.completedAt)));
}

/** La cascade en attente pour ce couple, s'il y en a une. */
export async function cascadeEnAttente(
	db: Db,
	membreId: string,
	contenantId: string
): Promise<Cascade | null> {
	const ligne = await db.query.cascades.findFirst({
		where: and(
			eq(cascades.memberId, membreId),
			eq(cascades.containerWorkId, contenantId),
			isNull(cascades.completedAt)
		)
	});
	return ligne ?? null;
}

/**
 * L'état d'avancement de la cascade la plus récente sur ce couple.
 *
 * C'est ce qu'une page de recueil affiche pendant que les quarante numéros se
 * propagent. `null` quand aucune cascade n'a jamais été planifiée — un recueil
 * jamais consigné, ou une série de comics, que R11 exclut de toute cascade.
 */
export async function progressionCascade(
	db: Db,
	membreId: string,
	contenantId: string
): Promise<ProgressionCascade | null> {
	const ligne = await db.query.cascades.findFirst({
		where: and(eq(cascades.memberId, membreId), eq(cascades.containerWorkId, contenantId)),
		orderBy: [desc(cascades.createdAt), desc(cascades.id)]
	});
	if (!ligne) return null;

	return {
		action: ligne.action,
		total: Math.max(ligne.totalCount, ligne.processedCount),
		traites: ligne.processedCount,
		terminee: ligne.completedAt !== null
	};
}
