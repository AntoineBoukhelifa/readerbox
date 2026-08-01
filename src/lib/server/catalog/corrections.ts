import { and, asc, eq, inArray } from 'drizzle-orm';
import {
	entities,
	workCharacters,
	workContents,
	workCreators,
	workCorrections,
	workSources,
	works,
	type WorkCorrection
} from '../db/schema';
import type { Db } from '../db';
import { TYPES_OEUVRE, type ReferenceSource, type TypeOeuvre } from './sources/types';
import { signalerRattachementsModifies } from './rematerialisation';

/**
 * R47 — un membre corrige ou complète une fiche fausse ou incomplète — et R39 —
 * la correction survit à une ré-ingestion.
 *
 * La seule conception qui tient les deux ensemble : **les corrections ne sont
 * jamais écrites dans la donnée de source.** Elles vivent dans leur propre
 * table et sont appliquées par-dessus à la lecture. Une ré-ingestion réécrit la
 * couche de source sans rien savoir des corrections ; celles-ci s'appliquent de
 * nouveau à la lecture suivante. R39 devient structurel au lieu de dépendre de
 * la discipline de chaque appelant.
 *
 * Deux formes de correction, selon la nature du champ :
 *
 * - **Remplacement** pour un scalaire ou un rattachement unique : titre, date,
 *   série, event. La correction dit ce que la valeur doit être.
 * - **Delta** — ajouts et retraits — pour les listes : personnages, créateurs,
 *   contenu d'un recueil. Un membre qui complète une fiche ajoute un personnage
 *   oublié ; il ne redéclare pas la liste entière. Et surtout : si la source
 *   crédite plus tard un personnage supplémentaire, une liste de remplacement
 *   l'aurait masqué à jamais, alors qu'un delta le laisse apparaître.
 */

export const CHAMPS_CORRIGIBLES = [
	'titre',
	'dateDeParution',
	'numeroDansLaSerie',
	'couvertureUrl',
	'type',
	'serie',
	'event',
	'personnages',
	'createurs',
	'contenu'
] as const;

export type ChampCorrigible = (typeof CHAMPS_CORRIGIBLES)[number];

/**
 * Les champs dont la modification change le graphe.
 *
 * Ce sont exactement les trois familles d'arêtes de KTD4. Les créateurs n'y
 * sont pas — ils ne sont pas des nœuds. Le contenu d'un recueil non plus : il
 * change ce qu'un membre atteindra par cascade, ce qui passera par le point
 * d'appel de U4, pas par les appuis de cette œuvre-ci.
 */
export const CHAMPS_DE_RATTACHEMENT: readonly ChampCorrigible[] = ['serie', 'event', 'personnages'];

export interface CreateurCorrige {
	entityId: string;
	role: string;
}

export type Correction =
	| { champ: 'titre'; valeur: string }
	| { champ: 'dateDeParution' | 'couvertureUrl'; valeur: string | null }
	| { champ: 'numeroDansLaSerie'; valeur: number | null }
	| { champ: 'type'; valeur: TypeOeuvre }
	| { champ: 'serie' | 'event'; valeur: string | null }
	| { champ: 'personnages' | 'contenu'; ajoutes: string[]; retires: string[] }
	| { champ: 'createurs'; ajoutes: CreateurCorrige[]; retires: CreateurCorrige[] };

export type MotifRefusCorrection =
	'champ inconnu' | 'valeur invalide' | 'œuvre introuvable' | 'entité inconnue' | 'correction vide';

export type ResultatCorrection =
	| { ok: true; correctionId: string; rattachementsModifies: boolean }
	| { ok: false; motif: MotifRefusCorrection };

/**
 * Valide une correction venue d'un formulaire. Fonction pure : c'est elle qui
 * refuse un champ inexistant, et c'est elle qu'on teste.
 *
 * Elle existe séparément de `corriger` parce que la validation de forme ne
 * demande aucune base, et qu'un champ inconnu doit être refusé avant même
 * qu'une écriture soit envisagée.
 */
export function analyserCorrection(
	entree: unknown
): { ok: true; valeur: Correction } | { ok: false; motif: 'champ inconnu' | 'valeur invalide' } {
	if (typeof entree !== 'object' || entree === null) return { ok: false, motif: 'valeur invalide' };

	const brut = entree as Record<string, unknown>;
	const champ = brut.champ;
	if (typeof champ !== 'string' || !(CHAMPS_CORRIGIBLES as readonly string[]).includes(champ)) {
		return { ok: false, motif: 'champ inconnu' };
	}

	const nom = champ as ChampCorrigible;

	switch (nom) {
		case 'titre': {
			if (typeof brut.valeur !== 'string' || brut.valeur.trim() === '') {
				return { ok: false, motif: 'valeur invalide' };
			}
			return { ok: true, valeur: { champ: 'titre', valeur: brut.valeur } };
		}
		case 'dateDeParution':
		case 'couvertureUrl': {
			if (brut.valeur !== null && typeof brut.valeur !== 'string') {
				return { ok: false, motif: 'valeur invalide' };
			}
			return { ok: true, valeur: { champ: nom, valeur: brut.valeur } };
		}
		case 'numeroDansLaSerie': {
			if (brut.valeur !== null && !Number.isFinite(brut.valeur)) {
				return { ok: false, motif: 'valeur invalide' };
			}
			return {
				ok: true,
				valeur: { champ: 'numeroDansLaSerie', valeur: brut.valeur as number | null }
			};
		}
		case 'type': {
			if (!(TYPES_OEUVRE as readonly unknown[]).includes(brut.valeur)) {
				return { ok: false, motif: 'valeur invalide' };
			}
			return { ok: true, valeur: { champ: 'type', valeur: brut.valeur as TypeOeuvre } };
		}
		case 'serie':
		case 'event': {
			if (brut.valeur !== null && typeof brut.valeur !== 'string') {
				return { ok: false, motif: 'valeur invalide' };
			}
			return { ok: true, valeur: { champ: nom, valeur: brut.valeur } };
		}
		case 'personnages':
		case 'contenu': {
			const ajoutes = listeDIdentifiants(brut.ajoutes);
			const retires = listeDIdentifiants(brut.retires);
			if (ajoutes === null || retires === null) return { ok: false, motif: 'valeur invalide' };
			return { ok: true, valeur: { champ: nom, ajoutes, retires } };
		}
		case 'createurs': {
			const ajoutes = listeDeCreateurs(brut.ajoutes);
			const retires = listeDeCreateurs(brut.retires);
			if (ajoutes === null || retires === null) return { ok: false, motif: 'valeur invalide' };
			return { ok: true, valeur: { champ: 'createurs', ajoutes, retires } };
		}
	}
}

function listeDIdentifiants(brut: unknown): string[] | null {
	if (brut === undefined) return [];
	if (!Array.isArray(brut)) return null;
	if (!brut.every((v) => typeof v === 'string' && v !== '')) return null;
	return brut as string[];
}

function listeDeCreateurs(brut: unknown): CreateurCorrige[] | null {
	if (brut === undefined) return [];
	if (!Array.isArray(brut)) return null;
	const valides = brut.every(
		(v) =>
			typeof v === 'object' &&
			v !== null &&
			typeof (v as CreateurCorrige).entityId === 'string' &&
			typeof (v as CreateurCorrige).role === 'string'
	);
	return valides ? (brut as CreateurCorrige[]) : null;
}

/** Les entités qu'une correction désigne, pour vérifier qu'elles existent. */
function entitesDesignees(correction: Correction): string[] {
	switch (correction.champ) {
		case 'serie':
		case 'event':
			return correction.valeur === null ? [] : [correction.valeur];
		case 'personnages':
			return [...correction.ajoutes, ...correction.retires];
		case 'createurs':
			return [...correction.ajoutes, ...correction.retires].map((c) => c.entityId);
		default:
			return [];
	}
}

/**
 * Enregistre une correction de membre.
 *
 * Rien n'est écrasé : la donnée de source reste intacte et les corrections
 * précédentes restent en base. Une correction plus récente sur le même champ
 * supplante simplement la précédente à la lecture, ce qui garde l'historique
 * lisible et rend le retour en arrière possible sans mécanisme supplémentaire.
 *
 * Si la correction touche un rattachement, elle notifie la re-matérialisation
 * du graphe. C'est le second déclencheur de KTD4, et son oubli serait un défaut
 * silencieux et permanent : un personnage ajouté après coup à une œuvre déjà
 * atteinte n'apparaîtrait dans aucun graphe.
 */
export async function corriger(
	db: Db,
	options: { oeuvreId: string; membreId: string; correction: Correction; now?: number }
): Promise<ResultatCorrection> {
	const maintenant = options.now ?? Date.now();
	const { correction } = options;

	const oeuvre = await db.query.works.findFirst({ where: eq(works.id, options.oeuvreId) });
	if (!oeuvre) return { ok: false, motif: 'œuvre introuvable' };

	if (
		(correction.champ === 'personnages' ||
			correction.champ === 'contenu' ||
			correction.champ === 'createurs') &&
		correction.ajoutes.length === 0 &&
		correction.retires.length === 0
	) {
		return { ok: false, motif: 'correction vide' };
	}

	const designees = entitesDesignees(correction);
	if (designees.length > 0) {
		const connues = await db.query.entities.findMany({ where: inArray(entities.id, designees) });
		if (connues.length !== new Set(designees).size) return { ok: false, motif: 'entité inconnue' };
	}
	if (correction.champ === 'contenu') {
		const cibles = [...correction.ajoutes, ...correction.retires];
		const connues = await db.query.works.findMany({ where: inArray(works.id, cibles) });
		if (connues.length !== new Set(cibles).size) return { ok: false, motif: 'œuvre introuvable' };
	}

	const [ligne] = await db
		.insert(workCorrections)
		.values({
			workId: options.oeuvreId,
			memberId: options.membreId,
			field: correction.champ,
			value: JSON.stringify(correction),
			createdAt: maintenant
		})
		.returning({ id: workCorrections.id });

	const rattachementsModifies = CHAMPS_DE_RATTACHEMENT.includes(correction.champ);
	if (rattachementsModifies) {
		await signalerRattachementsModifies(db, options.oeuvreId, 'correction', maintenant);
	}

	return { ok: true, correctionId: ligne.id, rattachementsModifies };
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export interface RattachementLocal {
	entityId: string;
	nom: string;
}

export interface CreateurLocal extends RattachementLocal {
	role: string;
}

export interface ContenuLocal {
	/** L'œuvre locale, quand elle a déjà été ingérée. `null` tant que la cascade ne l'a pas atteinte. */
	oeuvreId: string | null;
	reference: ReferenceSource | null;
	rang: number;
}

export interface OeuvreLocale {
	id: string;
	type: TypeOeuvre;
	titre: string;
	dateDeParution: string | null;
	serie: RattachementLocal | null;
	numeroDansLaSerie: number | null;
	event: RattachementLocal | null;
	couvertureUrl: string | null;
	personnages: RattachementLocal[];
	createurs: CreateurLocal[];
	contenu: ContenuLocal[];
	etatIngestion: 'complete' | 'partielle' | 'echouee';
	/** Les identifiants de toutes les sources qui décrivent cette œuvre. */
	identifiants: ReferenceSource[];
}

/**
 * L'œuvre telle que les sources l'ont décrite, sans aucune correction.
 *
 * Exposée séparément parce que c'est la seule façon de vérifier qu'une
 * correction n'a rien écrasé — et parce qu'une ré-ingestion doit pouvoir se
 * comparer à ce qu'elle remplace, pas à ce que les membres ont corrigé.
 */
export async function lireCoucheSource(db: Db, oeuvreId: string): Promise<OeuvreLocale | null> {
	const oeuvre = await db.query.works.findFirst({ where: eq(works.id, oeuvreId) });
	if (!oeuvre) return null;

	const [personnages, createurs, contenus, sources] = await Promise.all([
		db
			.select({
				entityId: workCharacters.entityId,
				nom: entities.name,
				position: workCharacters.position
			})
			.from(workCharacters)
			.innerJoin(entities, eq(entities.id, workCharacters.entityId))
			.where(eq(workCharacters.workId, oeuvreId)),
		db
			.select({
				entityId: workCreators.entityId,
				nom: entities.name,
				role: workCreators.role,
				position: workCreators.position
			})
			.from(workCreators)
			.innerJoin(entities, eq(entities.id, workCreators.entityId))
			.where(eq(workCreators.workId, oeuvreId)),
		db.query.workContents.findMany({ where: eq(workContents.containerWorkId, oeuvreId) }),
		db.query.workSources.findMany({ where: eq(workSources.workId, oeuvreId) })
	]);

	return {
		id: oeuvre.id,
		type: oeuvre.type,
		titre: oeuvre.title,
		dateDeParution: oeuvre.releaseDate,
		serie: await lireEntite(db, oeuvre.seriesEntityId),
		numeroDansLaSerie: oeuvre.numberInSeries,
		event: await lireEntite(db, oeuvre.eventEntityId),
		couvertureUrl: oeuvre.coverUrl,
		// L'union sur toutes les sources, dédoublonnée : deux sources créditant
		// le même personnage ne le font pas apparaître deux fois.
		personnages: dedoublonner(personnages, (p) => p.entityId)
			.sort((a, b) => a.position - b.position || a.nom.localeCompare(b.nom))
			.map(({ entityId, nom }) => ({ entityId, nom })),
		createurs: dedoublonner(createurs, (c) => `${c.entityId}\0${c.role}`)
			.sort((a, b) => a.position - b.position || a.nom.localeCompare(b.nom))
			.map(({ entityId, nom, role }) => ({ entityId, nom, role })),
		contenu: contenus
			.map((c) => ({
				oeuvreId: c.contentWorkId,
				reference: { source: c.source, idExterne: c.externalId },
				rang: c.rank
			}))
			.sort((a, b) => a.rang - b.rang),
		etatIngestion: oeuvre.ingestionState,
		identifiants: sources.map((s) => ({ source: s.source, idExterne: s.externalId }))
	};
}

/**
 * L'œuvre telle qu'un membre la voit : la couche de source, corrections
 * appliquées par-dessus.
 *
 * C'est la seule lecture que les surfaces du produit doivent utiliser. Passer
 * par `lireCoucheSource` afficherait la fiche fausse que le membre a justement
 * corrigée.
 */
export async function lireOeuvre(db: Db, oeuvreId: string): Promise<OeuvreLocale | null> {
	const base = await lireCoucheSource(db, oeuvreId);
	if (!base) return null;

	const lignes = await db.query.workCorrections.findMany({
		where: eq(workCorrections.workId, oeuvreId),
		orderBy: [asc(workCorrections.createdAt), asc(workCorrections.id)]
	});

	const corrections = corrigeesDe(lignes);
	const noms = await chargerNoms(db, corrections.flatMap(entitesDesignees));

	return appliquerCorrections(base, corrections, noms);
}

/**
 * Les titres de plusieurs œuvres d'un coup, corrections appliquées.
 *
 * `lireOeuvre` est la lecture juste mais coûteuse : sept requêtes par œuvre.
 * Une surface qui affiche une liste — le journal d'un membre (R6), un ordre, le
 * fil — n'a besoin que du titre, et le lui faire payer en `lireOeuvre` mettrait
 * trois cents requêtes dans les 10 ms de temps processeur d'une invocation.
 *
 * Le titre corrigé plutôt que le titre de source : afficher la fiche fausse que
 * le membre a justement corrigée (R47) est un défaut visible, et R39 veut que
 * la correction tienne partout, pas seulement sur la page de l'œuvre.
 */
export async function titresCorriges(db: Db, oeuvreIds: string[]): Promise<Map<string, string>> {
	const uniques = [...new Set(oeuvreIds)];
	if (uniques.length === 0) return new Map();

	const [oeuvres, lignes] = await Promise.all([
		db.select({ id: works.id, titre: works.title }).from(works).where(inArray(works.id, uniques)),
		db.query.workCorrections.findMany({
			where: and(inArray(workCorrections.workId, uniques), eq(workCorrections.field, 'titre')),
			orderBy: [asc(workCorrections.createdAt), asc(workCorrections.id)]
		})
	]);

	const titres = new Map(oeuvres.map((o) => [o.id, o.titre]));

	// La plus récente l'emporte, et une correction illisible est ignorée plutôt
	// que de faire disparaître le titre — même règle qu'à la lecture complète.
	for (const ligne of lignes) {
		for (const correction of corrigeesDe([ligne])) {
			if (correction.champ === 'titre') titres.set(ligne.workId, correction.valeur);
		}
	}

	return titres;
}

/**
 * Relit les corrections stockées, en écartant celles qu'on ne sait plus lire.
 *
 * Une correction dont le champ a disparu du modèle ne doit pas empêcher
 * l'affichage de la fiche : le catalogue reste lisible, la correction devient
 * inerte.
 */
function corrigeesDe(lignes: WorkCorrection[]): Correction[] {
	const valides: Correction[] = [];
	for (const ligne of lignes) {
		let brut: unknown;
		try {
			brut = JSON.parse(ligne.value);
		} catch {
			continue;
		}
		const analysee = analyserCorrection(brut);
		if (analysee.ok) valides.push(analysee.valeur);
	}
	return valides;
}

async function chargerNoms(db: Db, ids: string[]): Promise<Map<string, string>> {
	const uniques = [...new Set(ids)];
	if (uniques.length === 0) return new Map();
	const lignes = await db.query.entities.findMany({ where: inArray(entities.id, uniques) });
	return new Map(lignes.map((e) => [e.id, e.name]));
}

async function lireEntite(db: Db, entityId: string | null): Promise<RattachementLocal | null> {
	if (entityId === null) return null;
	const entite = await db.query.entities.findFirst({ where: eq(entities.id, entityId) });
	return entite ? { entityId: entite.id, nom: entite.name } : null;
}

/**
 * Applique les corrections sur la couche de source. Fonction pure — c'est le
 * cœur de la mécanique, et elle se teste sans base.
 *
 * Deux règles :
 *
 * - **Une seule correction par champ compte**, la plus récente. Deux
 *   corrections successives du titre ne se composent pas : la seconde dit ce
 *   que le titre doit être, un point c'est tout.
 * - **Une entité inconnue est ignorée** plutôt que de faire échouer la lecture.
 *   `corriger` la refuse à l'entrée ; si elle a disparu depuis, la fiche
 *   s'affiche quand même.
 */
export function appliquerCorrections(
	base: OeuvreLocale,
	corrections: Correction[],
	noms: Map<string, string>
): OeuvreLocale {
	const derniere = new Map<ChampCorrigible, Correction>();
	for (const correction of corrections) derniere.set(correction.champ, correction);

	const corrigee: OeuvreLocale = { ...base };

	for (const correction of derniere.values()) {
		switch (correction.champ) {
			case 'titre':
				corrigee.titre = correction.valeur;
				break;
			case 'dateDeParution':
				corrigee.dateDeParution = correction.valeur;
				break;
			case 'couvertureUrl':
				corrigee.couvertureUrl = correction.valeur;
				break;
			case 'numeroDansLaSerie':
				corrigee.numeroDansLaSerie = correction.valeur;
				break;
			case 'type':
				corrigee.type = correction.valeur;
				break;
			case 'serie':
				corrigee.serie = rattachement(correction.valeur, noms);
				break;
			case 'event':
				corrigee.event = rattachement(correction.valeur, noms);
				break;
			case 'personnages':
				corrigee.personnages = appliquerDelta(
					base.personnages,
					correction.ajoutes
						.map((id) => rattachement(id, noms))
						.filter((r): r is RattachementLocal => r !== null),
					new Set(correction.retires),
					(p) => p.entityId
				);
				break;
			case 'createurs':
				corrigee.createurs = appliquerDelta(
					base.createurs,
					correction.ajoutes
						.map((c) => {
							const nom = noms.get(c.entityId);
							return nom === undefined ? null : { entityId: c.entityId, nom, role: c.role };
						})
						.filter((c): c is CreateurLocal => c !== null),
					new Set(correction.retires.map((c) => `${c.entityId}\0${c.role}`)),
					(c) => `${c.entityId}\0${c.role}`
				);
				break;
			case 'contenu':
				corrigee.contenu = appliquerDelta(
					base.contenu,
					correction.ajoutes.map((id) => ({ oeuvreId: id, reference: null, rang: 0 })),
					new Set(correction.retires),
					(c) => c.oeuvreId ?? ''
				);
				break;
		}
	}

	return corrigee;
}

function rattachement(
	entityId: string | null,
	noms: Map<string, string>
): RattachementLocal | null {
	if (entityId === null) return null;
	const nom = noms.get(entityId);
	return nom === undefined ? null : { entityId, nom };
}

/** Applique un delta sur une liste : retraits d'abord, puis ajouts non déjà présents. */
function appliquerDelta<T>(
	base: T[],
	ajoutes: T[],
	retires: Set<string>,
	cle: (element: T) => string
): T[] {
	const conserves = base.filter((element) => !retires.has(cle(element)));
	const presents = new Set(conserves.map(cle));
	return [...conserves, ...ajoutes.filter((element) => !presents.has(cle(element)))];
}

function dedoublonner<T>(lignes: T[], cle: (ligne: T) => string): T[] {
	const vus = new Set<string>();
	return lignes.filter((ligne) => {
		const k = cle(ligne);
		if (vus.has(k)) return false;
		vus.add(k);
		return true;
	});
}
