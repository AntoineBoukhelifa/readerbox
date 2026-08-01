import { and, eq, isNull, ne } from 'drizzle-orm';
import {
	entities,
	entitySources,
	workCharacters,
	workContents,
	workCreators,
	workSources,
	works,
	type EtatIngestion,
	type TypeEntite
} from '../db/schema';
import type { Db } from '../db';
import type { Completude, EntiteDistante, OeuvreDistante, ReferenceSource } from './sources/types';
import { rapprocher } from './reconcile';
import { signalerRattachementsModifies } from './rematerialisation';

/**
 * La persistance d'une description amont vers le modèle local.
 *
 * Conformément à KTD1, cette fonction n'est appelée que lorsqu'un membre
 * consigne une œuvre, l'ajoute à un ordre ou l'atteint. Une recherche n'écrit
 * rien.
 *
 * Trois règles gouvernent tout le fichier :
 *
 * 1. **Ce qu'on écrit ici est la couche de source, et rien d'autre.** Les
 *    corrections de membre vivent ailleurs et sont réappliquées à la lecture.
 *    Une ré-ingestion peut donc réécrire librement : elle ne peut pas détruire
 *    une correction (R39).
 * 2. **Une donnée indisponible n'efface jamais une donnée connue.** Si la
 *    source échoue sur la liste des personnages, les personnages déjà en base
 *    restent, l'œuvre passe en ingestion partielle, et le travail est rejouable.
 *    Confondre « la source dit qu'il n'y en a pas » et « la source n'a pas
 *    répondu » amputerait le graphe sans que rien ne le signale.
 * 3. **Les rattachements sont écrits par couche de source.** Ré-ingérer depuis
 *    Metron ne touche pas à ce que Comic Vine avait fourni. La lecture est
 *    l'union.
 */

/**
 * L'état d'ingestion d'une œuvre, dérivé des complétudes déclarées par chacune
 * des sources qui la décrivent. Fonction pure — c'est elle qui porte la règle.
 *
 * Une dimension est **satisfaite** si au moins une source l'a fournie, ou si
 * toutes celles qui se sont exprimées disent qu'elle est vide. Elle ne l'est
 * pas dès qu'une source a échoué sans qu'aucune autre n'ait comblé le trou :
 * c'est exactement la différence entre un numéro des années 60 réellement
 * dépourvu de crédits et un numéro dont la requête a échoué.
 *
 * Les dimensions « sans objet » — le contenu d'un film — sortent du décompte
 * plutôt que d'y compter comme un succès, sans quoi une œuvre dont tout a
 * échoué passerait pour partielle au lieu d'échouée.
 */
export function etatDIngestion(completudes: Completude[]): EtatIngestion {
	if (completudes.length === 0) return 'echouee';

	const dimensions = [
		evaluer(completudes.map((c) => c.personnages)),
		evaluer(completudes.map((c) => c.createurs)),
		evaluer(completudes.map((c) => c.contenu))
	].filter((d) => d !== 'sans objet');

	if (dimensions.length === 0) return 'complete';
	if (dimensions.every((d) => d === 'satisfaite')) return 'complete';
	if (dimensions.every((d) => d === 'manquante')) return 'echouee';
	return 'partielle';
}

type Dimension = 'satisfaite' | 'manquante' | 'sans objet';

function evaluer(valeurs: string[]): Dimension {
	const applicables = valeurs.filter((v) => v !== 'sans objet');
	if (applicables.length === 0) return 'sans objet';
	if (applicables.some((v) => v === 'fournis' || v === 'fourni')) return 'satisfaite';
	if (applicables.every((v) => v === 'absents' || v === 'absent')) return 'satisfaite';
	return 'manquante';
}

export interface ResultatIngestion {
	oeuvreId: string;
	/** L'œuvre vient-elle d'être créée, ou une description existante a-t-elle été enrichie ? */
	creee: boolean;
	etat: EtatIngestion;
	/** Les rattachements ont-ils changé — donc le graphe doit-il être rejoué ? */
	rattachementsModifies: boolean;
}

/**
 * Persiste une description amont, en créant l'œuvre ou en enrichissant celle
 * qui la décrivait déjà.
 *
 * Le rapprochement passe par `reconcile.ts` : identifiant de source d'abord,
 * triplet ensuite, création sinon. En cas de doute, une seconde œuvre est
 * créée — c'est le parti pris assumé du projet.
 */
export async function ingererOeuvre(
	db: Db,
	distante: OeuvreDistante,
	options: { now?: number } = {}
): Promise<ResultatIngestion> {
	const maintenant = options.now ?? Date.now();
	const source = distante.reference.source;

	const serieEntityId = distante.serie
		? await resoudreEntite(db, 'serie', distante.serie, maintenant)
		: null;
	const eventEntityId = distante.event
		? await resoudreEntite(db, 'event', distante.event, maintenant)
		: null;

	const rapprochee = await rapprocher(db, {
		reference: distante.reference,
		type: distante.type,
		serieEntityId,
		numeroDansLaSerie: distante.numeroDansLaSerie ?? null,
		dateDeParution: distante.dateDeParution ?? null
	});

	// Les champs facultatifs ne sont posés que lorsque la source les fournit :
	// une seconde source muette sur la date ne doit pas effacer la première.
	const champsDeSource = {
		type: distante.type,
		title: distante.titre,
		updatedAt: maintenant,
		...(distante.dateDeParution !== undefined ? { releaseDate: distante.dateDeParution } : {}),
		...(distante.numeroDansLaSerie !== undefined
			? { numberInSeries: distante.numeroDansLaSerie }
			: {}),
		...(serieEntityId !== null ? { seriesEntityId: serieEntityId } : {}),
		...(eventEntityId !== null ? { eventEntityId } : {}),
		...(distante.couvertureUrl !== undefined ? { coverUrl: distante.couvertureUrl } : {})
	};

	let oeuvreId: string;
	const creee = rapprochee === null;
	let empreinteAvant = '';

	if (rapprochee === null) {
		const [ligne] = await db
			.insert(works)
			.values({
				...champsDeSource,
				ingestionState: etatDIngestion([distante.completude]),
				createdAt: maintenant
			})
			.returning({ id: works.id });
		oeuvreId = ligne.id;
	} else {
		oeuvreId = rapprochee.oeuvreId;
		empreinteAvant = await empreinteDesRattachements(db, oeuvreId);
		await db.update(works).set(champsDeSource).where(eq(works.id, oeuvreId));
	}

	await db
		.insert(workSources)
		.values({
			workId: oeuvreId,
			source,
			externalId: distante.reference.idExterne,
			charactersCompleteness: distante.completude.personnages,
			creatorsCompleteness: distante.completude.createurs,
			contentsCompleteness: distante.completude.contenu,
			ingestedAt: maintenant
		})
		.onConflictDoUpdate({
			target: [workSources.source, workSources.externalId],
			set: {
				workId: oeuvreId,
				charactersCompleteness: distante.completude.personnages,
				creatorsCompleteness: distante.completude.createurs,
				contentsCompleteness: distante.completude.contenu,
				ingestedAt: maintenant
			}
		});

	await ecrireCouche(
		distante.completude.personnages,
		() =>
			db
				.delete(workCharacters)
				.where(and(eq(workCharacters.workId, oeuvreId), eq(workCharacters.source, source))),
		async () => {
			if (distante.personnages.length === 0) return;
			const lignes = [];
			for (const [rang, personnage] of distante.personnages.entries()) {
				lignes.push({
					workId: oeuvreId,
					entityId: await resoudreEntite(db, 'personnage', personnage, maintenant),
					source,
					position: rang
				});
			}
			await db.insert(workCharacters).values(lignes).onConflictDoNothing();
		}
	);

	await ecrireCouche(
		distante.completude.createurs,
		() =>
			db
				.delete(workCreators)
				.where(and(eq(workCreators.workId, oeuvreId), eq(workCreators.source, source))),
		async () => {
			if (distante.createurs.length === 0) return;
			const lignes = [];
			for (const [rang, createur] of distante.createurs.entries()) {
				lignes.push({
					workId: oeuvreId,
					entityId: await resoudreEntite(db, 'createur', createur, maintenant),
					source,
					role: createur.role,
					position: rang
				});
			}
			await db.insert(workCreators).values(lignes).onConflictDoNothing();
		}
	);

	await ecrireCouche(
		distante.completude.contenu,
		() =>
			db
				.delete(workContents)
				.where(and(eq(workContents.containerWorkId, oeuvreId), eq(workContents.source, source))),
		async () => {
			if (distante.contenu.length === 0) return;
			const lignes = [];
			for (const [rang, reference] of distante.contenu.entries()) {
				lignes.push({
					containerWorkId: oeuvreId,
					source: reference.source,
					externalId: reference.idExterne,
					contentWorkId: await oeuvreDe(db, reference),
					rank: rang
				});
			}
			await db.insert(workContents).values(lignes).onConflictDoNothing();
		}
	);

	// Cette œuvre est peut-être le contenu d'un recueil déjà ingéré, dont la
	// référence attendait d'être résolue. C'est la moitié amont de la cascade
	// de U5 : la ligne existait, elle pointe maintenant vers quelque chose.
	await db
		.update(workContents)
		.set({ contentWorkId: oeuvreId })
		.where(
			and(
				eq(workContents.source, source),
				eq(workContents.externalId, distante.reference.idExterne),
				isNull(workContents.contentWorkId),
				ne(workContents.containerWorkId, oeuvreId)
			)
		);

	const etat = await recalculerEtat(db, oeuvreId);
	const rattachementsModifies =
		!creee && (await empreinteDesRattachements(db, oeuvreId)) !== empreinteAvant;

	// Une œuvre qui vient d'être créée n'a été atteinte par personne : il n'y a
	// aucun appui de graphe à rejouer, et enfiler une demande vide ferait du
	// bruit dans la file du Cron Trigger.
	if (rattachementsModifies) {
		await signalerRattachementsModifies(db, oeuvreId, 'ingestion', maintenant);
	}

	return { oeuvreId, creee, etat, rattachementsModifies };
}

/**
 * Écrit une couche de rattachement pour une source donnée.
 *
 * `indisponible` ne touche à rien : c'est la règle qui rend l'ingestion
 * partielle rejouable sans perte. `absent` efface bel et bien la couche de
 * cette source — la source affirme qu'il n'y a rien, et son affirmation
 * précédente ne vaut plus.
 */
async function ecrireCouche(
	completude: string,
	effacer: () => Promise<unknown>,
	ecrire: () => Promise<void>
): Promise<void> {
	if (completude === 'indisponible' || completude === 'indisponibles') return;
	if (completude === 'sans objet') return;
	await effacer();
	if (completude === 'fournis' || completude === 'fourni') await ecrire();
}

/**
 * Résout une entité amont en entité locale, ou la crée.
 *
 * La clé est `(source, type, id externe)` : rien ne rapproche deux entités
 * décrites par deux sources différentes. Rapprocher sur le nom exact
 * fusionnerait les homonymes, et l'univers Marvel en compte assez — plusieurs
 * Captain Marvel, plusieurs Spider-Man — pour que ce soit une perte de données
 * là où un doublon n'est qu'un désagrément.
 */
async function resoudreEntite(
	db: Db,
	type: TypeEntite,
	distante: EntiteDistante,
	maintenant: number
): Promise<string> {
	const connue = await db.query.entitySources.findFirst({
		where: and(
			eq(entitySources.source, distante.reference.source),
			eq(entitySources.entityType, type),
			eq(entitySources.externalId, distante.reference.idExterne)
		)
	});

	if (connue) {
		// Le nom amont change parfois — désambiguïsation, correction de coquille.
		await db.update(entities).set({ name: distante.nom }).where(eq(entities.id, connue.entityId));
		return connue.entityId;
	}

	const [creee] = await db
		.insert(entities)
		.values({ type, name: distante.nom, createdAt: maintenant })
		.returning({ id: entities.id });

	await db.insert(entitySources).values({
		entityId: creee.id,
		entityType: type,
		source: distante.reference.source,
		externalId: distante.reference.idExterne,
		createdAt: maintenant
	});

	return creee.id;
}

/** L'œuvre locale portant cette référence de source, si elle est déjà connue. */
async function oeuvreDe(db: Db, reference: ReferenceSource): Promise<string | null> {
	const ligne = await db.query.workSources.findFirst({
		where: and(
			eq(workSources.source, reference.source),
			eq(workSources.externalId, reference.idExterne)
		)
	});
	return ligne?.workId ?? null;
}

/**
 * Une empreinte des rattachements qui alimentent le graphe : personnages,
 * série, event. Les créateurs n'y figurent pas — ils ne sont pas des nœuds
 * (KTD4) — ni le contenu d'un recueil, dont l'effet sur le graphe passe par la
 * cascade de consignation de U5 et non par les appuis de cette œuvre.
 */
async function empreinteDesRattachements(db: Db, oeuvreId: string): Promise<string> {
	const oeuvre = await db.query.works.findFirst({ where: eq(works.id, oeuvreId) });
	const personnages = await db.query.workCharacters.findMany({
		where: eq(workCharacters.workId, oeuvreId)
	});

	const identifiants = [...new Set(personnages.map((p) => p.entityId))].sort();
	return [oeuvre?.seriesEntityId ?? '', oeuvre?.eventEntityId ?? '', ...identifiants].join('|');
}

/** Recalcule et écrit l'état d'ingestion depuis toutes les sources de l'œuvre. */
async function recalculerEtat(db: Db, oeuvreId: string): Promise<EtatIngestion> {
	const sources = await db.query.workSources.findMany({
		where: eq(workSources.workId, oeuvreId)
	});

	const etat = etatDIngestion(
		sources.map((s) => ({
			personnages: s.charactersCompleteness,
			createurs: s.creatorsCompleteness,
			contenu: s.contentsCompleteness
		}))
	);

	await db.update(works).set({ ingestionState: etat }).where(eq(works.id, oeuvreId));
	return etat;
}

export interface OeuvreARejouer {
	oeuvreId: string;
	etat: EtatIngestion;
	/** Chez quelle source, et sur quelles sous-ressources, le travail reste à faire. */
	aRejouer: {
		reference: ReferenceSource;
		sousRessources: ('personnages' | 'createurs' | 'contenu')[];
	}[];
}

/**
 * Les ingestions à rejouer, avec la source et les sous-ressources précises qui
 * ont échoué.
 *
 * C'est ce qui rend une ingestion partielle rejouable au sens de U3 : le
 * rattrapage n'a pas à redemander une fiche entière ni à deviner ce qui
 * manquait. Destiné au Cron Trigger, jamais au chemin de rendu.
 */
export async function oeuvresARejouer(db: Db, limite = 100): Promise<OeuvreARejouer[]> {
	const incompletes = await db.query.works.findMany({
		where: ne(works.ingestionState, 'complete'),
		limit: limite
	});

	const resultats: OeuvreARejouer[] = [];
	for (const oeuvre of incompletes) {
		const sources = await db.query.workSources.findMany({
			where: eq(workSources.workId, oeuvre.id)
		});

		const aRejouer = sources
			.map((s) => ({
				reference: { source: s.source, idExterne: s.externalId },
				sousRessources: (
					[
						['personnages', s.charactersCompleteness],
						['createurs', s.creatorsCompleteness],
						['contenu', s.contentsCompleteness]
					] as const
				)
					.filter(([, valeur]) => valeur === 'indisponibles' || valeur === 'indisponible')
					.map(([nom]) => nom)
			}))
			.filter((s) => s.sousRessources.length > 0);

		resultats.push({ oeuvreId: oeuvre.id, etat: oeuvre.ingestionState, aRejouer });
	}

	return resultats;
}
