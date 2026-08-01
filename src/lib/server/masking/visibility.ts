import { and, eq, inArray } from 'drizzle-orm';
import { journalEntries, reveals, works } from '../db/schema';
import type { Db } from '../db';
import type { TypeOeuvre } from '../catalog/sources/types';
import { estAtteinte, type Etagere } from '../journal/atteinte';
import { positionEffective } from '../journal/position';

/**
 * La règle de masquage, et il n'y en a qu'une.
 *
 * > R27 — le texte d'un avis ou d'un commentaire est visible pour un membre si
 * > et seulement si ce membre a **atteint** l'œuvre concernée.
 *
 * Ni l'étagère, ni la note, ni les ordres suivis n'entrent dans le calcul.
 * « Atteint » veut dire terminé ou abandonné, et rien d'autre — c'est
 * `journal/atteinte.ts` qui le dit, ici comme partout ailleurs.
 *
 * **Ce module est le seul à décider.** KTD5 en fait un choix d'architecture et
 * non de discipline : le défaut que le document d'origine relève chez Goodreads
 * ne vient pas d'une règle fausse mais d'un masquage réimplémenté par surface,
 * dont une a fini par diverger. Toute surface qui rend du texte d'avis — page
 * d'œuvre, page de profil, fil d'activité, réponse d'API, libellés du graphe —
 * passe donc par `masquer`, et `surfaces.test.ts` vérifie qu'aucune ne s'en
 * dispense.
 *
 * **Le filtrage se fait avant sérialisation** (KTD3). `masquer` ne renvoie pas
 * un drapeau à interpréter côté client : il renvoie des objets dont le texte
 * *n'est pas là*. Un masquage appliqué au rendu enverrait le texte dans la
 * charge utile, ce qui n'est pas du masquage.
 *
 * Ce que la règle ne touche **jamais** (R28) : les notes, leur agrégat et le
 * nombre d'avis. C'est ce qui rend la règle unique vivable sur un catalogue de
 * 50 000 entrées — un membre qui parcourt voit les notes partout, et les textes
 * de ce qu'il a atteint. Aucune fonction d'ici ne s'en approche, et c'est
 * exprès : ce qu'on ne masque jamais n'a pas à traverser le masquage.
 */

// ---------------------------------------------------------------------------
// Ce qui est long, et pourquoi ça compte
// ---------------------------------------------------------------------------

/**
 * Les œuvres à l'intérieur desquelles une position a un sens (R23).
 *
 * R23 nomme le roman, le recueil et l'omnibus — l'omnibus étant un recueil dans
 * le modèle de U3a. Le numéro, le film et l'épisode se lisent ou se regardent
 * d'un trait : leur donner une position intérieure produirait des comparaisons
 * de nombres sans référent, et R29 masquerait ou démasquerait au hasard.
 *
 * La série et la saison en sont volontairement absentes : elles regroupent des
 * œuvres qui portent chacune leur propre entrée de journal, et « 30 % d'une
 * série » ne désigne rien de comparable d'un membre à l'autre.
 *
 * Liste blanche, comme les chemins publics de `hooks.server.ts` et les types
 * contenants de `journal/contenance.ts` : un type d'œuvre ajouté plus tard n'est
 * pas long tant que quelqu'un ne l'a pas décidé. C'est le bon défaut — le pire
 * qu'il puisse arriver est un masquage trop strict.
 */
export const TYPES_OEUVRE_LONGUE = ['recueil', 'roman'] as const satisfies readonly TypeOeuvre[];
export type TypeOeuvreLongue = (typeof TYPES_OEUVRE_LONGUE)[number];

/** R23 — cette œuvre a-t-elle un intérieur où l'on peut se situer ? */
export function estOeuvreLongue(type: TypeOeuvre): type is TypeOeuvreLongue {
	return (TYPES_OEUVRE_LONGUE as readonly TypeOeuvre[]).includes(type);
}

// ---------------------------------------------------------------------------
// Les deux termes de la décision
// ---------------------------------------------------------------------------

/**
 * Un texte soumis à la règle, réduit à ce dont elle a besoin.
 *
 * Volontairement pauvre : la note, le titre, la date et le nom de l'auteur ne
 * sont pas ici parce qu'ils ne sont jamais masqués (R28) et qu'ils n'entrent pas
 * dans la décision. Les surfaces les portent en plus — `masquer` conserve tout
 * ce qu'on lui donne et ne retire que le texte.
 */
export interface ContenuMasquable {
	/** L'identité du texte. R31 veut qu'il reste visible en tant qu'objet. */
	id: string;
	auteurId: string;
	oeuvreId: string;
	texte: string;
	/** La position de l'auteur à la rédaction **initiale** (R30). Figée. */
	positionARedaction: number | null;
}

/** Ce qu'un membre est vis-à-vis d'une œuvre, au moment où il regarde. */
export interface RegardSurOeuvre {
	oeuvreId: string;
	/** R3 — dérivé, jamais lu depuis la base. */
	atteinte: boolean;
	/** R24 — la position effective, dans [0, 1]. */
	position: number;
	longue: boolean;
	/** R31 — une révélation explicite, déjà enregistrée pour ce membre. */
	revelee: boolean;
}

export type Verdict =
	| { visible: true; motif: 'auteur' | 'atteinte' | 'révélation' | 'position' }
	| { visible: false; motif: 'œuvre non atteinte' | 'position dépassée' };

/**
 * **La fonction unique.** Pure, sans base, sans surface : c'est ici et nulle
 * part ailleurs qu'un texte devient lisible.
 *
 * Quatre chemins vers la visibilité, et l'ordre entre eux n'arbitre rien — ils
 * ne se contredisent jamais, ils s'additionnent :
 *
 * 1. **l'auteur.** Un membre voit toujours ce qu'il a écrit, quelle que soit sa
 *    position. Le lui masquer serait absurde : il connaît déjà son texte, et
 *    R37 lui donne le droit de le modifier — qu'il faudrait alors lui refuser.
 * 2. **l'atteinte (R27).** La règle elle-même.
 * 3. **la révélation (R31).** Un geste explicite, déjà enregistré, qui persiste.
 * 4. **la position (R29).** La seule condition intra-œuvre, et la seule
 *    ouverture que la règle admette : dans une œuvre longue non atteinte, un
 *    membre ne voit pas les contenus écrits à une position **supérieure à la
 *    sienne** — donc il voit ceux écrits en deçà, qui parlent d'un passage
 *    qu'il a déjà lu. C'est la lecture qui donne leur raison d'être à R25 — la
 *    position obligatoire avant de publier — et à R30 — la position figée à la
 *    rédaction : sans elle, ni l'une ni l'autre n'aurait le moindre effet
 *    observable, puisque tout serait masqué de toute façon jusqu'à l'atteinte.
 *
 * Une position à `null` ne se devine pas : elle masque. Un contenu dont on ne
 * sait pas où il a été écrit peut parler de la fin.
 */
export function verdictDeVisibilite(
	contenu: ContenuMasquable,
	regard: RegardSurOeuvre,
	lecteurId: string
): Verdict {
	if (contenu.auteurId === lecteurId) return { visible: true, motif: 'auteur' };
	if (regard.atteinte) return { visible: true, motif: 'atteinte' };
	if (regard.revelee) return { visible: true, motif: 'révélation' };

	if (
		regard.longue &&
		contenu.positionARedaction !== null &&
		contenu.positionARedaction <= regard.position
	) {
		return { visible: true, motif: 'position' };
	}

	return {
		visible: false,
		motif: regard.longue ? 'position dépassée' : 'œuvre non atteinte'
	};
}

// ---------------------------------------------------------------------------
// L'application, telle que les surfaces l'appellent
// ---------------------------------------------------------------------------

/**
 * Ce qu'une surface reçoit — et ce qu'elle peut sérialiser sans y penser.
 *
 * Le type **remplace** `texte` au lieu de l'accompagner d'un drapeau : c'est ce
 * qui rend impossible de sérialiser par mégarde un texte refusé, puisqu'il n'est
 * plus dans l'objet. `masque` n'est là que pour l'affichage de R31 — savoir
 * qu'un contenu existe sans le lire.
 */
export type Masque<T extends ContenuMasquable> = Omit<T, 'texte'> & {
	texte: string | null;
	masque: boolean;
};

/**
 * Le passage obligé de tout texte d'avis vers une surface.
 *
 * Conserve tout ce que l'appelant lui donne — note, auteur, date, ce qu'il veut
 * — et ne retire que le texte refusé. Les surfaces n'ont donc rien à
 * reconstruire, et surtout rien à décider.
 *
 * Coût constant en requêtes quel que soit le nombre de contenus : trois
 * lectures pour l'ensemble du lot, pas trois par avis. Une page d'œuvre à vingt
 * avis ne doit pas coûter soixante allers-retours dans les 10 ms d'une
 * invocation (KTD2).
 */
export async function masquer<T extends ContenuMasquable>(
	db: Db,
	lecteurId: string,
	contenus: readonly T[]
): Promise<Masque<T>[]> {
	if (contenus.length === 0) return [];

	const regards = await regardsSurOeuvres(
		db,
		lecteurId,
		contenus.map((contenu) => contenu.oeuvreId)
	);

	return contenus.map((contenu) => {
		const { texte, ...reste } = contenu;
		const regard = regards.get(contenu.oeuvreId) ?? regardParDefaut(contenu.oeuvreId);
		const verdict = verdictDeVisibilite(contenu, regard, lecteurId);

		return {
			...reste,
			texte: verdict.visible ? texte : null,
			masque: !verdict.visible
		} as Masque<T>;
	});
}

/**
 * Le regard d'un membre sur un lot d'œuvres.
 *
 * Exposé parce que les surfaces qui affichent l'état de masquage sans encore
 * tenir les textes en ont besoin — et parce qu'un regard qui se construit en un
 * seul endroit ne peut pas diverger d'une page à l'autre.
 */
export async function regardsSurOeuvres(
	db: Db,
	membreId: string,
	oeuvreIds: readonly string[]
): Promise<Map<string, RegardSurOeuvre>> {
	const ids = [...new Set(oeuvreIds)];
	if (ids.length === 0) return new Map();

	const [types, entrees, revelees] = await Promise.all([
		db.select({ id: works.id, type: works.type }).from(works).where(inArray(works.id, ids)),
		db.query.journalEntries.findMany({
			where: and(eq(journalEntries.memberId, membreId), inArray(journalEntries.workId, ids))
		}),
		db
			.select({ oeuvre: reveals.workId })
			.from(reveals)
			.where(and(eq(reveals.memberId, membreId), inArray(reveals.workId, ids)))
	]);

	const typeParOeuvre = new Map(types.map((ligne) => [ligne.id, ligne.type]));
	const entreeParOeuvre = new Map(entrees.map((entree) => [entree.workId, entree]));
	const oeuvresRevelees = new Set(revelees.map((ligne) => ligne.oeuvre));

	return new Map(
		ids.map((oeuvreId) => {
			const entree = entreeParOeuvre.get(oeuvreId) ?? null;
			const etat =
				entree === null ? null : { etagere: entree.shelf, abandonnee: entree.abandonedAt !== null };
			const type = typeParOeuvre.get(oeuvreId);

			return [
				oeuvreId,
				{
					oeuvreId,
					atteinte: etat !== null && estAtteinte(etat),
					position: positionEffective(etat, entree?.declaredPosition ?? null),
					longue: type !== undefined && estOeuvreLongue(type),
					revelee: oeuvresRevelees.has(oeuvreId)
				}
			];
		})
	);
}

/**
 * Le regard de quelqu'un qui n'a rien consigné, sur une œuvre qu'on ne trouve
 * pas.
 *
 * C'est le défaut le plus strict possible, et c'est la seule valeur acceptable :
 * une œuvre absente de la table est une anomalie, et une anomalie ne doit pas
 * ouvrir un texte.
 */
function regardParDefaut(oeuvreId: string): RegardSurOeuvre {
	return { oeuvreId, atteinte: false, position: 0, longue: false, revelee: false };
}

// ---------------------------------------------------------------------------
// La révélation (R31)
// ---------------------------------------------------------------------------

/**
 * R31 — enregistre la révélation d'un membre sur une œuvre.
 *
 * **Le membre est celui de la session, jamais un identifiant reçu.** C'est ce
 * qui rend structurellement impossible de déclencher la révélation d'un autre :
 * il n'y a pas de paramètre à forger, et les surfaces passent `locals.member.id`.
 *
 * Idempotent : le bouton peut être cliqué deux fois, et la date conservée est
 * celle de la première fois — c'est le moment où le membre a accepté de se
 * gâcher l'œuvre.
 */
export async function reveler(
	db: Db,
	options: { membreId: string; oeuvreId: string; now?: number }
): Promise<ResultatRevelation> {
	// L'œuvre est vérifiée ici et non dans les surfaces : elles sont deux, et
	// elles seront plus nombreuses. Un identifiant forgé est un refus typé, pas
	// une violation de clé étrangère remontée en erreur serveur.
	const oeuvre = await db.query.works.findFirst({ where: eq(works.id, options.oeuvreId) });
	if (!oeuvre) return { ok: false, motif: 'œuvre introuvable' };

	await db
		.insert(reveals)
		.values({
			memberId: options.membreId,
			workId: options.oeuvreId,
			createdAt: options.now ?? Date.now()
		})
		.onConflictDoNothing();

	return { ok: true };
}

export type ResultatRevelation = { ok: true } | { ok: false; motif: 'œuvre introuvable' };

/** R31 — ce membre a-t-il déjà révélé cette œuvre ? */
export async function estRevelee(db: Db, membreId: string, oeuvreId: string): Promise<boolean> {
	const ligne = await db.query.reveals.findFirst({
		where: and(eq(reveals.memberId, membreId), eq(reveals.workId, oeuvreId))
	});
	return ligne !== undefined;
}

// ---------------------------------------------------------------------------
// La position obligatoire (R25)
// ---------------------------------------------------------------------------

/**
 * R25 — déclarer une position strictement positive est obligatoire avant de
 * publier un avis ou un commentaire sur une œuvre longue non atteinte.
 *
 * La règle vit ici et non dans `journal/entries.ts`, bien que ce soit lui qui
 * l'applique à l'écriture : c'est une règle de masquage. La position qu'elle
 * exige n'a d'autre usage que d'alimenter la comparaison de R29 — sans elle, un
 * texte écrit au milieu d'un omnibus est masqué pour tout le monde jusqu'à
 * l'atteinte, y compris pour ceux qui ont déjà lu le passage dont il parle. La
 * placer dans les deux modules reproduirait exactement le défaut que KTD5 existe
 * pour éviter.
 *
 * Le « strictement » n'est pas une coquetterie. Sous R29 un contenu est visible
 * à qui est au moins à sa position, et tout lecteur est au moins à zéro : sans
 * cette borne, publier à zéro serait un moyen trivial d'écrire un texte que tout
 * le monde peut lire sans avoir rien atteint, ce qui viderait le dispositif.
 */
export function publicationAutorisee(contexte: {
	typeOeuvre: TypeOeuvre;
	atteinte: boolean;
	positionDeclaree: number | null;
}): boolean {
	if (contexte.atteinte) return true;
	if (!estOeuvreLongue(contexte.typeOeuvre)) return true;
	return contexte.positionDeclaree !== null && contexte.positionDeclaree > 0;
}

// ---------------------------------------------------------------------------
// Le titre dans le fil (R32)
// ---------------------------------------------------------------------------

/**
 * **Une seconde règle, plus étroite, et qui vit ici pour la même raison que la
 * première.**
 *
 * R32 ne dit pas ce que dit R27, et il ne faut surtout pas les confondre : le
 * texte d'un avis est masqué tant que l'œuvre n'est pas *atteinte*, alors qu'un
 * titre du fil n'est masqué que pour un membre qui a placé l'œuvre sur son
 * étagère « à découvrir ». La différence est assumée par le document d'origine —
 * « ailleurs, les titres du fil sont visibles » — et elle est la seule tenable :
 * on ne peut pas masquer cinquante mille titres qu'un membre n'a pas lus sans
 * rendre le fil illisible. Ce qu'on protège, c'est une **intention déclarée** :
 * quelqu'un a dit vouloir découvrir cette œuvre, on ne la lui gâche pas.
 *
 * Cette règle est ici et non dans `feed/events.ts` parce que c'est du masquage,
 * et que KTD5 vaut pour le masquage entier et pas seulement pour R27 : deux
 * fichiers qui décident chacun de ce qu'on voit, c'est exactement le défaut
 * qu'on prévient.
 *
 * **La forme du masque est le type de l'œuvre**, pas un blanc ni un symbole.
 * « Camille a terminé un numéro de comic » se lit ; « Camille a terminé ??? » ne
 * dit rien à personne et donne à croire que le produit est cassé. Le type ne
 * fuit rien : le membre a lui-même mis l'œuvre sur son étagère, il sait déjà de
 * quelle sorte d'objet il s'agit.
 */

/** Ce qu'on affiche à la place d'un titre masqué. Accordé pour entrer dans une phrase. */
export const LIBELLE_DE_TYPE: Record<TypeOeuvre, string> = {
	numero: 'un numéro de comic',
	recueil: 'un recueil',
	film: 'un film',
	serie: 'une série',
	saison: 'une saison',
	episode: 'un épisode',
	roman: 'un roman'
};

/** Une œuvre disparue du catalogue n'a plus de type : elle reste une œuvre. */
export const LIBELLE_SANS_TYPE = 'une œuvre';

export function libelleDeType(type: TypeOeuvre | null): string {
	return type === null ? LIBELLE_SANS_TYPE : LIBELLE_DE_TYPE[type];
}

/** Un titre soumis à R32, et de quoi décider. */
export interface TitreMasquable {
	oeuvreId: string;
	titre: string;
	/** L'auteur du geste. Un membre voit toujours le titre de ses propres événements. */
	acteurId: string;
}

export type TitreDuFil = {
	oeuvreId: string;
	/** Absent quand le titre est masqué — jamais mis à `null` après coup. */
	titre: string | null;
	/** Ce qu'une surface affiche : le titre, ou le type de l'œuvre. */
	libelle: string;
	masque: boolean;
};

/**
 * R32 — ce titre est-il lisible par ce membre ?
 *
 * Pure, et volontairement sans base : c'est ici et nulle part ailleurs que la
 * décision se prend.
 *
 * Trois choses, et l'ordre entre elles n'arbitre rien :
 *
 * 1. **ses propres événements.** Un membre voit toujours le titre de ce qu'il a
 *    fait lui-même — même exemption que l'auteur sous R27, et pour une raison
 *    plus forte encore : il vient de poser l'œuvre sur son étagère, il en connaît
 *    le titre. Le lui masquer transformerait son propre fil en suite de « un
 *    numéro de comic » sans rien protéger de personne.
 * 2. **l'étagère « à découvrir ».** La seule condition de masquage de R32.
 * 3. **l'atteinte.** Une œuvre abandonnée depuis « à découvrir » est atteinte
 *    (R3) : plus rien à protéger, et R27 lui ouvrirait déjà les textes. Masquer
 *    son titre pendant qu'on lui sert les avis serait incohérent.
 */
export function titreLisibleDansLeFil(
	regard: { etagere: Etagere | null; atteinte: boolean },
	acteurId: string,
	lecteurId: string
): boolean {
	if (acteurId === lecteurId) return true;
	if (regard.atteinte) return true;
	return regard.etagere !== 'a_decouvrir';
}

/**
 * Le passage obligé de tout titre d'œuvre vers le fil.
 *
 * Rend un tableau **parallèle à l'entrée** et non une table indexée par œuvre :
 * deux événements peuvent porter la même œuvre avec deux acteurs différents, et
 * l'exemption du point 1 ci-dessus ne vaut que pour l'un d'eux.
 *
 * Comme `masquer`, la fonction **retire** le titre au lieu de poser un drapeau à
 * côté : ce qui n'est pas dans l'objet ne peut pas partir dans la charge utile.
 *
 * Deux requêtes pour le lot entier, quel que soit le nombre d'événements — un
 * fil de cinquante lignes ne doit pas coûter cent allers-retours (KTD2).
 */
export async function masquerTitres(
	db: Db,
	lecteurId: string,
	titres: readonly TitreMasquable[]
): Promise<TitreDuFil[]> {
	if (titres.length === 0) return [];

	const ids = [...new Set(titres.map((titre) => titre.oeuvreId))];

	const [types, entrees] = await Promise.all([
		db.select({ id: works.id, type: works.type }).from(works).where(inArray(works.id, ids)),
		db.query.journalEntries.findMany({
			where: and(eq(journalEntries.memberId, lecteurId), inArray(journalEntries.workId, ids))
		})
	]);

	const typeParOeuvre = new Map(types.map((ligne) => [ligne.id, ligne.type]));
	const entreeParOeuvre = new Map(entrees.map((entree) => [entree.workId, entree]));

	return titres.map((titre) => {
		const entree = entreeParOeuvre.get(titre.oeuvreId) ?? null;
		const etat =
			entree === null ? null : { etagere: entree.shelf, abandonnee: entree.abandonedAt !== null };

		const lisible = titreLisibleDansLeFil(
			{ etagere: etat?.etagere ?? null, atteinte: etat !== null && estAtteinte(etat) },
			titre.acteurId,
			lecteurId
		);

		return {
			oeuvreId: titre.oeuvreId,
			titre: lisible ? titre.titre : null,
			libelle: lisible ? titre.titre : libelleDeType(typeParOeuvre.get(titre.oeuvreId) ?? null),
			masque: !lisible
		};
	});
}
