import { integer, sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

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
