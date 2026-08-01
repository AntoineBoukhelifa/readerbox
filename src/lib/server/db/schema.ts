import {
	integer,
	sqliteTable,
	text,
	index,
	primaryKey,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { NOMS_DE_SOURCE, TYPES_OEUVRE } from '../catalog/sources/types';

const now = () => Date.now();
const uuid = () => crypto.randomUUID();

/**
 * Un membre du groupe. On n'entre que sur invitation (R40).
 *
 * `leftAt` matérialise le départ (R38) : le membre perd l'accès et sa capacité
 * à inviter, mais ses avis et ses notes restent — anonymisés — et les ordres
 * qu'il a créés restent suivables.
 */
export const members = sqliteTable('members', {
	id: text('id').primaryKey().$defaultFn(uuid),
	displayName: text('display_name').notNull(),
	createdAt: integer('created_at').notNull().$defaultFn(now),
	leftAt: integer('left_at')
});

/**
 * Une invitation à usage unique, à durée limitée et révocable.
 *
 * Le jeton brut n'est jamais stocké : seule son empreinte l'est. Une fuite de
 * la base ne donne donc aucun lien utilisable.
 *
 * `createdBy` est nul pour l'invitation fondatrice, celle qui fait entrer le
 * premier membre alors qu'aucun membre n'existe encore pour l'émettre.
 */
export const invitations = sqliteTable(
	'invitations',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		tokenHash: text('token_hash').notNull().unique(),
		createdBy: text('created_by').references(() => members.id),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		expiresAt: integer('expires_at').notNull(),
		consumedAt: integer('consumed_at'),
		consumedBy: text('consumed_by').references(() => members.id),
		revokedAt: integer('revoked_at')
	},
	(table) => [index('invitations_created_by_idx').on(table.createdBy)]
);

/**
 * Une session authentifiée.
 *
 * Même traitement du jeton que pour les invitations : seule l'empreinte est
 * stockée. `revokedAt` permet de couper l'accès immédiatement — c'est ce que
 * R38 exige au départ d'un membre, sans attendre l'expiration naturelle.
 */
export const sessions = sqliteTable(
	'sessions',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		tokenHash: text('token_hash').notNull().unique(),
		memberId: text('member_id')
			.notNull()
			.references(() => members.id),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		expiresAt: integer('expires_at').notNull(),
		revokedAt: integer('revoked_at')
	},
	(table) => [index('sessions_member_id_idx').on(table.memberId)]
);

export type Member = typeof members.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type Session = typeof sessions.$inferSelect;

// ---------------------------------------------------------------------------
// Catalogue (U3a)
// ---------------------------------------------------------------------------

/**
 * Les entités de rattachement de R12.
 *
 * Personnage, série et event sont exactement les trois familles de nœuds du
 * graphe (KTD4) ; le créateur n'en est pas un mais se range ici parce qu'il
 * porte la même identité multi-sources et alimente la recherche de R45. Une
 * seule table plutôt que quatre : U9 lit les nœuds uniformément, sans avoir à
 * savoir dans quelle table chercher l'extrémité d'une arête.
 */
export const TYPES_ENTITE = ['personnage', 'serie', 'event', 'createur'] as const;
export type TypeEntite = (typeof TYPES_ENTITE)[number];

/** L'état d'ingestion d'une œuvre, dérivé des complétudes déclarées par ses sources. */
export const ETATS_INGESTION = ['complete', 'partielle', 'echouee'] as const;
export type EtatIngestion = (typeof ETATS_INGESTION)[number];

/** Ce qui a provoqué une demande de re-matérialisation du graphe. */
export const MOTIFS_REMATERIALISATION = ['ingestion', 'correction', 'fusion'] as const;
export type MotifRematerialisation = (typeof MOTIFS_REMATERIALISATION)[number];

export const entities = sqliteTable(
	'entities',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		type: text('type', { enum: TYPES_ENTITE }).notNull(),
		name: text('name').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now)
	},
	(table) => [index('entities_type_name_idx').on(table.type, table.name)]
);

/**
 * L'identité d'une entité chez une source.
 *
 * `entityType` est recopié depuis l'entité pour que la clé primaire soit
 * `(source, type, id externe)` : les espaces d'identifiants sont séparés par
 * type chez toutes les sources visées — le personnage 1234 et la série 1234 de
 * Comic Vine n'ont rien à voir, et les confondre relierait des nœuds au hasard.
 *
 * Rien ne rapproche automatiquement deux entités décrites par deux sources
 * différentes : le même personnage vu par Metron et par Comic Vine produit deux
 * lignes `entities`. Rapprocher sur le nom exact fusionnerait les homonymes —
 * et l'univers Marvel en est plein — ce qui est une perte de données là où un
 * doublon n'est qu'un désagrément. La fusion reste donc un geste manuel.
 */
export const entitySources = sqliteTable(
	'entity_sources',
	{
		entityId: text('entity_id')
			.notNull()
			.references(() => entities.id),
		entityType: text('entity_type', { enum: TYPES_ENTITE }).notNull(),
		source: text('source', { enum: NOMS_DE_SOURCE }).notNull(),
		externalId: text('external_id').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now)
	},
	(table) => [
		primaryKey({ columns: [table.source, table.entityType, table.externalId] }),
		index('entity_sources_entity_id_idx').on(table.entityId)
	]
);

/**
 * Une œuvre du catalogue : numéro, recueil, film, série, saison, épisode ou
 * roman (R7), dans une table unique portant un type discriminant.
 *
 * Deux partis pris structurent cette table :
 *
 * 1. **Elle ne porte que la donnée de source.** Les corrections de membre (R47)
 *    vivent dans `workCorrections` et s'appliquent par-dessus à la lecture. Une
 *    ré-ingestion réécrit ici sans jamais toucher là-bas : c'est ce qui rend
 *    R39 structurel plutôt que dépendant de la discipline de l'appelant.
 * 2. **`ingestionState` est dérivé** des complétudes que chaque source a
 *    déclarées (voir `workSources`). Il est malgré tout stocké, parce que le
 *    rattrapage doit retrouver par index les œuvres à rejouer sans balayer
 *    toute la table. Un seul endroit l'écrit : `catalog/ingest.ts`.
 *
 * `seriesEntityId` porte l'appartenance de R8 dans les deux sens : un numéro ou
 * une saison désigne la série qui le regroupe, et l'œuvre de type `serie` —
 * celle qu'un membre consigne et qui agrège les notes de ses numéros (R13) —
 * désigne sa propre entité. Les numéros d'une série sont donc tous les works
 * partageant `seriesEntityId`, sans table supplémentaire.
 */
export const works = sqliteTable(
	'works',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		type: text('type', { enum: TYPES_OEUVRE }).notNull(),
		title: text('title').notNull(),
		/** ISO 8601, jour compris quand la source le donne. */
		releaseDate: text('release_date'),
		seriesEntityId: text('series_entity_id').references(() => entities.id),
		numberInSeries: integer('number_in_series'),
		eventEntityId: text('event_entity_id').references(() => entities.id),
		coverUrl: text('cover_url'),
		ingestionState: text('ingestion_state', { enum: ETATS_INGESTION }).notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		updatedAt: integer('updated_at').notNull().$defaultFn(now)
	},
	(table) => [
		index('works_series_number_idx').on(table.seriesEntityId, table.numberInSeries),
		index('works_event_idx').on(table.eventEntityId),
		index('works_ingestion_state_idx').on(table.ingestionState),
		index('works_type_title_idx').on(table.type, table.title)
	]
);

/**
 * Les identifiants de source d'une œuvre — au pluriel, et c'est le point.
 *
 * Une œuvre conserve l'identifiant de *toutes* les sources qui la décrivent.
 * N'en garder qu'un rendrait impossible de rapprocher plus tard une troisième
 * description sans perdre l'historique, et interdirait de rejouer l'ingestion
 * auprès de la source précise qui avait échoué.
 *
 * Les trois complétudes sont celles du type `Completude` de `sources/types.ts`,
 * stockées **par source** parce que c'est là qu'elles ont un sens : une source
 * qui échoue sur les personnages ne dit rien de ce qu'une autre a fourni.
 */
export const workSources = sqliteTable(
	'work_sources',
	{
		workId: text('work_id')
			.notNull()
			.references(() => works.id),
		source: text('source', { enum: NOMS_DE_SOURCE }).notNull(),
		externalId: text('external_id').notNull(),
		charactersCompleteness: text('characters_completeness', {
			enum: ['fournis', 'absents', 'indisponibles']
		}).notNull(),
		creatorsCompleteness: text('creators_completeness', {
			enum: ['fournis', 'absents', 'indisponibles']
		}).notNull(),
		contentsCompleteness: text('contents_completeness', {
			enum: ['fourni', 'absent', 'indisponible', 'sans objet']
		}).notNull(),
		ingestedAt: integer('ingested_at').notNull().$defaultFn(now)
	},
	(table) => [
		primaryKey({ columns: [table.source, table.externalId] }),
		index('work_sources_work_id_idx').on(table.workId)
	]
);

/**
 * Les personnages crédités d'une œuvre (R12) — la donnée dont dépend tout le
 * graphe.
 *
 * Le rattachement porte la source qui l'affirme. Sans elle, ré-ingérer depuis
 * Metron effacerait les personnages que Comic Vine avait fournis : la lecture
 * est l'union sur toutes les sources, l'écriture ne remplace que la couche de
 * la source qui vient de répondre.
 */
export const workCharacters = sqliteTable(
	'work_characters',
	{
		workId: text('work_id')
			.notNull()
			.references(() => works.id),
		entityId: text('entity_id')
			.notNull()
			.references(() => entities.id),
		source: text('source', { enum: NOMS_DE_SOURCE }).notNull(),
		/** Le rang dans la liste amont : les sources classent souvent par importance. */
		position: integer('position').notNull().default(0)
	},
	(table) => [
		primaryKey({ columns: [table.workId, table.entityId, table.source] }),
		index('work_characters_entity_id_idx').on(table.entityId)
	]
);

/** Les créateurs crédités (R12). Même logique de couche par source que les personnages. */
export const workCreators = sqliteTable(
	'work_creators',
	{
		workId: text('work_id')
			.notNull()
			.references(() => works.id),
		entityId: text('entity_id')
			.notNull()
			.references(() => entities.id),
		source: text('source', { enum: NOMS_DE_SOURCE }).notNull(),
		/** Scénario, dessin, encrage… tel que la source le libelle. */
		role: text('role').notNull(),
		position: integer('position').notNull().default(0)
	},
	(table) => [
		primaryKey({ columns: [table.workId, table.entityId, table.source, table.role] }),
		index('work_creators_entity_id_idx').on(table.entityId)
	]
);

/**
 * Ce qu'un recueil ou une saison contient (R8).
 *
 * `contentWorkId` est nullable et c'est délibéré : KTD1 interdit d'ingérer les
 * quarante numéros d'un omnibus au moment où l'on ingère l'omnibus. On conserve
 * donc la référence amont telle que la source la donne, et on la résout au fur
 * et à mesure — c'est cette liste que la cascade de U5 parcourt pour savoir
 * quoi ingérer, et une ligne non résolue est un travail restant, pas une perte.
 *
 * La table est en plusieurs lignes par contenant plutôt qu'un champ parent sur
 * l'œuvre contenue, parce qu'un numéro appartient couramment à plusieurs
 * recueils à la fois — R34 en dépend directement.
 */
export const workContents = sqliteTable(
	'work_contents',
	{
		containerWorkId: text('container_work_id')
			.notNull()
			.references(() => works.id),
		source: text('source', { enum: NOMS_DE_SOURCE }).notNull(),
		externalId: text('external_id').notNull(),
		contentWorkId: text('content_work_id').references(() => works.id),
		rank: integer('rank').notNull().default(0)
	},
	(table) => [
		primaryKey({ columns: [table.containerWorkId, table.source, table.externalId] }),
		index('work_contents_content_work_id_idx').on(table.contentWorkId)
	]
);

/**
 * Une correction de fiche par un membre (R47).
 *
 * Stockée à côté de la donnée de source, jamais à sa place. Une ré-ingestion
 * réécrit `works` et les tables de rattachement ; ces lignes-ci ne bougent pas
 * et sont réappliquées à la lecture suivante. C'est toute la mécanique de R39.
 *
 * `value` est la correction sérialisée en JSON, y compris le nom du champ : le
 * format dépend du champ (remplacement pour un scalaire, delta ajouts/retraits
 * pour une liste de rattachements) et `catalog/corrections.ts` le valide à
 * l'entrée comme à la relecture. Une correction plus récente sur le même champ
 * remplace la précédente ; aucune n'est effacée, l'historique reste lisible.
 */
export const workCorrections = sqliteTable(
	'work_corrections',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		workId: text('work_id')
			.notNull()
			.references(() => works.id),
		memberId: text('member_id')
			.notNull()
			.references(() => members.id),
		field: text('field').notNull(),
		value: text('value').notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now)
	},
	(table) => [index('work_corrections_work_id_idx').on(table.workId, table.createdAt)]
);

/**
 * Le point d'appel de KTD4 pour U9 : les œuvres dont les rattachements ont
 * changé sans qu'aucun état de lecture n'ait bougé.
 *
 * C'est le second déclencheur de la matérialisation du graphe, et son absence
 * serait un défaut silencieux et permanent — un personnage ajouté par une
 * correction à une œuvre déjà atteinte n'apparaîtrait jamais dans aucun graphe.
 *
 * Une table plutôt qu'une fonction de rappel, pour deux raisons. D'abord la
 * durabilité : un rappel en mémoire disparaît si l'invocation Worker s'arrête,
 * et la demande serait perdue sans trace. Ensuite l'ordonnancement : le
 * rejeu des appuis se fait pour tous les membres ayant atteint l'œuvre, ce qui
 * dépasse les 10 ms de temps processeur d'une requête — il appartient au Cron
 * Trigger, seul ordonnanceur du palier gratuit, qui a besoin de lire une file.
 *
 * U9 consomme via `catalog/rematerialisation.ts` et marque `processedAt`.
 */
export const graphRematerializations = sqliteTable(
	'graph_rematerializations',
	{
		id: text('id').primaryKey().$defaultFn(uuid),
		workId: text('work_id')
			.notNull()
			.references(() => works.id),
		reason: text('reason', { enum: MOTIFS_REMATERIALISATION }).notNull(),
		createdAt: integer('created_at').notNull().$defaultFn(now),
		processedAt: integer('processed_at')
	},
	(table) => [
		index('graph_remat_pending_idx').on(table.processedAt, table.createdAt),
		uniqueIndex('graph_remat_pending_unique_idx')
			.on(table.workId, table.reason)
			.where(sql`processed_at is null`)
	]
);

export type Entity = typeof entities.$inferSelect;
export type EntitySource = typeof entitySources.$inferSelect;
export type Work = typeof works.$inferSelect;
export type WorkSource = typeof workSources.$inferSelect;
export type WorkCharacter = typeof workCharacters.$inferSelect;
export type WorkCreator = typeof workCreators.$inferSelect;
export type WorkContent = typeof workContents.$inferSelect;
export type WorkCorrection = typeof workCorrections.$inferSelect;
export type GraphRematerialization = typeof graphRematerializations.$inferSelect;
