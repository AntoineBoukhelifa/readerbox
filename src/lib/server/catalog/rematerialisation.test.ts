import { describe, expect, it } from 'vitest';
import { createTestDb } from '../db/testing';
import { ingererOeuvre } from './ingest';
import {
	enAttente,
	estEnAttente,
	marquerTraitees,
	signalerRattachementsModifies
} from './rematerialisation';
import { T0, oeuvreDistante } from './testing';

describe('file de re-matérialisation du graphe', () => {
	it('enfile une demande lisible par U9', async () => {
		const db = createTestDb();
		const { oeuvreId } = await ingererOeuvre(db, oeuvreDistante('metron', '4021'), { now: T0 });

		await signalerRattachementsModifies(db, oeuvreId, 'correction', T0 + 1);

		expect(await enAttente(db)).toEqual([
			expect.objectContaining({ workId: oeuvreId, reason: 'correction', processedAt: null })
		]);
	});

	it('ne réenfile pas la même demande : le rejeu lit l état final, pas le delta', async () => {
		const db = createTestDb();
		const { oeuvreId } = await ingererOeuvre(db, oeuvreDistante('metron', '4021'), { now: T0 });

		await signalerRattachementsModifies(db, oeuvreId, 'correction', T0 + 1);
		await signalerRattachementsModifies(db, oeuvreId, 'correction', T0 + 2);

		expect(await enAttente(db)).toHaveLength(1);
	});

	it('distingue les motifs, pour que le diagnostic reste possible', async () => {
		const db = createTestDb();
		const { oeuvreId } = await ingererOeuvre(db, oeuvreDistante('metron', '4021'), { now: T0 });

		await signalerRattachementsModifies(db, oeuvreId, 'correction', T0 + 1);
		await signalerRattachementsModifies(db, oeuvreId, 'ingestion', T0 + 2);

		expect((await enAttente(db)).map((d) => d.reason)).toEqual(['correction', 'ingestion']);
	});

	it('une demande traitée sort de la file, et une nouvelle peut être enfilée', async () => {
		const db = createTestDb();
		const { oeuvreId } = await ingererOeuvre(db, oeuvreDistante('metron', '4021'), { now: T0 });
		await signalerRattachementsModifies(db, oeuvreId, 'correction', T0 + 1);

		const [demande] = await enAttente(db);
		await marquerTraitees(db, [demande.id], T0 + 2);

		expect(await enAttente(db)).toEqual([]);
		expect(await estEnAttente(db, oeuvreId)).toBe(false);

		await signalerRattachementsModifies(db, oeuvreId, 'correction', T0 + 3);
		expect(await enAttente(db)).toHaveLength(1);
	});

	it('marquer une liste vide ne fait rien', async () => {
		const db = createTestDb();
		await marquerTraitees(db, []);
		expect(await enAttente(db)).toEqual([]);
	});
});
