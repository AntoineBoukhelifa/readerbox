import { describe, expect, it } from 'vitest';
import { createTestDb } from '../db/testing';
import { entrer, memeNom, nomsPresents, normaliserLeNom, NOM_MAX } from './entree';
import { markMemberAsLeft } from './sessions';

const T0 = 1_700_000_000_000;

describe('normalisation du nom', () => {
	it('coupe les bords et réduit les espaces intérieurs', () => {
		expect(normaliserLeNom('  Jean   Luc  ')).toBe('Jean Luc');
	});

	it('pardonne la casse et les accents, qui varient d une frappe à l autre', () => {
		expect(memeNom('antoine', 'Antoine')).toBe(true);
		expect(memeNom('Antoíne', 'Antoine')).toBe(true);
		expect(memeNom(' Jean  Luc ', 'jean luc')).toBe(true);
	});

	it('ne confond pas deux personnes différentes', () => {
		expect(memeNom('Antoine', 'Antonin')).toBe(false);
	});
});

describe('entrer librement', () => {
	it('crée le membre quand le nom est neuf', async () => {
		const db = createTestDb();
		const entree = await entrer(db, 'Antoine', T0);

		expect(entree).toMatchObject({ ok: true, nouveau: true });
		expect(await db.query.members.findMany()).toHaveLength(1);
	});

	it('REND LE MÊME membre quand le nom est déjà là — c est la reconnexion', async () => {
		const db = createTestDb();
		const premier = await entrer(db, 'Antoine', T0);
		if (!premier.ok) throw new Error('entrée refusée à tort');

		const retour = await entrer(db, '  antoine ', T0 + 1000);

		expect(retour).toEqual({ ok: true, membreId: premier.membreId, nouveau: false });
		// Le point de tout l'exercice : aucun jumeau au journal vide.
		expect(await db.query.members.findMany()).toHaveLength(1);
	});

	it('refuse un nom d une seule lettre', async () => {
		const db = createTestDb();
		expect(await entrer(db, 'A', T0)).toEqual({ ok: false, motif: 'trop court' });
	});

	it('refuse un nom vide ou blanc', async () => {
		const db = createTestDb();
		expect(await entrer(db, '   ', T0)).toEqual({ ok: false, motif: 'trop court' });
	});

	it('refuse un nom démesuré', async () => {
		const db = createTestDb();
		expect(await entrer(db, 'x'.repeat(NOM_MAX + 1), T0)).toEqual({
			ok: false,
			motif: 'trop long'
		});
	});

	it('enregistre le nom normalisé, pas la frappe brute', async () => {
		const db = createTestDb();
		await entrer(db, '  Jean   Luc  ', T0);

		const [membre] = await db.query.members.findMany();
		expect(membre.displayName).toBe('Jean Luc');
	});

	it('R38 — le nom d un membre parti ne le fait pas revenir', async () => {
		const db = createTestDb();
		const parti = await entrer(db, 'Antoine', T0);
		if (!parti.ok) throw new Error('entrée refusée à tort');
		await markMemberAsLeft(db, parti.membreId, T0 + 1);

		const retour = await entrer(db, 'Antoine', T0 + 2);

		expect(retour).toMatchObject({ ok: true, nouveau: true });
		if (!retour.ok) throw new Error('entrée refusée à tort');
		expect(retour.membreId).not.toBe(parti.membreId);
	});
});

describe('noms présents', () => {
	it('rend les membres dans leur ordre d arrivée', async () => {
		const db = createTestDb();
		await entrer(db, 'Antoine', T0);
		await entrer(db, 'Camille', T0 + 1);

		expect((await nomsPresents(db)).map((membre) => membre.nom)).toEqual(['Antoine', 'Camille']);
	});

	it('R38 — n annonce pas un membre parti', async () => {
		const db = createTestDb();
		const parti = await entrer(db, 'Antoine', T0);
		if (!parti.ok) throw new Error('entrée refusée à tort');
		await entrer(db, 'Camille', T0 + 1);
		await markMemberAsLeft(db, parti.membreId, T0 + 2);

		expect((await nomsPresents(db)).map((membre) => membre.nom)).toEqual(['Camille']);
	});
});
