import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../db/testing';
import { entities } from '../db/schema';
import {
	analyserCorrection,
	appliquerCorrections,
	corriger,
	lireCoucheSource,
	lireOeuvre,
	type OeuvreLocale
} from './corrections';
import { ingererOeuvre } from './ingest';
import { estEnAttente } from './rematerialisation';
import { T0, entite, membre, oeuvreDistante } from './testing';

/** L'identifiant local d'une entité, retrouvé par son nom — les tests ne le connaissent pas d'avance. */
async function entiteNommee(db: ReturnType<typeof createTestDb>, nom: string): Promise<string> {
	const ligne = await db.query.entities.findFirst({ where: eq(entities.name, nom) });
	if (!ligne) throw new Error(`entité « ${nom} » introuvable`);
	return ligne.id;
}

describe('analyse d une correction', () => {
	it('refuse un champ qui n existe pas', () => {
		expect(analyserCorrection({ champ: 'prixEnEuros', valeur: 12 })).toEqual({
			ok: false,
			motif: 'champ inconnu'
		});
	});

	it('refuse une valeur du mauvais type', () => {
		expect(analyserCorrection({ champ: 'titre', valeur: 42 })).toEqual({
			ok: false,
			motif: 'valeur invalide'
		});
	});

	it('refuse un titre vide : corriger n est pas effacer', () => {
		expect(analyserCorrection({ champ: 'titre', valeur: '   ' })).toEqual({
			ok: false,
			motif: 'valeur invalide'
		});
	});

	it('refuse un type d œuvre inconnu', () => {
		expect(analyserCorrection({ champ: 'type', valeur: 'fanzine' })).toEqual({
			ok: false,
			motif: 'valeur invalide'
		});
	});

	it('accepte l effacement explicite d un champ facultatif', () => {
		expect(analyserCorrection({ champ: 'dateDeParution', valeur: null })).toEqual({
			ok: true,
			valeur: { champ: 'dateDeParution', valeur: null }
		});
	});

	it('complète un delta partiel plutôt que de le refuser', () => {
		expect(analyserCorrection({ champ: 'personnages', ajoutes: ['e1'] })).toEqual({
			ok: true,
			valeur: { champ: 'personnages', ajoutes: ['e1'], retires: [] }
		});
	});

	it('refuse un delta qui n est pas une liste d identifiants', () => {
		expect(analyserCorrection({ champ: 'personnages', ajoutes: [7] })).toEqual({
			ok: false,
			motif: 'valeur invalide'
		});
	});

	it('refuse ce qui n est pas un objet', () => {
		expect(analyserCorrection('titre')).toEqual({ ok: false, motif: 'valeur invalide' });
	});
});

describe('application des corrections', () => {
	const base: OeuvreLocale = {
		id: 'w1',
		type: 'numero',
		titre: 'Titre de source',
		dateDeParution: '1981-02-01',
		serie: null,
		numeroDansLaSerie: 142,
		event: null,
		couvertureUrl: null,
		personnages: [{ entityId: 'e1', nom: 'Wolverine' }],
		createurs: [],
		contenu: [],
		etatIngestion: 'complete',
		identifiants: []
	};

	it('la plus récente correction sur un champ supplante la précédente', () => {
		const corrigee = appliquerCorrections(
			base,
			[
				{ champ: 'titre', valeur: 'Première tentative' },
				{ champ: 'titre', valeur: 'Deuxième tentative' }
			],
			new Map()
		);

		expect(corrigee.titre).toBe('Deuxième tentative');
	});

	it('ajoute un personnage sans toucher à ceux de la source', () => {
		const corrigee = appliquerCorrections(
			base,
			[{ champ: 'personnages', ajoutes: ['e2'], retires: [] }],
			new Map([['e2', 'Kitty Pryde']])
		);

		expect(corrigee.personnages.map((p) => p.nom)).toEqual(['Wolverine', 'Kitty Pryde']);
	});

	it('retire un personnage que la source crédite à tort', () => {
		const corrigee = appliquerCorrections(
			base,
			[{ champ: 'personnages', ajoutes: [], retires: ['e1'] }],
			new Map()
		);

		expect(corrigee.personnages).toEqual([]);
	});

	it('n ajoute pas deux fois un personnage déjà crédité', () => {
		const corrigee = appliquerCorrections(
			base,
			[{ champ: 'personnages', ajoutes: ['e1'], retires: [] }],
			new Map([['e1', 'Wolverine']])
		);

		expect(corrigee.personnages).toHaveLength(1);
	});

	it('ignore une entité disparue plutôt que de rendre la fiche illisible', () => {
		const corrigee = appliquerCorrections(
			base,
			[{ champ: 'personnages', ajoutes: ['fantome'], retires: [] }],
			new Map()
		);

		expect(corrigee.personnages.map((p) => p.nom)).toEqual(['Wolverine']);
	});

	it('ne modifie pas l œuvre de départ', () => {
		appliquerCorrections(base, [{ champ: 'titre', valeur: 'Autre' }], new Map());
		expect(base.titre).toBe('Titre de source');
	});
});

describe('corrections en base', () => {
	it('applique la correction à la lecture sans toucher à la donnée de source', async () => {
		const db = createTestDb();
		const auteur = await membre(db);
		const { oeuvreId } = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', { titre: 'Uncany X-Men #142' }),
			{ now: T0 }
		);

		const resultat = await corriger(db, {
			oeuvreId,
			membreId: auteur,
			correction: { champ: 'titre', valeur: 'Uncanny X-Men #142' },
			now: T0 + 1
		});

		expect(resultat).toMatchObject({ ok: true, rattachementsModifies: false });
		expect((await lireOeuvre(db, oeuvreId))?.titre).toBe('Uncanny X-Men #142');
		expect((await lireCoucheSource(db, oeuvreId))?.titre).toBe('Uncany X-Men #142');
	});

	it('la correction survit à une ré-ingestion de la même œuvre', async () => {
		const db = createTestDb();
		const auteur = await membre(db);
		const { oeuvreId } = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', { titre: 'Uncany X-Men #142' }),
			{ now: T0 }
		);
		await corriger(db, {
			oeuvreId,
			membreId: auteur,
			correction: { champ: 'titre', valeur: 'Uncanny X-Men #142' },
			now: T0 + 1
		});

		// La source réaffirme sa coquille : elle réécrit sa couche, pas la nôtre.
		await ingererOeuvre(db, oeuvreDistante('metron', '4021', { titre: 'Uncany X-Men #142' }), {
			now: T0 + 2
		});

		expect((await lireOeuvre(db, oeuvreId))?.titre).toBe('Uncanny X-Men #142');
		expect((await lireCoucheSource(db, oeuvreId))?.titre).toBe('Uncany X-Men #142');
	});

	it('un personnage ajouté par correction survit à une ré-ingestion, et ceux d amont apparaissent quand même', async () => {
		const db = createTestDb();
		const auteur = await membre(db);
		const { oeuvreId } = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', { personnages: [entite('metron', 'p-2', 'Wolverine')] }),
			{ now: T0 }
		);

		// Le membre crédite un personnage que la source ignore. L'entité existe
		// déjà en base parce qu'une autre œuvre l'a fait connaître.
		await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'autre', { personnages: [entite('metron', 'p-1', 'Kitty Pryde')] }),
			{ now: T0 + 1 }
		);
		await corriger(db, {
			oeuvreId,
			membreId: auteur,
			correction: {
				champ: 'personnages',
				ajoutes: [await entiteNommee(db, 'Kitty Pryde')],
				retires: []
			},
			now: T0 + 2
		});

		// Une ré-ingestion crédite un troisième personnage : le delta le laisse
		// apparaître, là où une liste de remplacement l'aurait masqué à jamais.
		await ingererOeuvre(
			db,
			oeuvreDistante('metron', '4021', {
				personnages: [entite('metron', 'p-2', 'Wolverine'), entite('metron', 'p-3', 'Tornade')]
			}),
			{ now: T0 + 3 }
		);

		expect((await lireOeuvre(db, oeuvreId))?.personnages.map((p) => p.nom)).toEqual([
			'Wolverine',
			'Tornade',
			'Kitty Pryde'
		]);
	});

	it('une correction de rattachement notifie la re-matérialisation du graphe', async () => {
		const db = createTestDb();
		const auteur = await membre(db);
		const { oeuvreId } = await ingererOeuvre(db, oeuvreDistante('metron', '4021'), { now: T0 });
		await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'autre', { personnages: [entite('metron', 'p-1', 'Kitty Pryde')] }),
			{ now: T0 + 1 }
		);

		const resultat = await corriger(db, {
			oeuvreId,
			membreId: auteur,
			correction: {
				champ: 'personnages',
				ajoutes: [await entiteNommee(db, 'Kitty Pryde')],
				retires: []
			},
			now: T0 + 2
		});

		expect(resultat).toMatchObject({ ok: true, rattachementsModifies: true });
		expect(await estEnAttente(db, oeuvreId)).toBe(true);
	});

	it('une correction de série notifie aussi, une correction de titre non', async () => {
		const db = createTestDb();
		const auteur = await membre(db);
		const { oeuvreId } = await ingererOeuvre(db, oeuvreDistante('metron', '4021'), { now: T0 });
		await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'autre', { serie: entite('metron', 's-12', 'Uncanny X-Men') }),
			{ now: T0 + 1 }
		);

		const titre = await corriger(db, {
			oeuvreId,
			membreId: auteur,
			correction: { champ: 'titre', valeur: 'Titre juste' },
			now: T0 + 2
		});
		expect(titre).toMatchObject({ rattachementsModifies: false });
		expect(await estEnAttente(db, oeuvreId)).toBe(false);

		const serie = await corriger(db, {
			oeuvreId,
			membreId: auteur,
			correction: { champ: 'serie', valeur: await entiteNommee(db, 'Uncanny X-Men') },
			now: T0 + 3
		});

		expect(serie).toMatchObject({ rattachementsModifies: true });
		expect(await estEnAttente(db, oeuvreId)).toBe(true);
		expect((await lireOeuvre(db, oeuvreId))?.serie?.nom).toBe('Uncanny X-Men');
		expect((await lireCoucheSource(db, oeuvreId))?.serie).toBeNull();
	});

	it('refuse une correction sur une œuvre inexistante', async () => {
		const db = createTestDb();
		const auteur = await membre(db);

		expect(
			await corriger(db, {
				oeuvreId: 'inexistante',
				membreId: auteur,
				correction: { champ: 'titre', valeur: 'Peu importe' }
			})
		).toEqual({ ok: false, motif: 'œuvre introuvable' });
	});

	it('refuse une correction qui désigne une entité inconnue', async () => {
		const db = createTestDb();
		const auteur = await membre(db);
		const { oeuvreId } = await ingererOeuvre(db, oeuvreDistante('metron', '4021'), { now: T0 });

		expect(
			await corriger(db, {
				oeuvreId,
				membreId: auteur,
				correction: { champ: 'personnages', ajoutes: ['fantome'], retires: [] }
			})
		).toEqual({ ok: false, motif: 'entité inconnue' });
	});

	it('refuse un delta vide, qui ne corrigerait rien', async () => {
		const db = createTestDb();
		const auteur = await membre(db);
		const { oeuvreId } = await ingererOeuvre(db, oeuvreDistante('metron', '4021'), { now: T0 });

		expect(
			await corriger(db, {
				oeuvreId,
				membreId: auteur,
				correction: { champ: 'personnages', ajoutes: [], retires: [] }
			})
		).toEqual({ ok: false, motif: 'correction vide' });
	});

	it('deux corrections successives sur le même champ : la plus récente est servie', async () => {
		const db = createTestDb();
		const auteur = await membre(db);
		const { oeuvreId } = await ingererOeuvre(db, oeuvreDistante('metron', '4021'), { now: T0 });

		await corriger(db, {
			oeuvreId,
			membreId: auteur,
			correction: { champ: 'titre', valeur: 'Première' },
			now: T0 + 1
		});
		await corriger(db, {
			oeuvreId,
			membreId: auteur,
			correction: { champ: 'titre', valeur: 'Seconde' },
			now: T0 + 2
		});

		expect((await lireOeuvre(db, oeuvreId))?.titre).toBe('Seconde');
	});

	it('une œuvre inexistante ne se lit pas', async () => {
		const db = createTestDb();
		expect(await lireOeuvre(db, 'inexistante')).toBeNull();
	});
});
