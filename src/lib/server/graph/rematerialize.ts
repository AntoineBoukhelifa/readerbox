import { and, eq, inArray } from 'drizzle-orm';
import { entities, graphEdgeSupports, graphEdges, journalEntries } from '../db/schema';
import type { Db } from '../db';
import { lireOeuvre } from '../catalog/corrections';
import { enAttente, marquerTraitees } from '../catalog/rematerialisation';
import { estAtteinte } from '../journal/atteinte';
import {
	FILTRE_SQL_NON_ATTEINTE,
	liensEtablis,
	ordonner,
	rejouerAppuis,
	type AreteDuGraphe,
	type LienEtabli
} from './materialize';
import { franchissementsEnAttente, marquerFranchissementsTraites } from '../journal/frontiere';

/**
 * Les deux déclencheurs de KTD4, le fractionnement, et le recalcul complet.
 *
 * **Deux files, pas une**, et U4 comme U3a ont posé les deux séparément parce
 * que leur grain diffère :
 *
 * - `reach_crossings` porte un couple **membre-œuvre** dont l'état de lecture a
 *   bougé — consignation, abandon, reprise, retrait (R1, R2, R33, R35). Un seul
 *   graphe est concerné ;
 * - `graph_rematerializations` porte une **œuvre** dont les rattachements ont
 *   changé — correction de fiche (R47), ré-ingestion (R39), fusion de doublons.
 *   Tous les membres qui l'ont atteinte sont concernés.
 *
 * **Sans la seconde, un personnage ajouté à une œuvre déjà atteinte
 * n'apparaîtrait jamais dans aucun graphe** — silencieusement, et
 * définitivement, puisque aucun état de lecture ne bougera plus jamais pour
 * cette œuvre. C'est un défaut qu'une revue a rattrapé, et c'est la raison
 * d'être de la moitié de ce fichier.
 *
 * **Pourquoi tout est ici et pas sur le chemin de rendu.** Une re-matérialisation
 * touche autant de graphes qu'il y a de membres ayant atteint l'œuvre, et une
 * cascade de recueil produit quarante franchissements d'un coup : ni l'un ni
 * l'autre ne tient dans les 10 ms de temps processeur d'une requête (KTD2). Le
 * travail est donc fractionné par lots, comme les cascades de U5, et repris par
 * le Cron Trigger — seul ordonnanceur du palier gratuit.
 */

/** Combien de rejeux un lot traite par défaut. Même ordre de grandeur qu'en U5. */
export const TAILLE_DE_LOT = 10;

export interface ResumeMaterialisation {
	/** Franchissements de frontière traités (premier déclencheur). */
	franchissements: number;
	/** Demandes de re-matérialisation traitées (second déclencheur). */
	rematerialisations: number;
	/** Couples membre-œuvre rejoués, tous déclencheurs confondus. */
	rejeux: number;
	/**
	 * Ce qui reste en file, les deux confondues. **Plafonné** : c'est un signal de
	 * reprise pour le Cron, pas un décompte — compter exactement une file qu'on
	 * vient de raccourcir coûterait un balayage complet à chaque lot.
	 */
	restantes: number;
}

/**
 * Traite au plus `budget` rejeux, les franchissements d'abord.
 *
 * L'ordre n'est pas indifférent : un franchissement est le geste le plus
 * fréquent du produit et le plus visible pour celui qui vient de le faire, alors
 * qu'une correction de fiche peut attendre le lot suivant sans que personne ne
 * s'en aperçoive.
 *
 * **Une demande de re-matérialisation n'est jamais coupée en deux.** Le budget
 * peut donc être légèrement dépassé, et c'est délibéré : traiter la moitié des
 * membres puis marquer la demande traitée laisserait l'autre moitié avec un
 * graphe faux, sans trace et sans rattrapage possible.
 *
 * **Chaque élément est marqué traité juste après son rejeu**, pas à la fin du
 * lot. Une invocation qui meurt en cours de route laisse donc les éléments
 * restants en file, et ceux qui étaient déjà faits sont sans effet s'ils sont
 * rejoués — le rejeu lit l'état final. C'est aussi ce qui réduit au minimum la
 * fenêtre pendant laquelle une nouvelle demande sur la même ligne serait
 * absorbée par l'unicité partielle puis marquée traitée sans avoir été vue.
 */
export async function materialiserGraphe(
	db: Db,
	options: { budget?: number; now?: number } = {}
): Promise<ResumeMaterialisation> {
	const budget = options.budget ?? TAILLE_DE_LOT;
	const now = options.now ?? Date.now();

	let restant = budget;
	let franchissements = 0;
	let rematerialisations = 0;
	let rejeux = 0;

	for (const franchissement of await franchissementsEnAttente(db, Math.max(restant, 1))) {
		if (restant <= 0) break;
		await rejouerAppuis(db, {
			membreId: franchissement.memberId,
			oeuvreId: franchissement.workId,
			now
		});
		await marquerFranchissementsTraites(db, [franchissement.id], now);
		franchissements += 1;
		rejeux += 1;
		restant -= 1;
	}

	if (restant > 0) {
		for (const demande of await enAttente(db, Math.max(restant, 1))) {
			if (restant <= 0) break;
			const rejoues = await rejouerPourTousLesMembres(db, demande.workId, now);
			await marquerTraitees(db, [demande.id], now);
			rematerialisations += 1;
			rejeux += rejoues;
			// Une demande sans aucun membre concerné a quand même coûté une lecture :
			// la compter pour zéro ferait boucler le lot sur une file de demandes
			// vides sans jamais épuiser son budget.
			restant -= Math.max(rejoues, 1);
		}
	}

	const restantes = (await franchissementsEnAttente(db)).length + (await enAttente(db)).length;

	return { franchissements, rematerialisations, rejeux, restantes };
}

/**
 * Rejoue les appuis d'une œuvre pour tous les membres concernés (KTD4, second
 * déclencheur).
 *
 * L'œuvre est lue **une seule fois** : sa dérivation ne dépend pas du membre,
 * seule l'atteinte en dépend. Vingt membres coûtent donc une lecture de fiche,
 * pas vingt.
 *
 * Les membres concernés sont ceux qui ont une entrée de journal sur l'œuvre —
 * atteinte ou non, puisqu'une entrée non atteinte doit voir ses appuis rester
 * absents — **et** ceux qui portent encore des appuis dessus. Le second ensemble
 * n'est pas redondant : c'est lui qui nettoie un appui resté en place alors que
 * l'entrée a disparu.
 */
async function rejouerPourTousLesMembres(db: Db, oeuvreId: string, now: number): Promise<number> {
	const liens = liensEtablis(await lireOeuvre(db, oeuvreId));

	const membres = new Set<string>();
	for (const ligne of await db
		.select({ membreId: journalEntries.memberId })
		.from(journalEntries)
		.where(eq(journalEntries.workId, oeuvreId))) {
		membres.add(ligne.membreId);
	}
	for (const ligne of await db
		.select({ membreId: graphEdges.memberId })
		.from(graphEdgeSupports)
		.innerJoin(graphEdges, eq(graphEdges.id, graphEdgeSupports.edgeId))
		.where(eq(graphEdgeSupports.workId, oeuvreId))) {
		membres.add(ligne.membreId);
	}

	for (const membreId of membres) {
		await rejouerAppuis(db, { membreId, oeuvreId, liensSiAtteinte: liens, now });
	}

	return membres.size;
}

/**
 * Déroule les deux files jusqu'à ce qu'il n'y ait plus rien, par lots successifs.
 *
 * C'est ce que le Cron Trigger appelle — un handler planifié dispose de bien
 * plus que les 10 ms d'une requête — et ce que les tests appellent pour observer
 * l'état final. `maxPasses` est un garde-fou : une file qui ne se vide pas est un
 * défaut, et boucler indéfiniment le rendrait invisible.
 */
export async function deroulerGraphe(
	db: Db,
	options: { budget?: number; maxPasses?: number; now?: number } = {}
): Promise<ResumeMaterialisation> {
	const maxPasses = options.maxPasses ?? 200;

	let franchissements = 0;
	let rematerialisations = 0;
	let rejeux = 0;
	let restantes = 0;

	for (let passe = 0; passe < maxPasses; passe += 1) {
		const resume = await materialiserGraphe(db, options);
		franchissements += resume.franchissements;
		rematerialisations += resume.rematerialisations;
		rejeux += resume.rejeux;
		restantes = resume.restantes;
		if (resume.franchissements === 0 && resume.rematerialisations === 0) break;
	}

	return { franchissements, rematerialisations, rejeux, restantes };
}

// ---------------------------------------------------------------------------
// Recalcul complet et rattrapage
// ---------------------------------------------------------------------------

/**
 * Le graphe qu'un membre **devrait** avoir, calculé depuis zéro et sans rien
 * écrire.
 *
 * C'est l'oracle : il ne partage aucun chemin de code avec la matérialisation
 * incrémentale — il part du journal et du catalogue, pas des tables du graphe —
 * de sorte qu'un défaut de la matérialisation ne puisse pas se cacher dans les
 * deux à la fois.
 *
 * Son coût est proportionnel au nombre d'œuvres atteintes, sept requêtes
 * chacune : il appartient au Cron Trigger et aux tests, **jamais au chemin de
 * rendu**.
 */
export async function grapheAttendu(db: Db, membreId: string): Promise<AreteDuGraphe[]> {
	const oeuvres = await oeuvresAtteintes(db, membreId);

	const parCle = new Map<string, { lien: LienEtabli; appuis: string[] }>();
	for (const oeuvreId of oeuvres) {
		for (const lien of liensEtablis(await lireOeuvre(db, oeuvreId))) {
			const k = `${lien.relation} ${lien.entiteId}`;
			const existant = parCle.get(k);
			if (existant) existant.appuis.push(oeuvreId);
			else parCle.set(k, { lien, appuis: [oeuvreId] });
		}
	}

	const entiteIds = [...new Set([...parCle.values()].map((e) => e.lien.entiteId))];
	const noms = new Map(
		entiteIds.length === 0
			? []
			: (await db.query.entities.findMany({ where: inArray(entities.id, entiteIds) })).map(
					(entite) => [entite.id, entite.name] as const
				)
	);

	return ordonner(
		[...parCle.values()].map(({ lien, appuis }) => ({
			relation: lien.relation,
			entiteId: lien.entiteId,
			nom: noms.get(lien.entiteId) ?? '',
			appuis
		}))
	);
}

/** Les œuvres qu'un membre a atteintes, par le prédicat et non par les colonnes. */
async function oeuvresAtteintes(db: Db, membreId: string): Promise<string[]> {
	const entrees = await db.query.journalEntries.findMany({
		where: eq(journalEntries.memberId, membreId)
	});
	return entrees
		.filter((entree) =>
			estAtteinte({ etagere: entree.shelf, abandonnee: entree.abandonedAt !== null })
		)
		.map((entree) => entree.workId);
}

export interface ResumeRecalcul {
	/** Couples membre-œuvre rejoués. */
	rejeux: number;
	/** Écritures que le recalcul a dû faire. Zéro quand rien n'avait divergé. */
	corrections: number;
}

/**
 * Recalcule intégralement le graphe d'un membre, et n'écrit que ce qui diffère.
 *
 * **Convergent plutôt que destructeur**, et c'est la seule forme tenable : tout
 * effacer pour tout réécrire coûterait, pour un membre à trois cents œuvres
 * atteintes, plusieurs milliers de lignes à chaque passage — le plafond de
 * 100 000 écritures quotidiennes de D1 serait atteint par le rattrapage seul,
 * alors qu'il n'a en général rien à corriger. Ici, un graphe déjà juste ne coûte
 * que des lectures.
 *
 * Le balayage porte sur l'union des œuvres atteintes et des œuvres qui portent
 * encore un appui : la seconde moitié est ce qui retire un appui devenu orphelin.
 */
export async function recalculerGraphe(
	db: Db,
	membreId: string,
	options: { now?: number } = {}
): Promise<ResumeRecalcul> {
	const now = options.now ?? Date.now();

	const oeuvres = new Set(await oeuvresAtteintes(db, membreId));
	for (const ligne of await db
		.selectDistinct({ oeuvreId: graphEdgeSupports.workId })
		.from(graphEdgeSupports)
		.innerJoin(graphEdges, eq(graphEdges.id, graphEdgeSupports.edgeId))
		.where(eq(graphEdges.memberId, membreId))) {
		oeuvres.add(ligne.oeuvreId);
	}

	let corrections = 0;
	for (const oeuvreId of oeuvres) {
		const resume = await rejouerAppuis(db, { membreId, oeuvreId, now });
		corrections += resume.poses + resume.retires;
	}

	return { rejeux: oeuvres.size, corrections };
}

/**
 * Le rattrapage : les appuis restés en place alors que l'œuvre n'est plus
 * atteinte.
 *
 * C'est la seule divergence que les files ne peuvent pas rattraper d'elles-mêmes,
 * et c'est la dangereuse — un appui de trop laisse une arête visible que R52
 * interdit, donc un lien révélé par une œuvre que le membre n'a pas atteinte.
 * L'autre sens, un appui manquant, ne fait que retarder l'apparition d'une arête
 * et ne peut pas se perdre : une demande n'est marquée traitée qu'après son
 * rejeu, donc une invocation interrompue la laisse en file.
 *
 * Le balayage est **borné** : il tourne à chaque passage du Cron et n'a pas à
 * tout voir d'un coup. Ce qu'il ne voit pas ce tour-ci, il le verra au suivant.
 */
export async function rattraperGraphe(
	db: Db,
	options: { limite?: number; now?: number } = {}
): Promise<{ rejoues: number }> {
	const limite = options.limite ?? 50;
	const now = options.now ?? Date.now();

	const couples = await db
		.selectDistinct({ membreId: graphEdges.memberId, oeuvreId: graphEdgeSupports.workId })
		.from(graphEdgeSupports)
		.innerJoin(graphEdges, eq(graphEdges.id, graphEdgeSupports.edgeId))
		.leftJoin(
			journalEntries,
			and(
				eq(journalEntries.memberId, graphEdges.memberId),
				eq(journalEntries.workId, graphEdgeSupports.workId)
			)
		)
		.where(FILTRE_SQL_NON_ATTEINTE)
		.limit(limite);

	for (const { membreId, oeuvreId } of couples) {
		await rejouerAppuis(db, { membreId, oeuvreId, now });
	}

	return { rejoues: couples.length };
}

export { grapheDuMembre, liensEtablis, rejouerAppuis, type AreteDuGraphe } from './materialize';
