import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
	feedEvents,
	journalEntries,
	members,
	notifications,
	orders,
	type JournalEntry,
	type TypeEvenement
} from '../db/schema';
import type { Db } from '../db';
import { titresCorriges } from '../catalog/corrections';
import type { Etagere } from '../journal/atteinte';
import type { OrigineDeConsignation } from '../db/schema';

/**
 * Le fil d'activité du groupe (R41), ses notifications (R43) et la provenance
 * qu'il affiche (R42).
 *
 * **Pourquoi ce module écrit ses propres événements.** U4 a posé une file de
 * franchissement, et elle ne peut pas servir ici : `journal/frontiere.ts` ne
 * garde qu'une ligne en attente par couple membre-œuvre, portant le dernier sens
 * franchi, et l'écrase à chaque geste. C'est ce qui rend le rejeu du graphe
 * correct — les appuis d'une œuvre sont présents si et seulement si elle est
 * atteinte, donc seul l'état final compte — et c'est exactement ce qui la rend
 * inutilisable pour un fil, qui a besoin de **chaque** transition. Deux
 * transitions successives sur la même œuvre sont deux lignes ici et une seule
 * là-bas.
 *
 * **Ce module ne décide rien de ce qui est visible.** Le titre d'une œuvre passe
 * par `masking/visibility.ts` (R32), et le texte d'un avis n'entre jamais ici :
 * la table n'a pas de colonne pour le porter, donc le fil ne peut pas le servir
 * même par accident. Ce n'est pas de la discipline, c'est la forme des données.
 *
 * **Les lectures rendent des titres bruts**, comme `lireAvisDOeuvre` rend des
 * textes bruts : la surface passe le lot à la règle de masquage avant de
 * sérialiser. C'est le partage établi par U6 — le module lit, la règle décide, la
 * surface affiche — et le tordre ici en ferait deux.
 */

// ---------------------------------------------------------------------------
// Ce qu'une transition produit
// ---------------------------------------------------------------------------

/** L'état d'une consignation, réduit à ce dont le fil a besoin. */
export interface EtatConsigne {
	etagere: Etagere;
	abandonnee: boolean;
	positionDeclaree: number | null;
	origine: OrigineDeConsignation;
}

export interface Transition {
	type: Extract<TypeEvenement, 'consignation' | 'avancement' | 'abandon'>;
	etagere: Etagere | null;
	position: number | null;
}

/**
 * L'événement qu'un passage de `avant` à `apres` produit, ou rien.
 *
 * Pure et sans base : c'est le cœur du fil, et il se lit d'un bloc.
 *
 * **Une entrée dérivée ne produit aucun événement**, et c'est la décision la
 * plus lourde de ce fichier. Terminer un omnibus de quarante numéros écrit
 * quarante entrées dérivées ; les journaliser noierait le fil du groupe sous
 * quarante lignes identiques à chaque geste d'un seul membre, et le rendrait
 * illisible précisément le jour où il devient vivant. Le recueil, lui, produit
 * son événement : « Camille a terminé un recueil » dit tout ce qu'il y avait à
 * dire. C'est le même arbitrage que R43 fait explicitement pour les
 * notifications, appliqué à la surface voisine.
 *
 * Le corollaire tient : dès qu'un membre touche lui-même une entrée dérivée,
 * `journal/entries.ts` la repasse en `directe` et elle recommence à parler.
 *
 * Un `apres` nul ne produit rien non plus : un retrait ne s'ajoute pas au fil,
 * il en **retire** ce qui y était (R33, voir `retracterConsignation`).
 */
export function transition(
	avant: EtatConsigne | null,
	apres: EtatConsigne | null
): Transition | null {
	if (apres === null) return null;
	if (apres.origine === 'derivee') return null;

	if (avant === null || avant.origine === 'derivee') {
		if (apres.abandonnee) return { type: 'abandon', etagere: apres.etagere, position: null };
		// Une entrée dérivée que le membre fait sienne est une consignation : c'est
		// le premier geste qu'il pose sur cette œuvre.
		return { type: 'consignation', etagere: apres.etagere, position: null };
	}

	if (!avant.abandonnee && apres.abandonnee) {
		return { type: 'abandon', etagere: apres.etagere, position: null };
	}

	// R35 — reprendre est un avancement qui porte l'étagère retrouvée. Le fil n'a
	// pas de type « reprise » parce que R41 n'en nomme pas, et parce que
	// « Antoine a repris sa lecture » se lit dans l'étagère, pas dans le type.
	if (avant.etagere !== apres.etagere || (avant.abandonnee && !apres.abandonnee)) {
		return { type: 'avancement', etagere: apres.etagere, position: null };
	}

	if (apres.positionDeclaree !== null && apres.positionDeclaree !== avant.positionDeclaree) {
		return { type: 'avancement', etagere: null, position: apres.positionDeclaree };
	}

	return null;
}

/** L'état d'une ligne de journal, tel que le fil le lit. */
export function etatConsigne(entree: JournalEntry | null): EtatConsigne | null {
	if (entree === null) return null;
	return {
		etagere: entree.shelf,
		abandonnee: entree.abandonedAt !== null,
		positionDeclaree: entree.declaredPosition,
		origine: entree.origin
	};
}

// ---------------------------------------------------------------------------
// Écritures
// ---------------------------------------------------------------------------

/**
 * Journalise le passage d'un état de consignation à un autre.
 *
 * Appelée par `journal/entries.ts` depuis le même point que la file de
 * franchissement — un seul endroit dans tout le produit où l'état de lecture
 * change, donc un seul endroit d'où le fil se remplit. Une surface qui écrirait
 * dans `journal_entries` sans passer par là manquerait à la fois le graphe et le
 * fil, et le défaut serait muet.
 */
export async function journaliserTransition(
	db: Db,
	options: {
		membreId: string;
		oeuvreId: string;
		avant: EtatConsigne | null;
		apres: EtatConsigne | null;
		now: number;
	}
): Promise<void> {
	const evenement = transition(options.avant, options.apres);
	if (evenement === null) return;

	await db.insert(feedEvents).values({
		memberId: options.membreId,
		type: evenement.type,
		workId: options.oeuvreId,
		shelf: evenement.etagere,
		position: evenement.position,
		createdAt: options.now
	});
}

/**
 * R4, R41 — une note posée.
 *
 * **Au plus une ligne de note par couple membre-œuvre**, contrairement aux
 * avancements. La différence n'est pas une commodité : un avancement raconte une
 * lecture qui progresse et chaque étape a valeur d'histoire, alors qu'une note
 * est un jugement qui n'en a qu'une — la dernière. Un membre qui hésite entre
 * quatre et cinq étoiles produirait sinon une file de lignes contradictoires sur
 * la même œuvre, et le fil du groupe n'y survivrait pas.
 *
 * Retirer la note (R37) efface la ligne au lieu d'annoncer le retrait :
 * « Camille a retiré sa note » n'intéresse personne, et garder l'ancienne
 * afficherait une note que le membre a justement reprise.
 */
export async function journaliserNote(
	db: Db,
	options: { membreId: string; oeuvreId: string; note: number | null; now: number }
): Promise<void> {
	await db
		.delete(feedEvents)
		.where(
			and(
				eq(feedEvents.memberId, options.membreId),
				eq(feedEvents.workId, options.oeuvreId),
				eq(feedEvents.type, 'note')
			)
		);

	if (options.note === null) return;

	await db.insert(feedEvents).values({
		memberId: options.membreId,
		type: 'note',
		workId: options.oeuvreId,
		rating: options.note,
		createdAt: options.now
	});
}

/**
 * R5, R41 — un avis a été écrit.
 *
 * L'événement dit **qu'il existe**, jamais ce qu'il dit. C'est structurel : la
 * table n'a pas de colonne de texte, donc aucune lecture du fil ne peut en
 * servir un, même en s'y prenant mal. Qui veut lire l'avis va sur la page de
 * l'œuvre, où R27 décide — et refuse tant que l'œuvre n'est pas atteinte.
 *
 * Modifier un avis ne produit rien : c'est le même avis, et R30 tient justement
 * à ce qu'une modification ne rejoue pas le passé.
 */
export async function journaliserAvis(
	db: Db,
	options: { membreId: string; oeuvreId: string; now: number }
): Promise<void> {
	await db.insert(feedEvents).values({
		memberId: options.membreId,
		type: 'avis',
		workId: options.oeuvreId,
		createdAt: options.now
	});
}

/** R37 — l'avis supprimé quitte le fil avec le reste. */
export async function retracterAvis(
	db: Db,
	options: { membreId: string; oeuvreId: string }
): Promise<void> {
	await db
		.delete(feedEvents)
		.where(
			and(
				eq(feedEvents.memberId, options.membreId),
				eq(feedEvents.workId, options.oeuvreId),
				eq(feedEvents.type, 'avis')
			)
		);
}

/** R41 — un ordre créé, fork compris : c'en est un aussi. */
export async function journaliserOrdreCree(
	db: Db,
	options: { membreId: string; ordreId: string; now: number }
): Promise<void> {
	await db.insert(feedEvents).values({
		memberId: options.membreId,
		type: 'ordre_cree',
		orderId: options.ordreId,
		createdAt: options.now
	});
}

/** R41 — un ordre suivi. Le suivi étant idempotent, l'appelant ne journalise que le premier. */
export async function journaliserOrdreSuivi(
	db: Db,
	options: { membreId: string; ordreId: string; now: number }
): Promise<void> {
	await db.insert(feedEvents).values({
		memberId: options.membreId,
		type: 'ordre_suivi',
		orderId: options.ordreId,
		createdAt: options.now
	});
}

/**
 * R33 — retirer une consignation rétracte du fil ce qu'elle y avait mis.
 *
 * **Tout ce que le couple membre-œuvre y avait mis, pas seulement le dernier
 * événement.** Le retrait emporte déjà la note et l'avis (R33) ; laisser « a
 * noté 4 étoiles » et « a écrit un avis » dans le fil renverrait vers une note et
 * un avis qui n'existent plus, et « a terminé » vers une consignation disparue.
 * Le fil raconte des consignations : quand la consignation n'est plus, l'histoire
 * qu'elle racontait non plus.
 *
 * Les notifications déjà émises (R43) ne sont **pas** touchées. Une notification
 * est un message reçu ; le fait qu'il ait été reçu ne se défait pas, et R43 ne
 * demande rien de tel.
 */
export async function retracterConsignation(
	db: Db,
	options: { membreId: string; oeuvreId: string }
): Promise<void> {
	await db
		.delete(feedEvents)
		.where(and(eq(feedEvents.memberId, options.membreId), eq(feedEvents.workId, options.oeuvreId)));
}

/** Un ordre supprimé quitte le fil : ses événements ne mènent plus nulle part. */
export async function retracterOrdre(db: Db, ordreId: string): Promise<void> {
	await db.delete(feedEvents).where(eq(feedEvents.orderId, ordreId));
}

// ---------------------------------------------------------------------------
// R43 — informer le membre dont la recommandation a été suivie
// ---------------------------------------------------------------------------

/**
 * R43 — quelqu'un a **atteint** une œuvre qu'un membre lui avait recommandée.
 *
 * Deux propriétés, et chacune répond à un défaut nommé :
 *
 * - **l'atteinte, jamais la consignation.** L'appelant ne s'y trompe pas parce
 *   qu'il n'appelle qu'au franchissement de la frontière. Poser une
 *   recommandation sur « à découvrir » n'apprend rien à celui qui l'a faite ;
 * - **une notification agrégée par cascade.** `oeuvrePivotId` est le recueil
 *   quand l'atteinte vient d'une cascade, l'œuvre elle-même sinon, et l'index
 *   partiel sur les lignes non lues fait le reste : quarante numéros
 *   incrémentent un compteur au lieu d'écrire quarante lignes. Sans ça le
 *   destinataire recevrait quarante messages pour une seule lecture, et
 *   n'ouvrirait plus jamais la liste.
 *
 * L'agrégation s'arrête à la lecture : une ligne lue n'est plus le réceptacle de
 * rien, et l'atteinte suivante en ouvre une neuve. Un compteur qui continuerait
 * de grossir après avoir été vu ne dirait plus ce qu'il compte.
 */
export async function signalerRecommandationSuivie(
	db: Db,
	options: { destinataireId: string; acteurId: string; oeuvrePivotId: string; now: number }
): Promise<void> {
	// Personne n'est informé de s'être suivi soi-même. La vérification est ici
	// plutôt que chez l'appelant : c'est une règle de la notification.
	if (options.destinataireId === options.acteurId) return;

	await db
		.insert(notifications)
		.values({
			memberId: options.destinataireId,
			actorId: options.acteurId,
			workId: options.oeuvrePivotId,
			worksCount: 1,
			createdAt: options.now,
			updatedAt: options.now
		})
		.onConflictDoUpdate({
			target: [notifications.memberId, notifications.actorId, notifications.workId],
			targetWhere: sql`read_at is null`,
			set: { worksCount: sql`${notifications.worksCount} + 1`, updatedAt: options.now }
		});
}

// ---------------------------------------------------------------------------
// Lectures
// ---------------------------------------------------------------------------

/** R42 — d'où venait la consignation, telle que le fil l'affiche. */
export type ProvenanceDuFil =
	| { type: 'membre'; membreId: string; nom: string | null }
	| { type: 'ordre'; ordreId: string; titre: string | null }
	| { type: 'catalogue' };

export interface EvenementDuFil {
	id: string;
	type: TypeEvenement;
	/**
	 * R38 — `nom` vaut `null` pour un membre parti, et il n'est pas simplement
	 * remplacé au rendu : il n'est pas dans ce que la lecture rend. Un fil qui
	 * continuerait de nommer quelqu'un qui est parti est exactement ce que R38
	 * refuse, et le seul moyen d'en être sûr est de ne pas charger le nom.
	 */
	acteur: { id: string; nom: string | null; parti: boolean };
	/** Titre **brut** : la surface le passe à `masquerTitres` (R32). `null` si l'œuvre a disparu. */
	oeuvre: { id: string; titre: string } | null;
	/** `null` si l'ordre a été supprimé depuis. */
	ordre: { id: string; titre: string } | null;
	etagere: Etagere | null;
	note: number | null;
	position: number | null;
	/** R42 — portée par les seules consignations : c'est d'elles que R42 parle. */
	provenance: ProvenanceDuFil | null;
	quand: number;
}

/**
 * Le fil du groupe, du plus récent au plus ancien.
 *
 * Le nombre de requêtes est constant, pas proportionnel au nombre d'événements :
 * une page de cinquante lignes tient dans les 10 ms d'une invocation (KTD2).
 *
 * `avant` est un curseur d'horodatage pour la page suivante. Il vaut mieux qu'un
 * décalage : le fil s'allonge par le haut pendant qu'on le lit, et un décalage
 * ferait revoir les mêmes lignes.
 */
export async function lireFil(
	db: Db,
	options: { limite?: number; avant?: number } = {}
): Promise<EvenementDuFil[]> {
	const limite = options.limite ?? 50;

	const lignes = await db
		.select()
		.from(feedEvents)
		.where(options.avant === undefined ? undefined : lt(feedEvents.createdAt, options.avant))
		.orderBy(desc(feedEvents.createdAt), desc(feedEvents.id))
		.limit(limite);

	if (lignes.length === 0) return [];

	const oeuvreIds = [
		...new Set(lignes.map((l) => l.workId).filter((id): id is string => id !== null))
	];
	const ordreIds = [
		...new Set(lignes.map((l) => l.orderId).filter((id): id is string => id !== null))
	];

	// La provenance (R42) est celle de la consignation de l'acteur sur l'œuvre :
	// un couple, donc, et non l'événement — un fait constaté une fois et affiché
	// partout où il compte.
	const couples = lignes
		.filter((l) => l.type === 'consignation' && l.workId !== null)
		.map((l) => and(eq(journalEntries.memberId, l.memberId), eq(journalEntries.workId, l.workId!)));

	const [titres, ordresLus, consignations] = await Promise.all([
		titresCorriges(db, oeuvreIds),
		ordreIds.length === 0
			? Promise.resolve([])
			: db
					.select({ id: orders.id, titre: orders.title })
					.from(orders)
					.where(inArray(orders.id, ordreIds)),
		couples.length === 0
			? Promise.resolve([])
			: db.query.journalEntries.findMany({ where: or(...couples) })
	]);

	// Les noms se chargent en une fois : les acteurs, plus les membres cités en
	// provenance.
	const membreIds = [
		...new Set([
			...lignes.map((l) => l.memberId),
			...consignations.map((c) => c.provenanceMemberId).filter((id): id is string => id !== null)
		])
	];
	const membresLus = await db.query.members.findMany({ where: inArray(members.id, membreIds) });

	const parMembre = new Map(membresLus.map((m) => [m.id, m]));
	const parOrdre = new Map(ordresLus.map((o) => [o.id, o]));
	const parCouple = new Map(consignations.map((c) => [`${c.memberId} ${c.workId}`, c]));

	/** R38 — un membre parti n'est plus nommé, ici comme ailleurs. */
	const nomDe = (membreId: string): string | null => {
		const membre = parMembre.get(membreId);
		if (!membre || membre.leftAt !== null) return null;
		return membre.displayName;
	};

	return lignes.map((ligne) => {
		const consignation =
			ligne.workId === null ? undefined : parCouple.get(`${ligne.memberId} ${ligne.workId}`);
		const ordre = ligne.orderId === null ? undefined : parOrdre.get(ligne.orderId);
		const titre = ligne.workId === null ? undefined : titres.get(ligne.workId);

		return {
			id: ligne.id,
			type: ligne.type,
			acteur: {
				id: ligne.memberId,
				nom: nomDe(ligne.memberId),
				parti: parMembre.get(ligne.memberId)?.leftAt !== null
			},
			oeuvre: ligne.workId === null || titre === undefined ? null : { id: ligne.workId, titre },
			ordre: ordre === undefined ? null : { id: ordre.id, titre: ordre.titre },
			etagere: ligne.shelf,
			note: ligne.rating,
			position: ligne.position,
			provenance: consignation === undefined ? null : provenanceDe(consignation, nomDe, parOrdre),
			quand: ligne.createdAt
		};
	});
}

function provenanceDe(
	entree: JournalEntry,
	nomDe: (membreId: string) => string | null,
	parOrdre: Map<string, { id: string; titre: string }>
): ProvenanceDuFil {
	if (entree.provenance === 'membre' && entree.provenanceMemberId !== null) {
		return {
			type: 'membre',
			membreId: entree.provenanceMemberId,
			nom: nomDe(entree.provenanceMemberId)
		};
	}
	if (entree.provenance === 'ordre' && entree.provenanceOrderId !== null) {
		return {
			type: 'ordre',
			ordreId: entree.provenanceOrderId,
			// L'ordre n'est chargé que s'il est cité par ailleurs dans la page ; son
			// absence se lit « un ordre », ce qui reste vrai.
			titre: parOrdre.get(entree.provenanceOrderId)?.titre ?? null
		};
	}
	return { type: 'catalogue' };
}

// ---------------------------------------------------------------------------
// Les notifications d'un membre (R43)
// ---------------------------------------------------------------------------

export interface NotificationDuFil {
	id: string;
	acteur: { id: string; nom: string | null; parti: boolean };
	/** Titre **brut**, comme pour le fil : la surface le passe à `masquerTitres`. */
	oeuvre: { id: string; titre: string } | null;
	/** Combien d'œuvres cette ligne agrège. Un recueil et ses numéros n'en font qu'une. */
	nombreDOeuvres: number;
	quand: number;
}

/** R43 — ce qu'un membre n'a pas encore lu. */
export async function notificationsDe(
	db: Db,
	membreId: string,
	options: { limite?: number } = {}
): Promise<NotificationDuFil[]> {
	const lignes = await db
		.select()
		.from(notifications)
		.where(and(eq(notifications.memberId, membreId), isNull(notifications.readAt)))
		.orderBy(desc(notifications.updatedAt), desc(notifications.id))
		.limit(options.limite ?? 20);

	if (lignes.length === 0) return [];

	const [titres, membresLus] = await Promise.all([
		titresCorriges(db, [...new Set(lignes.map((l) => l.workId))]),
		db.query.members.findMany({
			where: inArray(members.id, [...new Set(lignes.map((l) => l.actorId))])
		})
	]);

	const parMembre = new Map(membresLus.map((m) => [m.id, m]));

	return lignes.map((ligne) => {
		const acteur = parMembre.get(ligne.actorId);
		const parti = acteur === undefined || acteur.leftAt !== null;
		const titre = titres.get(ligne.workId);

		return {
			id: ligne.id,
			acteur: { id: ligne.actorId, nom: parti ? null : acteur.displayName, parti },
			oeuvre: titre === undefined ? null : { id: ligne.workId, titre },
			nombreDOeuvres: ligne.worksCount,
			quand: ligne.updatedAt
		};
	});
}

/**
 * Marque comme lues les notifications d'un membre.
 *
 * **Le membre est celui de la session, jamais un identifiant reçu**, exactement
 * comme la révélation de R31 : il n'y a pas de paramètre à forger pour vider la
 * liste de quelqu'un d'autre.
 */
export async function marquerNotificationsLues(
	db: Db,
	membreId: string,
	now = Date.now()
): Promise<void> {
	await db
		.update(notifications)
		.set({ readAt: now })
		.where(and(eq(notifications.memberId, membreId), isNull(notifications.readAt)));
}
