import { and, avg, count, desc, eq, inArray, isNotNull, ne, type SQL } from 'drizzle-orm';
import {
	entryOrigins,
	journalEntries,
	members,
	reviews,
	workContents,
	works,
	type JournalEntry,
	type OrigineDeConsignation
} from '../db/schema';
import type { Db } from '../db';
import type { TypeOeuvre } from '../catalog/sources/types';
import { titresCorriges } from '../catalog/corrections';
import {
	estAtteinte,
	franchissement,
	type Etagere,
	type EtatDeLecture,
	type SensDeFranchissement
} from './atteinte';
import { signalerFranchissement } from './frontiere';
import {
	etatConsigne,
	journaliserAvis,
	journaliserNote,
	journaliserTransition,
	retracterAvis,
	retracterConsignation,
	signalerRecommandationSuivie
} from '../feed/events';
import { cascadeDescendante, etatLePlusAvance } from './contenance';
import { planifierCascade } from './travaux';
import {
	normaliserPosition,
	positionEffective,
	type MotifRefusPosition,
	type SaisieDePosition
} from './position';
import { publicationAutorisee } from '../masking/visibility';

/**
 * Le geste central du produit : consigner, noter, écrire un avis, retirer.
 *
 * **Ce module est le seul à écrire dans `journal_entries`.** C'est ce qui donne
 * son sens au point d'appel unique : chaque mutation d'état de lecture passe par
 * `noterLaTransition`, donc aucune surface ne peut oublier de notifier
 * les mécaniques qui en dépendent (U6, U7, U9). Une écriture directe depuis une
 * route ou depuis une autre unité contournerait la notification, et le défaut
 * serait silencieux — un graphe qui ne s'étend plus, un ordre qui n'avance plus,
 * sans aucun message d'erreur nulle part.
 *
 * **Il est aussi le seul à écrire dans `entry_origins`**, pour la même raison :
 * R34 lie la durée de vie d'une entrée au nombre de ses appuis, et séparer les
 * deux écritures reviendrait à autoriser une entrée dérivée sans appui — donc
 * une consignation fantôme qu'aucun retrait n'atteint. `journal/cascade.ts`
 * orchestre les lots ; il appelle `appliquerAppui` et `retirerAppui` ci-dessous
 * et n'écrit rien lui-même.
 *
 * **Rien ne lève d'exception pour un refus attendu.** Une œuvre inconnue, une
 * note invalide, un avis qui n'est pas le sien sont des réponses typées, comme
 * en U2 et U3a.
 *
 * **Les opérations sont désignées par le couple membre-œuvre, pas par
 * l'identifiant de l'entrée.** Ce n'est pas un détail de commodité : c'est ce
 * qui rend structurellement impossible d'agir sur la consignation d'un autre
 * par manipulation d'identifiant. Là où un identifiant est inévitable — l'avis,
 * que R37 désigne nommément — la propriété est vérifiée avant toute écriture, et
 * un avis qui n'appartient pas au membre est rapporté « introuvable » : lui dire
 * qu'il existe mais qu'il est refusé lui apprendrait déjà quelque chose.
 */

// ---------------------------------------------------------------------------
// Note (R4)
// ---------------------------------------------------------------------------

export const NOTE_MIN = 0.5;
export const NOTE_MAX = 5;

/**
 * Une note valide : de 0,5 à 5 étoiles, par demi-étoiles (R4).
 *
 * Zéro n'est pas une note mais une absence de note, et c'est `null` qui la
 * porte : accepter zéro donnerait deux façons de dire « je n'ai pas noté », dont
 * l'une entrerait dans l'agrégat du groupe et le tirerait vers le bas.
 */
export function noteValide(note: number): boolean {
	return (
		Number.isFinite(note) && note >= NOTE_MIN && note <= NOTE_MAX && Number.isInteger(note * 2)
	);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** La provenance d'une consignation (R42), telle que la surface la déclare. */
export type ProvenanceDeclaree =
	{ type: 'membre'; membreId: string } | { type: 'ordre'; ordreId: string } | { type: 'catalogue' };

export type MotifRefusJournal =
	| 'œuvre introuvable'
	| 'membre introuvable'
	| 'consignation introuvable'
	| 'note invalide'
	| 'avis introuvable'
	| 'avis vide'
	| 'avis déjà écrit'
	/** R25 — une œuvre longue non atteinte exige une position déclarée. */
	| 'position requise'
	| MotifRefusPosition;

export type ResultatConsignation =
	| {
			ok: true;
			entreeId: string;
			atteinte: boolean;
			/** Le sens franchi, ou `null` si la frontière n'a pas bougé. */
			franchissement: SensDeFranchissement | null;
	  }
	| { ok: false; motif: MotifRefusJournal };

export type ResultatRetrait =
	| {
			ok: true;
			franchissement: SensDeFranchissement | null;
			/** R33 — ce que le retrait a emporté avec lui. */
			noteSupprimee: boolean;
			avisSupprime: boolean;
			/**
			 * R34 — l'entrée a-t-elle survécu au retrait, parce qu'un recueil la
			 * soutient encore ? Le membre a besoin de le savoir : il vient de retirer
			 * une consignation et l'œuvre est toujours dans son journal.
			 */
			entreeConservee: boolean;
	  }
	| { ok: false; motif: MotifRefusJournal };

export type ResultatAvis = { ok: true; avisId: string } | { ok: false; motif: MotifRefusJournal };

export interface AvisDeJournal {
	id: string;
	texte: string;
	/** Figée à la rédaction initiale (R30) ; U6 s'en servira pour R29. */
	positionARedaction: number | null;
	ecritLe: number;
	misAJourLe: number;
}

export interface EntreeDeJournal {
	entreeId: string;
	membreId: string;
	oeuvre: { id: string; titre: string; type: TypeOeuvre; couvertureUrl: string | null };
	etagere: Etagere;
	abandonnee: boolean;
	/** Dérivé, jamais lu depuis la base (R3). */
	atteinte: boolean;
	/** La position effective de R24, dans [0, 1]. */
	position: number;
	positionDeclaree: number | null;
	longueurTotale: number | null;
	note: number | null;
	avis: AvisDeJournal | null;
	provenance: ProvenanceDeclaree;
	origine: OrigineDeConsignation;
	/**
	 * R10 — les recueils qui soutiennent cette entrée, nommément identifiés.
	 * Vide pour une consignation qu'aucun recueil ne couvre.
	 */
	recueils: string[];
	consigneeLe: number;
	misAJourLe: number;
}

// ---------------------------------------------------------------------------
// Écritures
// ---------------------------------------------------------------------------

/** L'état de lecture d'une entrée. La seule lecture de l'abandon dans ce module. */
function etatDe(entree: JournalEntry) {
	return { etagere: entree.shelf, abandonnee: entree.abandonedAt !== null };
}

/**
 * Le passage obligé de toute modification d'état de lecture.
 *
 * **Trois conséquences y sont tenues ensemble**, et c'est ce qui fait qu'aucune
 * ne peut être oubliée par une surface :
 *
 * 1. **la file de franchissement** (U4), pour les appuis du graphe (U9). Elle ne
 *    reçoit que les franchissements réels, comparés **par le prédicat** et jamais
 *    par les champs : passer de « terminé » à « abandonné » ne franchit rien ;
 * 2. **le fil du groupe** (U8, R41), qui reçoit au contraire *chaque* transition,
 *    franchissement ou non. Les deux besoins sont opposés — l'un veut l'état
 *    final, l'autre l'histoire — et c'est pourquoi le fil a sa propre table
 *    plutôt que de lire celle du graphe ;
 * 3. **la notification de R43**, quand et seulement quand la frontière est
 *    franchie dans le sens de l'atteinte et que la consignation venait d'un autre
 *    membre. R43 est explicite : c'est l'atteinte qui informe, pas la
 *    consignation.
 *
 * `pivotId` est ce que R43 agrège : le recueil quand l'atteinte vient d'une
 * cascade, l'œuvre elle-même sinon. C'est le seul paramètre par lequel la
 * cascade se distingue ici, et il ne sert qu'à ça.
 */
async function noterLaTransition(
	db: Db,
	membreId: string,
	oeuvreId: string,
	avant: JournalEntry | null,
	apres: JournalEntry | null,
	now: number,
	pivotId?: string
): Promise<SensDeFranchissement | null> {
	const sens = franchissement(
		avant === null ? null : etatDe(avant),
		apres === null ? null : etatDe(apres)
	);
	if (sens !== null) await signalerFranchissement(db, { membreId, oeuvreId, sens }, now);

	await journaliserTransition(db, {
		membreId,
		oeuvreId,
		avant: etatConsigne(avant),
		apres: etatConsigne(apres),
		now
	});

	// R42 conserve la provenance, R43 en tire une conséquence — et une seule.
	if (
		sens === 'atteinte' &&
		apres !== null &&
		apres.provenance === 'membre' &&
		apres.provenanceMemberId !== null
	) {
		await signalerRecommandationSuivie(db, {
			destinataireId: apres.provenanceMemberId,
			acteurId: membreId,
			oeuvrePivotId: pivotId ?? oeuvreId,
			now
		});
	}

	return sens;
}

async function entreeDe(db: Db, membreId: string, oeuvreId: string): Promise<JournalEntry | null> {
	const ligne = await db.query.journalEntries.findFirst({
		where: and(eq(journalEntries.memberId, membreId), eq(journalEntries.workId, oeuvreId))
	});
	return ligne ?? null;
}

/** Le type d'une œuvre, pour savoir si sa consignation cascade (R11). */
async function typeDOeuvre(db: Db, oeuvreId: string): Promise<TypeOeuvre | null> {
	const [ligne] = await db.select({ type: works.type }).from(works).where(eq(works.id, oeuvreId));
	return ligne?.type ?? null;
}

/** Les recueils qui soutiennent une entrée (R10). */
async function appuisDe(db: Db, entreeId: string): Promise<string[]> {
	const lignes = await db
		.select({ contenant: entryOrigins.containerWorkId })
		.from(entryOrigins)
		.where(eq(entryOrigins.entryId, entreeId));
	return lignes.map((l) => l.contenant);
}

/**
 * Planifie la cascade descendante d'un contenant, si c'en est un.
 *
 * Appelée après **chaque** geste de membre qui déplace l'état d'un contenant, et
 * seulement quand l'état a réellement bougé : c'est ce qui fait que « terminer un
 * omnibus » atteint ses quarante numéros sans qu'aucune surface n'ait à y penser.
 * R11 est vérifié ici et nulle part ailleurs — consigner une série de comics ne
 * planifie rien.
 */
async function planifierSiContenant(
	db: Db,
	membreId: string,
	oeuvreId: string,
	action: 'propager' | 'retirer',
	type: TypeOeuvre | null,
	now: number
): Promise<void> {
	if (type === null || !cascadeDescendante(type)) return;
	await planifierCascade(db, { membreId, contenantId: oeuvreId, action, now });
}

/**
 * R9, remontée — atteindre tous les numéros d'un recueil l'atteint.
 *
 * Distincte de la cascade descendante et volontairement plus étroite : elle ne
 * s'applique qu'aux contenants dont **toutes** les lignes de contenu sont
 * résolues et atteintes. Une ligne non encore résolue (`content_work_id` nul)
 * suffit à s'abstenir — un omnibus dont on ne connaît que trois numéros sur
 * quarante ne devient pas terminé parce qu'on a lu les trois.
 *
 * La remontée ne récurse pas : le contenant qu'elle atteint ne déclenche ni
 * cascade descendante — ses numéros sont déjà tous atteints par hypothèse — ni
 * remontée vers ses propres contenants. C'est un garde-fou contre des données
 * cycliques, que les sources produisent, et le cas d'un recueil de recueils dont
 * on aurait tout lu est trop rare pour justifier d'y risquer une récursion
 * infinie ; le rattrapage du Cron le couvre au passage suivant.
 */
async function remonterVersLesContenants(
	db: Db,
	membreId: string,
	oeuvreId: string,
	now: number
): Promise<void> {
	const contenants = await db
		.selectDistinct({ id: workContents.containerWorkId })
		.from(workContents)
		.where(
			and(eq(workContents.contentWorkId, oeuvreId), ne(workContents.containerWorkId, oeuvreId))
		)
		.limit(10);

	for (const { id: contenantId } of contenants) {
		const contenus = await db
			.select({ oeuvre: workContents.contentWorkId })
			.from(workContents)
			.where(eq(workContents.containerWorkId, contenantId));

		const resolus = contenus.map((c) => c.oeuvre).filter((id): id is string => id !== null);
		if (resolus.length === 0 || resolus.length !== contenus.length) continue;

		const entrees = await db.query.journalEntries.findMany({
			where: and(
				eq(journalEntries.memberId, membreId),
				inArray(journalEntries.workId, [...new Set(resolus)])
			)
		});
		const atteintes = new Set(entrees.filter((e) => estAtteinte(etatDe(e))).map((e) => e.workId));
		if (!resolus.every((id) => atteintes.has(id))) continue;

		const avant = await entreeDe(db, membreId, contenantId);
		if (avant !== null && estAtteinte(etatDe(avant))) continue;

		const [apres] = avant
			? await db
					.update(journalEntries)
					.set({ shelf: 'termine', abandonedAt: null, updatedAt: now })
					.where(eq(journalEntries.id, avant.id))
					.returning()
			: await db
					.insert(journalEntries)
					.values({
						memberId: membreId,
						workId: contenantId,
						shelf: 'termine',
						provenance: 'catalogue',
						// L'entrée n'est dérivée d'aucun recueil : c'est le membre qui a
						// atteint ce contenant, en lisant tout ce qu'il contient. R10 n'a
						// pas de troisième valeur à lui donner, et « directe » dit
						// exactement la bonne chose — aucun appui de recueil ne la soutient,
						// donc son retrait la supprime.
						origin: 'directe',
						createdAt: now,
						updatedAt: now
					})
					.returning();

		await noterLaTransition(db, membreId, contenantId, avant, apres, now);
	}
}

// ---------------------------------------------------------------------------
// Appuis d'origine (R10, R34) — les primitives que la cascade de U5 appelle
// ---------------------------------------------------------------------------

/**
 * L'état qu'une entrée dérivée doit prendre : le plus avancé de ses recueils
 * d'appui.
 *
 * Le calcul porte sur **tous** les appuis et non sur celui qu'on vient
 * d'ajouter ou de retirer, ce qui rend le résultat indépendant de l'ordre de
 * traitement des lots. C'est cette propriété, et pas le curseur de reprise, qui
 * fait qu'une cascade interrompue à mi-parcours reprend sans double effet.
 */
async function etatDerive(
	db: Db,
	membreId: string,
	contenantIds: string[]
): Promise<EtatDeLecture | null> {
	if (contenantIds.length === 0) return null;

	const entrees = await db.query.journalEntries.findMany({
		where: and(
			eq(journalEntries.memberId, membreId),
			inArray(journalEntries.workId, [...new Set(contenantIds)])
		)
	});

	return etatLePlusAvance(entrees.map(etatDe));
}

/**
 * Ajoute — ou réaffirme — l'appui d'un recueil sur une œuvre qu'il contient.
 *
 * Trois choses ici, et l'ordre compte moins que leur idempotence :
 *
 * 1. L'entrée dérivée est créée si elle n'existe pas, avec l'état du recueil ;
 * 2. l'appui est enregistré, sans doublon possible — deux recueils qui se
 *    chevauchent sur les numéros 5 et 6 produisent une seule entrée par numéro,
 *    avec deux appuis ;
 * 3. l'état est propagé **seulement si l'entrée n'a pas d'état propre**. Une
 *    entrée que le membre a posée lui-même porte `origin = 'directe'` et n'est
 *    jamais écrasée : consigner un omnibus ne remet pas en « en cours » un
 *    numéro que le membre avait terminé la semaine dernière.
 *
 * Rejouer cet appel sur un élément déjà traité ne produit rien — c'est ce qui
 * rend le fractionnement sûr.
 */
export async function appliquerAppui(
	db: Db,
	options: { membreId: string; oeuvreId: string; contenantId: string; now?: number }
): Promise<{ franchissement: SensDeFranchissement | null }> {
	const now = options.now ?? Date.now();

	// Une donnée de source où un recueil se contient lui-même existe, et la
	// laisser passer créerait une entrée que plus rien ne peut supprimer :
	// elle serait son propre appui.
	if (options.oeuvreId === options.contenantId) return { franchissement: null };

	const contenant = await entreeDe(db, options.membreId, options.contenantId);
	if (contenant === null) return { franchissement: null };

	const avant = await entreeDe(db, options.membreId, options.oeuvreId);
	const appuis = avant === null ? [] : await appuisDe(db, avant.id);
	const cible =
		(await etatDerive(db, options.membreId, [...appuis, options.contenantId])) ?? etatDe(contenant);

	let apres: JournalEntry;
	if (avant === null) {
		[apres] = await db
			.insert(journalEntries)
			.values({
				memberId: options.membreId,
				workId: options.oeuvreId,
				shelf: cible.etagere,
				abandonedAt: cible.abandonnee ? now : null,
				// La provenance du recueil est celle de ses numéros : c'est par lui
				// qu'ils sont arrivés dans le journal, et R43 doit informer le membre
				// qui l'a recommandé.
				provenance: contenant.provenance,
				provenanceMemberId: contenant.provenanceMemberId,
				provenanceOrderId: contenant.provenanceOrderId,
				origin: 'derivee',
				createdAt: now,
				updatedAt: now
			})
			.returning();
	} else if (avant.origin === 'derivee') {
		[apres] = await db
			.update(journalEntries)
			.set({
				shelf: cible.etagere,
				abandonedAt: cible.abandonnee ? (avant.abandonedAt ?? now) : null,
				updatedAt: now
			})
			.where(eq(journalEntries.id, avant.id))
			.returning();
	} else {
		apres = avant;
	}

	await db
		.insert(entryOrigins)
		.values({ entryId: apres.id, containerWorkId: options.contenantId, createdAt: now })
		.onConflictDoNothing();

	// Le recueil est le pivot de R43 : quarante numéros atteints par une même
	// cascade tiennent en une notification, pas quarante.
	const sens = await noterLaTransition(
		db,
		options.membreId,
		options.oeuvreId,
		avant,
		apres,
		now,
		options.contenantId
	);

	// Atteindre un numéro par cascade peut compléter un *autre* recueil que le
	// membre lisait en parallèle (R9, remontée).
	if (sens === 'atteinte') {
		await remonterVersLesContenants(db, options.membreId, options.oeuvreId, now);
	}

	return { franchissement: sens };
}

/**
 * R34 — retire l'appui d'un recueil, et ne supprime l'entrée que si plus aucune
 * source ne la soutient.
 *
 * C'est le piège que le plan annonce, sous la même forme qu'en U9 : supprimer
 * trop tôt. Un numéro dérivé de deux recueils survit au retrait de l'un des
 * deux ; un numéro consigné directement puis couvert par un recueil survit au
 * retrait du recueil, avec son origine directe intacte.
 */
export async function retirerAppui(
	db: Db,
	options: { membreId: string; oeuvreId: string; contenantId: string; now?: number }
): Promise<{ franchissement: SensDeFranchissement | null; entreeSupprimee: boolean }> {
	const now = options.now ?? Date.now();

	const avant = await entreeDe(db, options.membreId, options.oeuvreId);
	if (avant === null) return { franchissement: null, entreeSupprimee: false };

	await db
		.delete(entryOrigins)
		.where(
			and(eq(entryOrigins.entryId, avant.id), eq(entryOrigins.containerWorkId, options.contenantId))
		);

	const restants = await appuisDe(db, avant.id);

	if (restants.length === 0 && avant.origin === 'derivee') {
		await db.delete(reviews).where(eq(reviews.entryId, avant.id));
		await db.delete(journalEntries).where(eq(journalEntries.id, avant.id));

		const sens = await noterLaTransition(db, options.membreId, options.oeuvreId, avant, null, now);
		// L'entrée n'existe plus : le fil ne peut plus renvoyer vers elle (R33).
		await retracterConsignation(db, { membreId: options.membreId, oeuvreId: options.oeuvreId });
		return { franchissement: sens, entreeSupprimee: true };
	}

	// L'entrée reste. Son état se recalcule sur les appuis restants — sauf si le
	// membre l'a faite sienne, auquel cas plus aucun recueil ne la commande.
	let apres = avant;
	if (avant.origin === 'derivee') {
		const cible = await etatDerive(db, options.membreId, restants);
		if (cible !== null) {
			[apres] = await db
				.update(journalEntries)
				.set({
					shelf: cible.etagere,
					abandonedAt: cible.abandonnee ? (avant.abandonedAt ?? now) : null,
					updatedAt: now
				})
				.where(eq(journalEntries.id, avant.id))
				.returning();
		}
	}

	const sens = await noterLaTransition(db, options.membreId, options.oeuvreId, avant, apres, now);
	return { franchissement: sens, entreeSupprimee: false };
}

/**
 * Consigne une œuvre sur une étagère (R1), ou déplace une consignation
 * existante.
 *
 * Consigner deux fois la même œuvre ne crée pas une seconde entrée : le couple
 * membre-œuvre est unique, et la seconde consignation déplace l'étagère. C'est
 * la lecture littérale du vocabulaire — consigner, c'est poser sur une étagère —
 * et ça évite d'avoir à traiter deux entrées contradictoires pour le même couple
 * dans le masquage, les ordres et le graphe.
 *
 * **La provenance ne se réécrit pas** (R42). Elle est celle de la première
 * consignation : le membre qui a recommandé l'œuvre l'a recommandée, et une
 * reconsignation depuis le catalogue ne peut pas effacer ce fait sans casser
 * R43, qui veut l'informer quand l'œuvre est atteinte.
 *
 * **Poser explicitement une étagère lève l'abandon.** L'abandon est un état
 * distinct des trois étagères (R2), pas une quatrième position : y remettre une
 * œuvre, c'est reprendre sa lecture — c'est exactement R35, et le franchissement
 * en sens inverse est notifié comme tel.
 */
export async function consigner(
	db: Db,
	options: {
		membreId: string;
		oeuvreId: string;
		etagere?: Etagere;
		provenance?: ProvenanceDeclaree;
		now?: number;
	}
): Promise<ResultatConsignation> {
	const now = options.now ?? Date.now();
	const etagere = options.etagere ?? 'a_decouvrir';
	const provenance = options.provenance ?? { type: 'catalogue' };

	const oeuvre = await db.query.works.findFirst({ where: eq(works.id, options.oeuvreId) });
	if (!oeuvre) return { ok: false, motif: 'œuvre introuvable' };

	const membre = await db.query.members.findFirst({ where: eq(members.id, options.membreId) });
	if (!membre) return { ok: false, motif: 'membre introuvable' };

	if (provenance.type === 'membre') {
		const source = await db.query.members.findFirst({
			where: eq(members.id, provenance.membreId)
		});
		if (!source) return { ok: false, motif: 'membre introuvable' };
	}

	const avant = await entreeDe(db, options.membreId, options.oeuvreId);

	const [apres] = avant
		? await db
				.update(journalEntries)
				// `origin: 'directe'` est le point de U5 dans cette fonction : le membre
				// vient de poser lui-même l'étagère, l'entrée a désormais un état propre
				// et la propagation d'un recueil ne l'écrasera plus.
				.set({ shelf: etagere, abandonedAt: null, origin: 'directe', updatedAt: now })
				.where(eq(journalEntries.id, avant.id))
				.returning()
		: await db
				.insert(journalEntries)
				.values({
					memberId: options.membreId,
					workId: options.oeuvreId,
					shelf: etagere,
					provenance: provenance.type,
					provenanceMemberId: provenance.type === 'membre' ? provenance.membreId : null,
					provenanceOrderId: provenance.type === 'ordre' ? provenance.ordreId : null,
					origin: 'directe',
					createdAt: now,
					updatedAt: now
				})
				.returning();

	const sens = await noterLaTransition(db, options.membreId, options.oeuvreId, avant, apres, now);

	await apresGesteDeMembre(db, options.membreId, options.oeuvreId, oeuvre.type, avant, apres, now);

	return {
		ok: true,
		entreeId: apres.id,
		atteinte: estAtteinte(etatDe(apres)),
		franchissement: sens
	};
}

/**
 * Ce qu'un geste de membre entraîne au-delà de son entrée : la cascade
 * descendante (R9, R11) et la remontée (R9).
 *
 * Rassemblé en un seul endroit et appelé depuis chaque geste, pour la même
 * raison que le point d'appel unique de U4 : une surface qui oublierait
 * l'appel produirait un omnibus terminé dont aucun numéro ne bouge, sans le
 * moindre message d'erreur.
 *
 * **La cascade n'est planifiée que si l'état a réellement changé.** Le comparer
 * par le prédicat ne suffit pas ici — passer de « à découvrir » à « en cours »
 * ne franchit aucune frontière mais doit bien descendre aux numéros — donc la
 * comparaison porte sur l'étagère et l'abandon.
 */
async function apresGesteDeMembre(
	db: Db,
	membreId: string,
	oeuvreId: string,
	type: TypeOeuvre | null,
	avant: JournalEntry | null,
	apres: JournalEntry,
	now: number
): Promise<void> {
	const change =
		avant === null || avant.shelf !== apres.shelf || avant.abandonedAt !== apres.abandonedAt;
	if (!change) return;

	await planifierSiContenant(db, membreId, oeuvreId, 'propager', type, now);

	if (estAtteinte(etatDe(apres))) {
		await remonterVersLesContenants(db, membreId, oeuvreId, now);
	}
}

/**
 * Abandonne une œuvre (R2). L'abandon **atteint** l'œuvre (R3) et n'exige ni
 * note ni avis — le dire dans le code serait déjà de trop, c'est l'absence de
 * toute vérification qui le garantit.
 *
 * L'étagère sous l'abandon est conservée : elle dit où le membre en était, et
 * c'est elle qu'il retrouve s'il reprend.
 */
export async function abandonner(
	db: Db,
	options: { membreId: string; oeuvreId: string; now?: number }
): Promise<ResultatConsignation> {
	const now = options.now ?? Date.now();
	const avant = await entreeDe(db, options.membreId, options.oeuvreId);
	if (!avant) return { ok: false, motif: 'consignation introuvable' };

	const [apres] = await db
		.update(journalEntries)
		.set({ abandonedAt: avant.abandonedAt ?? now, origin: 'directe', updatedAt: now })
		.where(eq(journalEntries.id, avant.id))
		.returning();

	const sens = await noterLaTransition(db, options.membreId, options.oeuvreId, avant, apres, now);

	await apresGesteDeMembre(
		db,
		options.membreId,
		options.oeuvreId,
		await typeDOeuvre(db, options.oeuvreId),
		avant,
		apres,
		now
	);

	return {
		ok: true,
		entreeId: apres.id,
		atteinte: estAtteinte(etatDe(apres)),
		franchissement: sens
	};
}

/**
 * R35 — un membre reprend une œuvre abandonnée : elle repasse en cours et cesse
 * d'être atteinte, avec les conséquences correspondantes sur le masquage, les
 * ordres et le graphe.
 *
 * Vaut aussi pour une œuvre terminée qu'on se remet à lire. La position déclarée
 * n'est pas effacée : elle redevient simplement la position effective (R24), et
 * le membre retrouve où il en était.
 */
export async function reprendre(
	db: Db,
	options: { membreId: string; oeuvreId: string; now?: number }
): Promise<ResultatConsignation> {
	const now = options.now ?? Date.now();
	const avant = await entreeDe(db, options.membreId, options.oeuvreId);
	if (!avant) return { ok: false, motif: 'consignation introuvable' };

	const [apres] = await db
		.update(journalEntries)
		.set({ shelf: 'en_cours', abandonedAt: null, origin: 'directe', updatedAt: now })
		.where(eq(journalEntries.id, avant.id))
		.returning();

	const sens = await noterLaTransition(db, options.membreId, options.oeuvreId, avant, apres, now);

	await apresGesteDeMembre(
		db,
		options.membreId,
		options.oeuvreId,
		await typeDOeuvre(db, options.oeuvreId),
		avant,
		apres,
		now
	);

	return {
		ok: true,
		entreeId: apres.id,
		atteinte: estAtteinte(etatDe(apres)),
		franchissement: sens
	};
}

/**
 * Déclare l'avancement dans une œuvre longue (R23).
 *
 * La saisie est normalisée à l'entrée : ce qui est stocké est une fraction, que
 * la saisie ait été faite en pages ou en pourcentage. C'est ce qui rendra R29
 * calculable en U6, entre deux membres qui n'ont pas saisi dans la même unité.
 *
 * Déclarer une position sur une œuvre « à découvrir » la passe **en cours** :
 * R24 dit que la position d'une œuvre non commencée est nulle, donc la déclarer
 * sans commencer l'œuvre serait un geste sans effet, que rien à l'écran
 * n'expliquerait. Le déplacement ne franchit aucune frontière — les deux
 * étagères sont hors atteinte.
 */
export async function declarerPosition(
	db: Db,
	options: { membreId: string; oeuvreId: string; saisie: SaisieDePosition; now?: number }
): Promise<ResultatConsignation> {
	const now = options.now ?? Date.now();
	const entree = await entreeDe(db, options.membreId, options.oeuvreId);
	if (!entree) return { ok: false, motif: 'consignation introuvable' };

	const normalisee = normaliserPosition(options.saisie, { longueurTotale: entree.totalLength });
	if (!normalisee.ok) return { ok: false, motif: normalisee.motif };

	const [apres] = await db
		.update(journalEntries)
		.set({
			declaredPosition: normalisee.position,
			totalLength: normalisee.longueurTotale ?? entree.totalLength,
			shelf: entree.shelf === 'a_decouvrir' ? 'en_cours' : entree.shelf,
			// Déclarer où l'on en est dans une œuvre est un geste de lecture : à
			// partir de là, l'entrée a un état propre que le recueil ne commande plus.
			origin: 'directe',
			updatedAt: now
		})
		.where(eq(journalEntries.id, entree.id))
		.returning();

	const sens = await noterLaTransition(db, options.membreId, options.oeuvreId, entree, apres, now);

	await apresGesteDeMembre(
		db,
		options.membreId,
		options.oeuvreId,
		await typeDOeuvre(db, options.oeuvreId),
		entree,
		apres,
		now
	);

	return {
		ok: true,
		entreeId: apres.id,
		atteinte: estAtteinte(etatDe(apres)),
		franchissement: sens
	};
}

/**
 * Note une œuvre consignée (R4), ou retire la note en passant `null` (R37).
 *
 * Indépendante de l'avis : l'un n'exige pas l'autre (R5). Indépendante de
 * l'atteinte aussi — on note une œuvre abandonnée à mi-parcours, et R2 dit
 * expressément que l'abandon n'exige pas de note.
 */
export async function noter(
	db: Db,
	options: { membreId: string; oeuvreId: string; note: number | null; now?: number }
): Promise<ResultatConsignation> {
	const now = options.now ?? Date.now();
	if (options.note !== null && !noteValide(options.note)) {
		return { ok: false, motif: 'note invalide' };
	}

	const entree = await entreeDe(db, options.membreId, options.oeuvreId);
	if (!entree) return { ok: false, motif: 'consignation introuvable' };

	await db
		.update(journalEntries)
		.set({ rating: options.note, updatedAt: now })
		.where(eq(journalEntries.id, entree.id));

	// R41 — la note est l'un des sept événements du fil. Elle n'a pas sa place
	// dans `noterLaTransition` : elle ne déplace aucun état de lecture, et l'y
	// faire entrer obligerait cette fonction à comparer des champs qui ne
	// regardent ni le graphe ni R43.
	await journaliserNote(db, {
		membreId: options.membreId,
		oeuvreId: options.oeuvreId,
		note: options.note,
		now
	});

	// Noter ne touche ni à l'étagère ni à l'abandon : aucune frontière ne bouge.
	return {
		ok: true,
		entreeId: entree.id,
		atteinte: estAtteinte(etatDe(entree)),
		franchissement: null
	};
}

/**
 * R33 — retire une consignation, et emporte la note et l'avis attachés.
 *
 * Le recul de la progression des ordres et la rétraction du graphe sont les deux
 * autres conséquences exigées ; elles appartiennent à U7 et U9 et arrivent par
 * le franchissement notifié ici. La progression n'étant jamais stockée, elle
 * recule d'elle-même ; le graphe, lui, est matérialisé et a besoin de la
 * demande.
 *
 * L'avis est supprimé explicitement plutôt que par cascade de clé étrangère :
 * R33 est une règle du produit, pas un détail de moteur, et une cascade la
 * rendrait invisible dans le code comme dans les tests.
 *
 * **R34 borne ce que le retrait emporte.** Retirer une consignation directe ne
 * supprime l'entrée que si plus aucun recueil ne la soutient. Sinon l'entrée
 * repasse en dérivée, reprend l'état de ses recueils d'appui, et perd sa note et
 * son avis — le membre a bien retiré *sa* consignation, mais l'omnibus qu'il est
 * en train de lire contient toujours ce numéro. Supprimer l'entrée ici la ferait
 * réapparaître au passage suivant du Cron, ce qui est le pire des deux mondes.
 */
export async function retirer(
	db: Db,
	options: { membreId: string; oeuvreId: string; now?: number }
): Promise<ResultatRetrait> {
	const now = options.now ?? Date.now();
	const entree = await entreeDe(db, options.membreId, options.oeuvreId);
	if (!entree) return { ok: false, motif: 'consignation introuvable' };

	const avis = await db.query.reviews.findFirst({ where: eq(reviews.entryId, entree.id) });
	const appuis = await appuisDe(db, entree.id);
	const type = await typeDOeuvre(db, options.oeuvreId);

	await db.delete(reviews).where(eq(reviews.entryId, entree.id));

	let apres: JournalEntry | null = null;
	if (appuis.length > 0) {
		const cible = (await etatDerive(db, options.membreId, appuis)) ?? etatDe(entree);
		[apres] = await db
			.update(journalEntries)
			.set({
				shelf: cible.etagere,
				abandonedAt: cible.abandonnee ? (entree.abandonedAt ?? now) : null,
				rating: null,
				origin: 'derivee',
				updatedAt: now
			})
			.where(eq(journalEntries.id, entree.id))
			.returning();
	} else {
		await db.delete(entryOrigins).where(eq(entryOrigins.entryId, entree.id));
		await db.delete(journalEntries).where(eq(journalEntries.id, entree.id));
	}

	const sens = await noterLaTransition(db, options.membreId, options.oeuvreId, entree, apres, now);

	// L'entrée du contenant a disparu : ses numéros perdent l'appui qu'elle leur
	// donnait, et ceux que plus rien ne soutient s'en vont avec elle. Quarante
	// numéros ne tiennent pas dans une requête, d'où la file (KTD2).
	if (apres === null) {
		await planifierSiContenant(db, options.membreId, options.oeuvreId, 'retirer', type, now);
	} else {
		await apresGesteDeMembre(db, options.membreId, options.oeuvreId, type, entree, apres, now);
	}

	// R33 — le fil oublie ce que la consignation y avait mis, y compris la note et
	// l'avis que le retrait vient d'emporter. Après les effets de cascade, pour
	// qu'aucun d'eux ne réécrive ce qu'on vient d'effacer.
	await retracterConsignation(db, { membreId: options.membreId, oeuvreId: options.oeuvreId });

	return {
		ok: true,
		franchissement: sens,
		noteSupprimee: entree.rating !== null,
		avisSupprime: avis !== undefined,
		entreeConservee: apres !== null
	};
}

// ---------------------------------------------------------------------------
// Avis (R5, R30, R37)
// ---------------------------------------------------------------------------

/**
 * Écrit un avis en texte libre (R5), au plus un par œuvre consignée.
 *
 * La position de l'auteur est figée maintenant, et ne bougera plus (R30) :
 * `modifierAvis` n'y touche pas. Sans ce gel, un membre qui corrige une faute
 * de frappe après avoir fini l'œuvre re-masquerait rétroactivement son texte à
 * tous ceux qui l'avaient déjà lu.
 *
 * R25 — la position est obligatoire avant de publier sur une œuvre longue non
 * atteinte — est **décidée** par `masking/visibility.ts` et seulement appliquée
 * ici. La règle appartient au masquage : la position qu'elle exige n'a d'autre
 * usage que la comparaison de R29. Mais l'écriture des avis passe par cette
 * fonction et par elle seule, donc c'est le seul endroit où l'appliquer une fois
 * suffit à l'appliquer partout.
 */
export async function ecrireAvis(
	db: Db,
	options: { membreId: string; oeuvreId: string; texte: string; now?: number }
): Promise<ResultatAvis> {
	const now = options.now ?? Date.now();
	if (options.texte.trim() === '') return { ok: false, motif: 'avis vide' };

	const entree = await entreeDe(db, options.membreId, options.oeuvreId);
	if (!entree) return { ok: false, motif: 'consignation introuvable' };

	const existant = await db.query.reviews.findFirst({ where: eq(reviews.entryId, entree.id) });
	if (existant) return { ok: false, motif: 'avis déjà écrit' };

	const type = await typeDOeuvre(db, options.oeuvreId);
	if (
		type !== null &&
		!publicationAutorisee({
			typeOeuvre: type,
			atteinte: estAtteinte(etatDe(entree)),
			positionDeclaree: entree.declaredPosition
		})
	) {
		return { ok: false, motif: 'position requise' };
	}

	const [ligne] = await db
		.insert(reviews)
		.values({
			entryId: entree.id,
			body: options.texte,
			positionAtWriting: positionEffective(etatDe(entree), entree.declaredPosition),
			createdAt: now,
			updatedAt: now
		})
		.returning({ id: reviews.id });

	// R41 — le fil dit qu'un avis existe. Le texte, lui, ne quitte pas cette
	// fonction : `journaliserAvis` n'a pas de paramètre pour le recevoir.
	await journaliserAvis(db, { membreId: options.membreId, oeuvreId: options.oeuvreId, now });

	return { ok: true, avisId: ligne.id };
}

/**
 * R37 — un membre modifie son propre avis.
 *
 * La position enregistrée n'est pas recalculée : c'est celle de la rédaction
 * initiale (R30).
 */
export async function modifierAvis(
	db: Db,
	options: { membreId: string; avisId: string; texte: string; now?: number }
): Promise<ResultatAvis> {
	const now = options.now ?? Date.now();
	if (options.texte.trim() === '') return { ok: false, motif: 'avis vide' };

	const avis = await avisPossede(db, options.membreId, options.avisId);
	if (!avis) return { ok: false, motif: 'avis introuvable' };

	await db
		.update(reviews)
		.set({ body: options.texte, updatedAt: now })
		.where(eq(reviews.id, options.avisId));

	return { ok: true, avisId: options.avisId };
}

/** R37 — un membre supprime son propre avis, sans perdre sa consignation ni sa note. */
export async function supprimerAvis(
	db: Db,
	options: { membreId: string; avisId: string }
): Promise<ResultatAvis> {
	const avis = await avisPossede(db, options.membreId, options.avisId);
	if (!avis) return { ok: false, motif: 'avis introuvable' };

	await db.delete(reviews).where(eq(reviews.id, options.avisId));
	// L'avis n'existe plus : le fil ne peut plus annoncer qu'il a été écrit.
	await retracterAvis(db, { membreId: options.membreId, oeuvreId: avis.oeuvreId });

	return { ok: true, avisId: options.avisId };
}

/**
 * L'avis désigné, s'il appartient bien à ce membre.
 *
 * Un avis qui existe mais appartient à quelqu'un d'autre est traité comme
 * inexistant : c'est la seule vérification, elle est faite avant toute écriture,
 * et elle ne renvoie pas d'information différente selon le cas.
 */
async function avisPossede(db: Db, membreId: string, avisId: string) {
	const [ligne] = await db
		// L'œuvre est rendue avec l'avis parce que R37 désigne l'avis par son
		// identifiant alors que le fil, lui, désigne toujours un couple
		// membre-œuvre. La jointure existe déjà : la lire ne coûte rien.
		.select({ id: reviews.id, oeuvreId: journalEntries.workId })
		.from(reviews)
		.innerJoin(journalEntries, eq(journalEntries.id, reviews.entryId))
		.where(and(eq(reviews.id, avisId), eq(journalEntries.memberId, membreId)));
	return ligne ?? null;
}

// ---------------------------------------------------------------------------
// Lectures
// ---------------------------------------------------------------------------

/** La consignation d'un membre sur une œuvre, telle que les surfaces la lisent. */
export async function lireConsignation(
	db: Db,
	membreId: string,
	oeuvreId: string
): Promise<EntreeDeJournal | null> {
	const entrees = await lireEntrees(
		db,
		and(eq(journalEntries.memberId, membreId), eq(journalEntries.workId, oeuvreId))
	);
	return entrees[0] ?? null;
}

/**
 * Où en est un membre sur un lot d'œuvres — l'état, et rien que l'état.
 *
 * C'est ce dont une grille d'affiches a besoin pour se lire d'un coup d'œil :
 * chaque affiche doit dire si l'œuvre est **atteinte**, seulement **consignée**,
 * ou sur aucune étagère. Sans ça, une page de recherche montre quarante
 * couvertures dont on ne sait rien, ce qui est exactement l'interface que le
 * produit ne veut pas.
 *
 * **Une requête pour tout le lot**, pas une par affiche : une recherche en rend
 * quarante, et quarante allers-retours ne tiennent pas dans les 10 ms d'une
 * invocation.
 *
 * Rien ici ne passe par le masquage et rien n'a à y passer : un membre lit son
 * propre journal, et R27 ne porte que sur les textes des autres.
 */
export interface EtatDuMembre {
	etagere: Etagere;
	abandonnee: boolean;
	atteinte: boolean;
	/** La position effective de R24, dans [0, 1]. */
	position: number;
	note: number | null;
}

export async function etatsDuMembre(
	db: Db,
	membreId: string,
	oeuvreIds: readonly string[]
): Promise<Map<string, EtatDuMembre>> {
	const ids = [...new Set(oeuvreIds)];
	if (ids.length === 0) return new Map();

	const entrees = await db.query.journalEntries.findMany({
		where: and(eq(journalEntries.memberId, membreId), inArray(journalEntries.workId, ids))
	});

	return new Map(
		entrees.map((entree) => {
			const etat = etatDe(entree);
			return [
				entree.workId,
				{
					etagere: entree.shelf,
					abandonnee: etat.abandonnee,
					atteinte: estAtteinte(etat),
					position: positionEffective(etat, entree.declaredPosition),
					note: entree.rating
				}
			];
		})
	);
}

/**
 * R6 — le journal d'un membre : ce qu'il consigne, ses notes, ses avis.
 *
 * Les ordres qu'il suit et ceux qu'il a créés complètent la page ; ils
 * appartiennent à U7.
 */
export async function lireJournal(
	db: Db,
	membreId: string,
	options: { etagere?: Etagere } = {}
): Promise<EntreeDeJournal[]> {
	const filtre =
		options.etagere === undefined
			? eq(journalEntries.memberId, membreId)
			: and(eq(journalEntries.memberId, membreId), eq(journalEntries.shelf, options.etagere));

	return lireEntrees(db, filtre);
}

/**
 * Un avis tel que la page d'une œuvre en a besoin : le texte **brut**, et de
 * quoi le signer.
 *
 * La forme satisfait `ContenuMasquable` de `masking/visibility.ts`, et c'est le
 * point : ce que cette fonction rend n'est pas sérialisable tel quel. Elle lit
 * la table, la règle décide, la surface affiche — trois étapes, trois modules,
 * et aucun raccourci possible entre le premier et le troisième.
 */
export interface AvisDOeuvre {
	id: string;
	oeuvreId: string;
	auteurId: string;
	auteurNom: string;
	/** R38 — un membre parti reste auteur de son avis, mais sans son nom. */
	auteurParti: boolean;
	/** R28 — la note ne traverse pas le masquage, elle l'ignore. */
	note: number | null;
	texte: string;
	/** Figée à la rédaction initiale (R30). C'est elle que R29 compare. */
	positionARedaction: number | null;
	ecritLe: number;
	misAJourLe: number;
}

/**
 * Tous les avis écrits sur une œuvre, par tout le groupe.
 *
 * **Rien ici ne masque quoi que ce soit**, et c'est délibéré : mêler la lecture
 * et la règle donnerait deux endroits où la règle vit. L'appelant passe le
 * résultat à `masquer`, et `surfaces.test.ts` vérifie qu'il le fait.
 */
export async function lireAvisDOeuvre(db: Db, oeuvreId: string): Promise<AvisDOeuvre[]> {
	const lignes = await db
		.select({ avis: reviews, entree: journalEntries, membre: members })
		.from(reviews)
		.innerJoin(journalEntries, eq(journalEntries.id, reviews.entryId))
		.innerJoin(members, eq(members.id, journalEntries.memberId))
		.where(eq(journalEntries.workId, oeuvreId))
		.orderBy(desc(reviews.createdAt), desc(reviews.id));

	return lignes.map(({ avis, entree, membre }) => ({
		id: avis.id,
		oeuvreId: entree.workId,
		auteurId: entree.memberId,
		auteurNom: membre.displayName,
		auteurParti: membre.leftAt !== null,
		note: entree.rating,
		texte: avis.body,
		positionARedaction: avis.positionAtWriting,
		ecritLe: avis.createdAt,
		misAJourLe: avis.updatedAt
	}));
}

/**
 * R26 — qui du groupe a atteint l'œuvre, qui est en train de la lire, et où il
 * en est.
 *
 * Aucun masquage : l'avancement d'un membre dans une œuvre n'est pas un texte,
 * et R28 comme R26 le veulent visible. Ce qu'on apprend en le lisant — que
 * quelqu'un est à 60 % — ne révèle rien de l'intrigue.
 */
export interface LecteurDOeuvre {
	membreId: string;
	nom: string;
	parti: boolean;
	etagere: Etagere;
	abandonnee: boolean;
	atteinte: boolean;
	position: number;
	note: number | null;
}

export async function lecteursDOeuvre(db: Db, oeuvreId: string): Promise<LecteurDOeuvre[]> {
	const lignes = await db
		.select({ entree: journalEntries, membre: members })
		.from(journalEntries)
		.innerJoin(members, eq(members.id, journalEntries.memberId))
		.where(eq(journalEntries.workId, oeuvreId))
		.orderBy(desc(journalEntries.updatedAt), desc(journalEntries.id));

	return lignes.map(({ entree, membre }) => {
		const etat = etatDe(entree);
		return {
			membreId: entree.memberId,
			nom: membre.displayName,
			parti: membre.leftAt !== null,
			etagere: entree.shelf,
			abandonnee: etat.abandonnee,
			atteinte: estAtteinte(etat),
			position: positionEffective(etat, entree.declaredPosition),
			note: entree.rating
		};
	});
}

/**
 * L'assemblage commun, en quatre requêtes quelle que soit la taille du journal.
 *
 * Le nombre de requêtes est constant et non proportionnel au nombre d'entrées :
 * un membre qui a consigné trois cents numéros — ce que le document d'origine
 * décrit comme le rythme normal d'un lecteur de comics — ne doit pas coûter
 * trois cents allers-retours dans les 10 ms d'une invocation.
 */
async function lireEntrees(db: Db, filtre: SQL | undefined): Promise<EntreeDeJournal[]> {
	const lignes = await db
		// La couverture voyage avec le type, dans la jointure qui existe déjà : un
		// journal se lit en grille d'affiches, et une grille sans image n'est
		// qu'une liste à puces déguisée.
		.select({ entree: journalEntries, type: works.type, couvertureUrl: works.coverUrl })
		.from(journalEntries)
		.innerJoin(works, eq(works.id, journalEntries.workId))
		.where(filtre)
		.orderBy(desc(journalEntries.updatedAt), desc(journalEntries.id));

	if (lignes.length === 0) return [];

	const [titres, avis, appuis] = await Promise.all([
		titresCorriges(
			db,
			lignes.map((l) => l.entree.workId)
		),
		db.query.reviews.findMany({
			where: inArray(
				reviews.entryId,
				lignes.map((l) => l.entree.id)
			)
		}),
		db
			.select({ entree: entryOrigins.entryId, contenant: entryOrigins.containerWorkId })
			.from(entryOrigins)
			.where(
				inArray(
					entryOrigins.entryId,
					lignes.map((l) => l.entree.id)
				)
			)
	]);

	const parEntree = new Map(avis.map((a) => [a.entryId, a]));
	const recueilsParEntree = new Map<string, string[]>();
	for (const { entree, contenant } of appuis) {
		const liste = recueilsParEntree.get(entree);
		if (liste) liste.push(contenant);
		else recueilsParEntree.set(entree, [contenant]);
	}

	return lignes.map(({ entree, type, couvertureUrl }) => {
		const etat = etatDe(entree);
		const ecrit = parEntree.get(entree.id);

		return {
			entreeId: entree.id,
			membreId: entree.memberId,
			oeuvre: { id: entree.workId, titre: titres.get(entree.workId) ?? '', type, couvertureUrl },
			etagere: entree.shelf,
			abandonnee: etat.abandonnee,
			atteinte: estAtteinte(etat),
			position: positionEffective(etat, entree.declaredPosition),
			positionDeclaree: entree.declaredPosition,
			longueurTotale: entree.totalLength,
			note: entree.rating,
			avis: ecrit
				? {
						id: ecrit.id,
						texte: ecrit.body,
						positionARedaction: ecrit.positionAtWriting,
						ecritLe: ecrit.createdAt,
						misAJourLe: ecrit.updatedAt
					}
				: null,
			provenance: provenanceDe(entree),
			origine: entree.origin,
			recueils: recueilsParEntree.get(entree.id) ?? [],
			consigneeLe: entree.createdAt,
			misAJourLe: entree.updatedAt
		};
	});
}

function provenanceDe(entree: JournalEntry): ProvenanceDeclaree {
	if (entree.provenance === 'membre' && entree.provenanceMemberId !== null) {
		return { type: 'membre', membreId: entree.provenanceMemberId };
	}
	if (entree.provenance === 'ordre' && entree.provenanceOrderId !== null) {
		return { type: 'ordre', ordreId: entree.provenanceOrderId };
	}
	return { type: 'catalogue' };
}

// ---------------------------------------------------------------------------
// Agrégats (R13)
// ---------------------------------------------------------------------------

export interface Agregat {
	/** `null` quand personne n'a noté : zéro serait une note, et une mauvaise. */
	noteMoyenne: number | null;
	nombreDeNotes: number;
	nombreDAvis: number;
}

/**
 * R13 — les notes et les avis s'agrègent au niveau de l'œuvre consignée.
 *
 * C'est aussi l'agrégat propre d'un recueil, distinct de celui de ses numéros :
 * un omnibus se note pour ce qu'il est, sélection et édition comprises.
 *
 * R28 en fera la donnée qui traverse toujours le masquage : les notes, leur
 * agrégat et le nombre d'avis ne sont jamais masqués — seuls les textes le sont.
 */
export async function agregatDOeuvre(db: Db, oeuvreId: string): Promise<Agregat> {
	return agregatSur(db, eq(journalEntries.workId, oeuvreId));
}

/**
 * R13 — la page d'une série affiche l'agrégat de ses numéros.
 *
 * L'œuvre de type `serie` elle-même est exclue : elle porte le même
 * `seriesEntityId` que ses numéros (c'est ainsi que U3a modélise
 * l'appartenance), mais sa propre note est celle de la série prise comme un
 * tout, pas une note de numéro. La compter reviendrait à faire peser un avis
 * global au même poids qu'un numéro, et à la faire apparaître deux fois sur la
 * page qui affiche les deux.
 */
export async function agregatDeSerie(db: Db, serieEntityId: string): Promise<Agregat> {
	const numeros = db
		.select({ id: works.id })
		.from(works)
		.where(and(eq(works.seriesEntityId, serieEntityId), ne(works.type, 'serie')));

	return agregatSur(db, inArray(journalEntries.workId, numeros));
}

async function agregatSur(db: Db, filtre: SQL): Promise<Agregat> {
	const [notes] = await db
		.select({
			moyenne: avg(journalEntries.rating),
			nombre: count(journalEntries.rating)
		})
		.from(journalEntries)
		.where(and(filtre, isNotNull(journalEntries.rating)));

	const [avis] = await db
		.select({ nombre: count() })
		.from(reviews)
		.innerJoin(journalEntries, eq(journalEntries.id, reviews.entryId))
		.where(filtre);

	return {
		noteMoyenne: notes.moyenne === null ? null : Number(notes.moyenne),
		nombreDeNotes: notes.nombre,
		nombreDAvis: avis.nombre
	};
}
