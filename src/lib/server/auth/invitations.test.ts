import { describe, expect, it } from 'vitest';
import { createTestDb } from '../db/testing';
import {
	INVITATION_TTL_MS,
	createInvitation,
	invitationState,
	redeemInvitation,
	revokeInvitation
} from './invitations';
import { generateToken, hashToken, timingSafeEqual } from './tokens';

const T0 = 1_700_000_000_000;

/** Fait entrer un membre par la porte fondatrice, pour disposer d'un émetteur. */
async function foundingMember(db: ReturnType<typeof createTestDb>, name = 'Antoine') {
	const { token } = await createInvitation(db, { createdBy: null, now: T0 });
	const result = await redeemInvitation(db, token, name, T0);
	if (!result.ok) throw new Error('la porte fondatrice devrait toujours s ouvrir');
	return result.memberId;
}

describe('jetons', () => {
	it('produit des jetons distincts et suffisamment longs', () => {
		const a = generateToken();
		const b = generateToken();
		expect(a).not.toBe(b);
		expect(a.length).toBeGreaterThanOrEqual(43);
	});

	it('ne stocke jamais le jeton lui-même : son empreinte est stable et différente', async () => {
		const token = generateToken();
		const hash = await hashToken(token);
		expect(hash).not.toBe(token);
		expect(hash).toHaveLength(64);
		expect(await hashToken(token)).toBe(hash);
	});

	it('compare deux empreintes sans se laisser distinguer par la longueur', () => {
		expect(timingSafeEqual('abc', 'abc')).toBe(true);
		expect(timingSafeEqual('abc', 'abd')).toBe(false);
		expect(timingSafeEqual('abc', 'abcd')).toBe(false);
	});
});

describe("état d'une invitation", () => {
	const base = {
		id: 'i1',
		tokenHash: 'h',
		createdBy: null,
		createdAt: T0,
		expiresAt: T0 + 1000,
		consumedAt: null,
		consumedBy: null,
		revokedAt: null
	};

	it('est valide avant son échéance', () => {
		expect(invitationState(base, T0)).toBe('valide');
	});

	it('expire à l échéance exacte, pas après', () => {
		expect(invitationState(base, T0 + 1000)).toBe('expirée');
	});

	it('rapporte la consommation même si une révocation a suivi', () => {
		const consumedThenRevoked = { ...base, consumedAt: T0 + 1, revokedAt: T0 + 2 };
		expect(invitationState(consumedThenRevoked, T0 + 3)).toBe('consommée');
	});
});

describe('cycle de vie complet', () => {
	it('un lien valide crée un membre', async () => {
		const db = createTestDb();
		const inviter = await foundingMember(db);

		const { token } = await createInvitation(db, { createdBy: inviter, now: T0 });
		const result = await redeemInvitation(db, token, 'Camille', T0 + 1);

		expect(result).toEqual({ ok: true, memberId: expect.any(String) });
	});

	it('un lien déjà consommé est refusé', async () => {
		const db = createTestDb();
		const inviter = await foundingMember(db);
		const { token } = await createInvitation(db, { createdBy: inviter, now: T0 });

		await redeemInvitation(db, token, 'Camille', T0 + 1);
		const second = await redeemInvitation(db, token, 'Intrus', T0 + 2);

		expect(second).toEqual({ ok: false, reason: 'consommée' });
	});

	it('un lien expiré est refusé', async () => {
		const db = createTestDb();
		const inviter = await foundingMember(db);
		const { token } = await createInvitation(db, { createdBy: inviter, now: T0 });

		const result = await redeemInvitation(db, token, 'Camille', T0 + INVITATION_TTL_MS + 1);

		expect(result).toEqual({ ok: false, reason: 'expirée' });
	});

	it('un lien révoqué est refusé, même bien avant son expiration', async () => {
		const db = createTestDb();
		const inviter = await foundingMember(db);
		const { token, invitationId } = await createInvitation(db, { createdBy: inviter, now: T0 });

		expect(await revokeInvitation(db, invitationId, T0 + 1)).toBe('révoquée');
		const result = await redeemInvitation(db, token, 'Camille', T0 + 2);

		expect(result).toEqual({ ok: false, reason: 'révoquée' });
	});

	it('un jeton inconnu est refusé sans révéler ce qui cloche', async () => {
		const db = createTestDb();
		await foundingMember(db);

		const result = await redeemInvitation(db, generateToken(), 'Intrus', T0);

		expect(result).toEqual({ ok: false, reason: 'introuvable' });
	});

	it('une invitation déjà consommée ne se révoque pas', async () => {
		const db = createTestDb();
		const inviter = await foundingMember(db);
		const { token, invitationId } = await createInvitation(db, { createdBy: inviter, now: T0 });
		await redeemInvitation(db, token, 'Camille', T0 + 1);

		expect(await revokeInvitation(db, invitationId, T0 + 2)).toBe('déjà consommée');
	});

	it("n'importe quel membre peut inviter — il n'y a pas de rôle", async () => {
		const db = createTestDb();
		const inviter = await foundingMember(db);
		const { token } = await createInvitation(db, { createdBy: inviter, now: T0 });
		const invited = await redeemInvitation(db, token, 'Camille', T0 + 1);
		if (!invited.ok) throw new Error('invitation refusée à tort');

		const relayed = await createInvitation(db, { createdBy: invited.memberId, now: T0 + 2 });
		const third = await redeemInvitation(db, relayed.token, 'Léa', T0 + 3);

		expect(third.ok).toBe(true);
	});
});
