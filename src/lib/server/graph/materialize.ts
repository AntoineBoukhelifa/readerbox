import { and, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
import {
	entities,
	graphEdgeSupports,
	graphEdges,
	journalEntries,
	type TypeDeRelation
} from '../db/schema';
import type { Db } from '../db';
import { lireOeuvre, type OeuvreLocale } from '../catalog/corrections';
import { estAtteinte } from '../journal/atteinte';

/**
 * La matérialisation du graphe, par membre et à l'écriture (KTD4).
 *
 * **Pourquoi matérialiser plutôt que calculer au rendu.** Un parcours de graphe
 * au moment d'afficher la page ne tient pas dans les 10 ms de temps processeur
 * d'une requête Cloudflare, et ce n'est même pas la raison principale : R52
 * exige qu'une arête n'apparaisse pas quand le lien qu'elle porte n'est établi
 * que par une œuvre non atteinte, **y compris lorsque ses deux nœuds figurent
 * déjà dans le graphe par ailleurs**. Un calcul au rendu part des nœuds visibles
 * et invite à les joindre ; matérialiser à l'écriture rend la garantie
 * structurelle — l'arête n'est pas cachée, elle n'existe pas.
 *
 * **Ce module ne connaît qu'un seul geste : rejouer les appuis d'une œuvre pour
 * un membre.** Les deux déclencheurs de KTD4 s'y ramènent tous les deux, et
 * `rematerialize.ts` les branche :
 *
 * | déclencheur | file | ce qu'on rejoue |
 * | --- | --- | --- |
 * | franchissement de la frontière « atteint » (R33, R35) | `reach_crossings` | ce couple membre-œuvre |
 * | modification des rattachements (R47, R39, fusion) | `graph_rematerializations` | cette œuvre, pour tous ses membres |
 *
 * Le rejeu lit l'**état final** — l'œuvre est-elle atteinte, quels sont ses
 * rattachements aujourd'hui — et jamais un delta. C'est ce qui le rend
 * idempotent, donc fractionnable et reprenable après interruption, exactement
 * comme la cascade de U5.
 *
 * **La dérivation lit l'œuvre corrigée, pas la couche de source.** Sans ça le
 * second déclencheur ne servirait à rien : une correction de membre (R47) qui
 * ajoute un personnage oublié n'apparaîtrait dans aucun graphe, silencieusement
 * et définitivement.
 */

/** Un lien établi par une œuvre : le type de relation et le nœud d'entité visé. */
export interface LienEtabli {
	relation: TypeDeRelation;
	entiteId: string;
}

/**
 * La règle de dérivation de KTD4, et rien d'autre. Fonction pure : c'est elle
 * qui porte la règle, et c'est elle qu'on teste sans base.
 *
 * Une œuvre atteinte établit trois familles de liens :
 *
 * - **personnage** — un lien vers chaque personnage crédité ;
 * - **série** — un lien vers sa série de rattachement ;
 * - **event** — un lien vers son event de rattachement, quand il existe.
 *
 * La cardinalité est **linéaire** dans le nombre de crédits : un numéro à vingt
 * personnages produit vingt liens de type personnage, pas cent quatre-vingt-dix.
 * Relier les personnages deux à deux donnerait un graphe visuellement plus riche
 * et une facture quadratique par membre, sans rien apporter que le partage d'un
 * même appui ne dise déjà.
 *
 * Les créateurs n'établissent rien : ce sont des entités du catalogue, pas des
 * nœuds du graphe (R49, R50).
 */
export function liensEtablis(oeuvre: OeuvreLocale | null): LienEtabli[] {
	if (oeuvre === null) return [];

	const liens: LienEtabli[] = [];
	if (oeuvre.serie !== null) liens.push({ relation: 'serie', entiteId: oeuvre.serie.entityId });
	if (oeuvre.event !== null) liens.push({ relation: 'event', entiteId: oeuvre.event.entityId });
	for (const personnage of oeuvre.personnages) {
		liens.push({ relation: 'personnage', entiteId: personnage.entityId });
	}

	// Le même personnage crédité deux fois — deux sources qui le nomment, une
	// correction qui le rajoute alors qu'il y était — ne fait qu'un seul lien.
	// `lireOeuvre` dédoublonne déjà ; on ne s'en remet pas à elle, parce qu'une
	// arête en double serait un appui fantôme que plus rien ne retirerait.
	const vus = new Set<string>();
	return liens.filter((lien) => {
		const k = cle(lien);
		if (vus.has(k)) return false;
		vus.add(k);
		return true;
	});
}

/**
 * La clé d'un lien, pour le dédoublonnage en mémoire.
 *
 * Le séparateur est écrit en échappement et non en octet littéral. Un caractère
 * de contrôle posé tel quel dans la source rend le fichier binaire aux yeux de
 * git — plus de diff, plus de blâme, plus de revue — et n'importe quel outil qui
 * normalise le texte peut le supprimer sans que rien ne le signale, ce qui
 * changerait le format des clés en silence.
 *
 * Il reste choisi pour ne pouvoir apparaître ni dans un type de relation, qui
 * vient d'une énumération fermée, ni dans un identifiant, qui est un UUID.
 */
function cle(lien: LienEtabli): string {
	return `${lien.relation}\0${lien.entiteId}`;
}

// ---------------------------------------------------------------------------
// Rejeu des appuis
// ---------------------------------------------------------------------------

export interface ResumeAppuis {
	/** Appuis posés — des liens que cette œuvre établit et qui manquaient. */
	poses: number;
	/** Appuis retirés — des liens qu'elle n'établit plus, ou plus pour ce membre. */
	retires: number;
	aretesCreees: number;
	/** Arêtes supprimées faute d'appui : c'est la garantie de R52 en action. */
	aretesSupprimees: number;
}

/**
 * Aligne les appuis d'une œuvre, pour un membre, sur ce que l'état courant
 * exige. Le seul geste d'écriture du graphe.
 *
 * Trois cas, un seul chemin :
 *
 * - l'œuvre est atteinte et ses rattachements ont bougé → les appuis manquants
 *   sont posés, ceux qui ne correspondent plus sont retirés ;
 * - l'œuvre cesse d'être atteinte (R33, R35) → tous ses appuis sont retirés ;
 * - rien n'a bougé → rien n'est écrit. Ce n'est pas une optimisation de confort :
 *   les appuis sont par membre, et réécrire à l'identique à chaque passage du
 *   Cron épuiserait les 100 000 lignes quotidiennes de D1 sans rien changer.
 *
 * **Une arête n'est supprimée que lorsqu'elle perd son dernier appui.** C'est le
 * piège que le plan annonce sous deux noms — les origines de consignation de U5,
 * les appuis d'arête ici : supprimer trop tôt. Un personnage vu dans deux œuvres
 * atteintes reste dans le graphe quand on en retire une.
 *
 * `liensSiAtteinte` permet à l'appelant qui rejoue une même œuvre pour plusieurs
 * membres de ne la lire qu'une fois — `lireOeuvre` coûte sept requêtes.
 */
export async function rejouerAppuis(
	db: Db,
	options: {
		membreId: string;
		oeuvreId: string;
		/** La dérivation de l'œuvre, quand l'appelant l'a déjà calculée. */
		liensSiAtteinte?: LienEtabli[];
		now?: number;
	}
): Promise<ResumeAppuis> {
	const now = options.now ?? Date.now();

	// L'atteinte se lit par le prédicat de `journal/atteinte.ts`, jamais sur les
	// colonnes : c'est le seul endroit où la frontière est définie, et trois
	// réimplémentations finiraient par se contredire.
	const atteinte = await oeuvreAtteinte(db, options.membreId, options.oeuvreId);
	const cibles = atteinte
		? (options.liensSiAtteinte ?? liensEtablis(await lireOeuvre(db, options.oeuvreId)))
		: [];

	const courants = await appuisDeLOeuvre(db, options.membreId, options.oeuvreId);

	const attendus = new Set(cibles.map(cle));
	const presents = new Set(courants.map(cle));

	const aRetirer = courants.filter((appui) => !attendus.has(cle(appui)));
	const aPoser = cibles.filter((lien) => !presents.has(cle(lien)));

	let aretesSupprimees = 0;
	if (aRetirer.length > 0) {
		const touchees = aRetirer.map((appui) => appui.areteId);
		await db
			.delete(graphEdgeSupports)
			.where(
				and(
					eq(graphEdgeSupports.workId, options.oeuvreId),
					inArray(graphEdgeSupports.edgeId, touchees)
				)
			);
		aretesSupprimees = await purgerLesAretesSansAppui(db, touchees);
	}

	let aretesCreees = 0;
	if (aPoser.length > 0) {
		const aretes = await assurerLesAretes(db, options.membreId, aPoser, now);
		aretesCreees = aretes.creees;
		await db
			.insert(graphEdgeSupports)
			.values(
				aPoser.map((lien) => ({
					edgeId: aretes.parCle.get(cle(lien)) as string,
					workId: options.oeuvreId,
					createdAt: now
				}))
			)
			.onConflictDoNothing();
	}

	return { poses: aPoser.length, retires: aRetirer.length, aretesCreees, aretesSupprimees };
}

/** R3 — ce membre a-t-il atteint cette œuvre ? Une entrée absente vaut « non ». */
async function oeuvreAtteinte(db: Db, membreId: string, oeuvreId: string): Promise<boolean> {
	const entree = await db.query.journalEntries.findFirst({
		where: and(eq(journalEntries.memberId, membreId), eq(journalEntries.workId, oeuvreId))
	});
	if (!entree) return false;
	return estAtteinte({ etagere: entree.shelf, abandonnee: entree.abandonedAt !== null });
}

/**
 * Le filtre SQL des couples **non atteints**, pour le rattrapage.
 *
 * C'est la seule réécriture du prédicat de `journal/atteinte.ts` dans tout le
 * projet, et elle n'existe que parce qu'un rattrapage borné doit filtrer en base
 * plutôt que ramener toutes les lignes. Un test dédié compare les deux sur les
 * quatre états possibles : le jour où l'un bouge sans l'autre, il échoue.
 */
export const FILTRE_SQL_NON_ATTEINTE: SQL = or(
	isNull(journalEntries.id),
	and(ne(journalEntries.shelf, 'termine'), isNull(journalEntries.abandonedAt))
) as SQL;

/** Les appuis que cette œuvre pose aujourd'hui dans le graphe de ce membre. */
async function appuisDeLOeuvre(
	db: Db,
	membreId: string,
	oeuvreId: string
): Promise<{ areteId: string; relation: TypeDeRelation; entiteId: string }[]> {
	return db
		.select({
			areteId: graphEdges.id,
			relation: graphEdges.relation,
			entiteId: graphEdges.entityId
		})
		.from(graphEdgeSupports)
		.innerJoin(graphEdges, eq(graphEdges.id, graphEdgeSupports.edgeId))
		.where(and(eq(graphEdgeSupports.workId, oeuvreId), eq(graphEdges.memberId, membreId)));
}

/**
 * Retrouve — ou crée — les arêtes qui portent ces liens.
 *
 * Les arêtes existantes sont relues plutôt que réécrites en `on conflict do
 * update` : une écriture inutile coûte une ligne du quota quotidien, et le cas
 * courant est justement celui où l'arête existe déjà, parce qu'une autre œuvre
 * atteinte l'a établie avant.
 *
 * L'unicité `(membre, relation, entité)` est portée par l'index, donc deux
 * invocations concurrentes ne peuvent pas créer un doublon : la seconde échoue,
 * sa demande reste en file, et le rejeu suivant la traite.
 */
async function assurerLesAretes(
	db: Db,
	membreId: string,
	liens: LienEtabli[],
	now: number
): Promise<{ parCle: Map<string, string>; creees: number }> {
	const entiteIds = [...new Set(liens.map((lien) => lien.entiteId))];

	const existantes = await db
		.select({ id: graphEdges.id, relation: graphEdges.relation, entiteId: graphEdges.entityId })
		.from(graphEdges)
		.where(and(eq(graphEdges.memberId, membreId), inArray(graphEdges.entityId, entiteIds)));

	const parCle = new Map(existantes.map((arete) => [cle(arete), arete.id]));
	const manquantes = liens.filter((lien) => !parCle.has(cle(lien)));

	if (manquantes.length > 0) {
		const inserees = await db
			.insert(graphEdges)
			.values(
				manquantes.map((lien) => ({
					memberId: membreId,
					relation: lien.relation,
					entityId: lien.entiteId,
					createdAt: now
				}))
			)
			.returning({
				id: graphEdges.id,
				relation: graphEdges.relation,
				entiteId: graphEdges.entityId
			});
		for (const arete of inserees) parCle.set(cle(arete), arete.id);
	}

	return { parCle, creees: manquantes.length };
}

/** Supprime, parmi les arêtes touchées, celles qui ont perdu leur dernier appui. */
async function purgerLesAretesSansAppui(db: Db, areteIds: string[]): Promise<number> {
	const restants = await db
		.select({ areteId: graphEdgeSupports.edgeId })
		.from(graphEdgeSupports)
		.where(inArray(graphEdgeSupports.edgeId, areteIds));

	const soutenues = new Set(restants.map((ligne) => ligne.areteId));
	const vides = areteIds.filter((id) => !soutenues.has(id));

	if (vides.length > 0) await db.delete(graphEdges).where(inArray(graphEdges.id, vides));
	return vides.length;
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/**
 * Une arête du graphe d'un membre, telle que U10 la lira.
 *
 * `appuis` est ce que R53 demande — les œuvres atteintes qui ont établi le
 * nœud — et c'est aussi ce qui porte l'adjacence sans la stocker : deux arêtes
 * partageant un appui désignent deux entités vues dans la même œuvre. C'est la
 * « double appartenance au même nœud d'œuvre » de KTD4, et c'est ce qui dispense
 * de matérialiser les co-apparitions deux à deux.
 */
export interface AreteDuGraphe {
	relation: TypeDeRelation;
	entiteId: string;
	nom: string;
	/** Les œuvres atteintes qui l'établissent (R53). Jamais vide. */
	appuis: string[];
}

/**
 * Le graphe matérialisé d'un membre — une lecture indexée, rien de plus.
 *
 * La jointure sur les appuis n'est pas un détail de forme : elle rend une arête
 * sans appui invisible **par construction**, ce qui est la garantie de R52 au
 * niveau de la lecture. Une ligne d'arête orpheline, si un défaut en laissait
 * une, ne pourrait pas fuir dans un graphe.
 *
 * Le résultat est trié de façon déterministe pour que deux graphes se comparent
 * — c'est ce dont le test d'oracle a besoin, et ce qu'un affichage stable veut.
 */
export async function grapheDuMembre(
	db: Db,
	membreId: string,
	options: { relations?: TypeDeRelation[] } = {}
): Promise<AreteDuGraphe[]> {
	const filtre =
		options.relations === undefined
			? eq(graphEdges.memberId, membreId)
			: and(eq(graphEdges.memberId, membreId), inArray(graphEdges.relation, options.relations));

	const lignes = await db
		.select({
			relation: graphEdges.relation,
			entiteId: graphEdges.entityId,
			nom: entities.name,
			appui: graphEdgeSupports.workId
		})
		.from(graphEdges)
		.innerJoin(entities, eq(entities.id, graphEdges.entityId))
		.innerJoin(graphEdgeSupports, eq(graphEdgeSupports.edgeId, graphEdges.id))
		.where(filtre);

	const parCle = new Map<string, AreteDuGraphe>();
	for (const ligne of lignes) {
		const k = cle(ligne);
		const arete = parCle.get(k);
		if (arete) arete.appuis.push(ligne.appui);
		else {
			parCle.set(k, {
				relation: ligne.relation,
				entiteId: ligne.entiteId,
				nom: ligne.nom,
				appuis: [ligne.appui]
			});
		}
	}

	return ordonner([...parCle.values()]);
}

/** L'ordre canonique d'un graphe : relation, nom, identité, appuis. */
export function ordonner(aretes: AreteDuGraphe[]): AreteDuGraphe[] {
	for (const arete of aretes) arete.appuis.sort();
	return aretes.sort(
		(a, b) =>
			a.relation.localeCompare(b.relation) ||
			a.nom.localeCompare(b.nom) ||
			a.entiteId.localeCompare(b.entiteId)
	);
}
