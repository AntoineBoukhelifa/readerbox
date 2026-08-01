import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import {
	cascades,
	entryOrigins,
	journalEntries,
	workContents,
	works,
	type Cascade
} from '../db/schema';
import type { Db } from '../db';
import { appliquerAppui, retirerAppui } from './entries';
import { TYPES_CONTENANTS } from './contenance';
import { avancerCascade, cascadesEnAttente, planifierCascade, terminerCascade } from './travaux';

/**
 * L'exécution fractionnée des cascades de recueil (R9, KTD2).
 *
 * **Pourquoi fractionner.** Consigner un omnibus de quarante numéros suppose
 * autant d'ingestions amont et autant de jeux d'appuis de graphe. Cloudflare
 * Workers plafonne à 10 ms de temps processeur par requête et borne le nombre de
 * sous-requêtes par invocation : la cascade entière ne tient dans aucun des deux.
 * La consignation du recueil est donc immédiate — une ligne dans `cascades` — et
 * la propagation se fait par lots que le Cron Trigger reprend.
 *
 * **Pourquoi c'est idempotent.** Ce n'est pas le curseur de reprise qui le
 * garantit, et c'est important : un curseur peut être perdu, une invocation peut
 * mourir entre l'écriture d'un appui et l'avancement du curseur. Ce sont les
 * écritures elles-mêmes qui sont idempotentes :
 *
 * - l'appui est une ligne de clé `(entrée, contenant)` posée en
 *   `on conflict do nothing` — la reposer ne fait rien ;
 * - l'état propagé est **recalculé depuis tous les appuis de l'entrée**, jamais
 *   appliqué en delta, donc il ne dépend ni de l'ordre des lots ni du nombre de
 *   fois qu'un élément est traité ;
 * - le franchissement de frontière est comparé par le prédicat avant d'être
 *   enfilé, donc rejouer un élément dans le même état n'enfile rien.
 *
 * Le curseur n'est qu'une économie de travail. Rejouer un lot entier donne le
 * même résultat que ne pas le rejouer.
 *
 * **Ce que cette unité ne fait pas.** Les effets sur les ordres (U7) et sur le
 * graphe (U9) ne sont pas ici : ils sont portés par le point d'appel unique de
 * U4, que chaque appui traversé notifie.
 */

/** Combien d'éléments un lot traite par défaut. */
export const TAILLE_DE_LOT = 10;

export interface ResumeExecution {
	/** Combien d'éléments — numéros, épisodes — ont été traités. */
	elements: number;
	/** Combien de cascades se sont achevées pendant cette passe. */
	cascadesTerminees: number;
	/** Reste-t-il du travail ? C'est ce que le Cron regarde pour reboucler. */
	restantes: number;
}

/**
 * Traite au plus `budget` éléments, répartis sur les cascades en attente.
 *
 * Le budget est en **éléments** et non en cascades : c'est lui qui borne le
 * nombre de sous-requêtes de l'invocation, et une cascade de quarante numéros ne
 * doit pas pouvoir s'exécuter d'un bloc sous prétexte qu'elle est seule.
 */
export async function executerCascades(
	db: Db,
	options: { budget?: number; now?: number } = {}
): Promise<ResumeExecution> {
	const budget = options.budget ?? TAILLE_DE_LOT;
	const now = options.now ?? Date.now();

	let restant = budget;
	let elements = 0;
	let cascadesTerminees = 0;

	const enAttente = await cascadesEnAttente(db);

	for (const cascade of enAttente) {
		if (restant <= 0) break;

		const resultat =
			cascade.action === 'propager'
				? await propagerUnLot(db, cascade, restant, now)
				: await retirerUnLot(db, cascade, restant, now);

		elements += resultat.elements;
		restant -= resultat.elements;
		if (resultat.terminee) cascadesTerminees += 1;
	}

	const encore = await cascadesEnAttente(db);
	return { elements, cascadesTerminees, restantes: encore.length };
}

/**
 * Déroule la file jusqu'à ce qu'il n'y ait plus rien, par lots successifs.
 *
 * C'est ce que le Cron Trigger appelle — un handler planifié dispose de bien
 * plus que les 10 ms d'une requête — et ce que les tests appellent pour observer
 * l'état final. `maxPasses` est un garde-fou : une file qui ne se vide pas est
 * un défaut, et boucler indéfiniment le rendrait invisible.
 */
export async function deroulerCascades(
	db: Db,
	options: { budget?: number; maxPasses?: number; now?: number } = {}
): Promise<ResumeExecution> {
	const maxPasses = options.maxPasses ?? 200;

	let elements = 0;
	let cascadesTerminees = 0;
	let restantes = 0;

	for (let passe = 0; passe < maxPasses; passe += 1) {
		const resume = await executerCascades(db, options);
		elements += resume.elements;
		cascadesTerminees += resume.cascadesTerminees;
		restantes = resume.restantes;
		if (resume.elements === 0) break;
	}

	return { elements, cascadesTerminees, restantes };
}

/**
 * Un lot de propagation : les lignes de contenu suivantes, dans l'ordre total
 * `(source, id externe)`.
 *
 * Deux familles de lignes sont écartées en SQL plutôt qu'en TypeScript, pour
 * qu'elles ne consomment pas de budget :
 *
 * - **le contenu non encore résolu** (`content_work_id` nul). KTD1 interdit
 *   d'ingérer les quarante numéros au moment où l'on ingère l'omnibus, donc la
 *   référence amont attend. Ce n'est pas une perte : `catalog/ingest.ts` résout
 *   la ligne quand le numéro arrive, et `rattraperCascades` replanifie ;
 * - **le recueil qui se contient lui-même**, erreur de données que les sources
 *   produisent. Lui appliquer son propre appui créerait une entrée soutenue par
 *   elle-même, que plus aucun retrait ne pourrait atteindre.
 */
async function propagerUnLot(
	db: Db,
	cascade: Cascade,
	budget: number,
	now: number
): Promise<{ elements: number; terminee: boolean }> {
	const taille = Math.min(budget, TAILLE_DE_LOT);

	const lignes = await db
		.select({
			source: workContents.source,
			idExterne: workContents.externalId,
			oeuvreId: workContents.contentWorkId
		})
		.from(workContents)
		.where(
			and(
				eq(workContents.containerWorkId, cascade.containerWorkId),
				isNotNull(workContents.contentWorkId),
				ne(workContents.contentWorkId, cascade.containerWorkId),
				apresLeCurseur(cascade)
			)
		)
		.orderBy(asc(workContents.source), asc(workContents.externalId))
		.limit(taille);

	for (const ligne of lignes) {
		await appliquerAppui(db, {
			membreId: cascade.memberId,
			oeuvreId: ligne.oeuvreId as string,
			contenantId: cascade.containerWorkId,
			now
		});
	}

	const derniere = lignes.at(-1);
	if (derniere) {
		await avancerCascade(db, cascade.id, {
			source: derniere.source,
			idExterne: derniere.idExterne,
			traites: lignes.length,
			now
		});
	}

	// Un lot incomplet veut dire qu'il n'y avait plus rien à prendre : le
	// contenu restant, s'il en reste, n'est pas encore résolu.
	const terminee = lignes.length < taille;
	if (terminee) await terminerCascade(db, cascade.id, now);

	return { elements: lignes.length, terminee };
}

/**
 * La condition de reprise, sur l'ordre total `(source, id externe)`.
 *
 * L'ordre n'a aucun sens éditorial — le `rank` de la source en aurait un — et
 * n'en a pas besoin : tous les éléments reçoivent le même traitement, seule
 * compte la stabilité, que la clé primaire de `work_contents` donne
 * gratuitement.
 */
function apresLeCurseur(cascade: Cascade) {
	if (cascade.lastSource === null || cascade.lastExternalId === null) return undefined;
	return or(
		gt(workContents.source, cascade.lastSource),
		and(
			eq(workContents.source, cascade.lastSource),
			gt(workContents.externalId, cascade.lastExternalId)
		)
	);
}

/**
 * Un lot de retrait : les appuis restants de ce contenant pour ce membre.
 *
 * Pas de curseur ici, et il n'en faut pas — les lignes traitées disparaissent,
 * donc « les suivantes » sont toujours « les premières ». La reprise est exacte
 * par construction.
 */
async function retirerUnLot(
	db: Db,
	cascade: Cascade,
	budget: number,
	now: number
): Promise<{ elements: number; terminee: boolean }> {
	const taille = Math.min(budget, TAILLE_DE_LOT);

	const lignes = await db
		.select({ oeuvreId: journalEntries.workId })
		.from(entryOrigins)
		.innerJoin(journalEntries, eq(journalEntries.id, entryOrigins.entryId))
		.where(
			and(
				eq(entryOrigins.containerWorkId, cascade.containerWorkId),
				eq(journalEntries.memberId, cascade.memberId)
			)
		)
		.orderBy(asc(journalEntries.workId))
		.limit(taille);

	for (const ligne of lignes) {
		await retirerAppui(db, {
			membreId: cascade.memberId,
			oeuvreId: ligne.oeuvreId,
			contenantId: cascade.containerWorkId,
			now
		});
	}

	if (lignes.length > 0) {
		await avancerCascade(db, cascade.id, { traites: lignes.length, now });
	}

	const terminee = lignes.length < taille;
	if (terminee) await terminerCascade(db, cascade.id, now);

	return { elements: lignes.length, terminee };
}

// ---------------------------------------------------------------------------
// Rattrapage
// ---------------------------------------------------------------------------

/**
 * Replanifie les cascades qu'un contenu résolu après coup a rendues incomplètes.
 *
 * Le cas est structurel et non accidentel : au moment où un membre consigne un
 * omnibus, ses quarante numéros n'existent pas encore localement — KTD1 les
 * ingère paresseusement. Les lignes de `work_contents` portent la référence
 * amont sans cible, la cascade les saute, et c'est correct. Quand l'un de ces
 * numéros est ingéré plus tard — parce qu'un autre membre l'a consigné, ou parce
 * que le rattrapage d'ingestion l'a résolu — `catalog/ingest.ts` remplit
 * `content_work_id` rétroactivement. Sans cette fonction, l'appui du recueil ne
 * serait jamais posé : le numéro resterait hors du journal de ce membre,
 * définitivement et sans trace.
 *
 * La détection est un simple comptage — appuis posés contre contenus résolus —
 * plutôt qu'une requête à sous-requêtes corrélées : elle tourne sur le Cron, pas
 * sur le chemin de rendu, et sa lisibilité vaut plus que ses microsecondes.
 */
export async function rattraperCascades(
	db: Db,
	options: { limite?: number; now?: number } = {}
): Promise<{ replanifiees: number }> {
	const limite = options.limite ?? 50;
	const now = options.now ?? Date.now();

	const contenants = await db
		.select({ membreId: journalEntries.memberId, contenantId: journalEntries.workId })
		.from(journalEntries)
		.innerJoin(works, eq(works.id, journalEntries.workId))
		.where(inArray(works.type, [...TYPES_CONTENANTS]))
		.limit(limite);

	// Une cascade déjà en attente n'a pas besoin d'être replanifiée, et la
	// replanifier serait un défaut : elle remettrait son curseur à zéro à chaque
	// passage du Cron, et une cascade assez longue ne s'achèverait jamais.
	const enAttente = await db
		.select({ membreId: cascades.memberId, contenantId: cascades.containerWorkId })
		.from(cascades)
		.where(isNull(cascades.completedAt));
	const dejaPlanifiees = new Set(enAttente.map((c) => `${c.membreId} ${c.contenantId}`));

	let replanifiees = 0;

	for (const { membreId, contenantId } of contenants) {
		if (dejaPlanifiees.has(`${membreId} ${contenantId}`)) continue;

		const contenus = await db
			.select({ oeuvreId: workContents.contentWorkId })
			.from(workContents)
			.where(
				and(
					eq(workContents.containerWorkId, contenantId),
					isNotNull(workContents.contentWorkId),
					ne(workContents.contentWorkId, contenantId)
				)
			);

		const attendus = new Set(contenus.map((c) => c.oeuvreId as string));
		if (attendus.size === 0) continue;

		const poses = await db
			.select({ oeuvreId: journalEntries.workId })
			.from(entryOrigins)
			.innerJoin(journalEntries, eq(journalEntries.id, entryOrigins.entryId))
			.where(
				and(eq(entryOrigins.containerWorkId, contenantId), eq(journalEntries.memberId, membreId))
			);

		const connus = new Set(poses.map((p) => p.oeuvreId));
		if ([...attendus].every((id) => connus.has(id))) continue;

		await planifierCascade(db, { membreId, contenantId, action: 'propager', now });
		replanifiees += 1;
	}

	return { replanifiees };
}

export { progressionCascade, cascadeEnAttente, type ProgressionCascade } from './travaux';
