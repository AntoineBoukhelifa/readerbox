import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import { entities, works } from '../db/schema';
import { ingererOeuvre } from './ingest';
import { lireOeuvre } from './corrections';
import { corriger } from './corrections';
import { chercherDansLeCatalogue, parcourirLeCatalogue, repartir } from './recherche';
import { ingererDepuisLAmont, oeuvreLocaleDe } from './amont';
import { creerCacheDeRecherche } from './cache';
import { consignerDepuisLeCatalogue } from '../journal/depuisLeCatalogue';
import { T0, adaptateurFactice, entite, membre, oeuvreDistante } from './testing';

/**
 * KTD1, éprouvé là où il se joue : **le local n'est jamais une condition
 * d'arrêt.**
 *
 * Le défaut que ces tests existent pour empêcher n'est pas visible sur une base
 * vide. Il apparaît exactement quand le catalogue commence à répondre : la
 * recherche se referme sur ce que le groupe connaît, et rétrécit à chaque
 * consignation. Chaque scène ci-dessous met donc une œuvre en base *avant* de
 * chercher.
 */

let db: Db;

beforeEach(() => {
	db = createTestDb();
});

/** Le numéro 1, tel qu'une source amont le décrit dans une liste de recherche. */
const numeroUn = oeuvreDistante('metron', '44467', {
	titre: 'Immortal X-Men (2022) #1',
	dateDeParution: '2022-05-01',
	numeroDansLaSerie: 1,
	serie: entite('metron', '3231', 'Immortal X-Men'),
	couvertureUrl: 'https://static.metron.cloud/immortal-1.jpg',
	completude: { personnages: 'indisponibles', createurs: 'indisponibles', contenu: 'sans objet' }
});

const numeroDeux = oeuvreDistante('metron', '44468', {
	titre: 'Immortal X-Men (2022) #2',
	dateDeParution: '2022-06-01',
	numeroDansLaSerie: 2,
	serie: entite('metron', '3231', 'Immortal X-Men'),
	completude: { personnages: 'indisponibles', createurs: 'indisponibles', contenu: 'sans objet' }
});

/** La même œuvre, en fiche complète : c'est ce que la consignation ingère. */
const ficheUn = oeuvreDistante('metron', '44467', {
	titre: 'Immortal X-Men #1',
	dateDeParution: '2022-05-01',
	numeroDansLaSerie: 1,
	serie: entite('metron', '3231', 'Immortal X-Men'),
	event: entite('metron', '1423', 'Destiny of X'),
	personnages: [
		entite('metron', '1391', 'Abigail Brand'),
		entite('metron', '1392', 'Mister Sinister')
	],
	createurs: [{ ...entite('metron', '5', 'Kieron Gillen'), role: 'Writer' }]
});

describe('recherche — le local n’est jamais une condition d’arrêt', () => {
	it('interroge la source même quand le catalogue répond déjà', async () => {
		// Le piège : un seul numéro consigné, et la source en connaît deux.
		await ingererOeuvre(db, oeuvreDistante('metron', '44467', { titre: 'Immortal X-Men #1' }), {
			now: T0
		});

		const source = adaptateurFactice({ resultats: [numeroUn, numeroDeux] });
		const trouvees = await chercherDansLeCatalogue(db, {
			requete: 'Immortal X-Men',
			adaptateurs: [source]
		});

		expect(source.appels).toEqual([{ quoi: 'rechercher', argument: 'Immortal X-Men' }]);
		expect(trouvees.resultats.map((r) => r.titre)).toEqual([
			'Immortal X-Men #1',
			'Immortal X-Men (2022) #2'
		]);
	});

	it('ne rend qu’une ligne pour une œuvre à la fois locale et amont', async () => {
		await ingererOeuvre(db, oeuvreDistante('metron', '44467', { titre: 'Immortal X-Men #1' }), {
			now: T0
		});

		const trouvees = await chercherDansLeCatalogue(db, {
			requete: 'Immortal X-Men',
			adaptateurs: [adaptateurFactice({ resultats: [numeroUn] })]
		});

		expect(trouvees.resultats).toHaveLength(1);
		expect(trouvees.resultats[0].connueDuGroupe).toBe(true);
		expect(trouvees.resultats[0].oeuvreId).not.toBeNull();
		expect(trouvees.resultats[0].reference).toEqual({ source: 'metron', idExterne: '44467' });
	});

	it('rend aussi les œuvres locales que l’amont n’a pas trouvées', async () => {
		await ingererOeuvre(db, oeuvreDistante('metron', 'local', { titre: 'Immortal X-Men annexe' }), {
			now: T0
		});

		const trouvees = await chercherDansLeCatalogue(db, {
			requete: 'Immortal X-Men',
			adaptateurs: [adaptateurFactice({ resultats: [numeroUn] })]
		});

		expect(trouvees.resultats.map((r) => r.titre)).toEqual([
			'Immortal X-Men (2022) #1',
			'Immortal X-Men annexe'
		]);
	});

	it('affiche le titre corrigé par un membre plutôt que celui de la source (R39, R47)', async () => {
		const { oeuvreId } = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '44467', { titre: 'Immortal X-Men #1' }),
			{ now: T0 }
		);
		const membreId = await membre(db);
		await corriger(db, {
			oeuvreId,
			membreId,
			correction: { champ: 'titre', valeur: 'Immortal X-Men, premier numéro' },
			now: T0
		});

		const trouvees = await chercherDansLeCatalogue(db, {
			requete: 'Immortal X-Men',
			adaptateurs: [adaptateurFactice({ resultats: [numeroUn] })]
		});

		expect(trouvees.resultats[0].titre).toBe('Immortal X-Men, premier numéro');
	});

	it('signale ce que le groupe a consigné, sans en faire une condition', async () => {
		const { oeuvreId } = await ingererOeuvre(
			db,
			oeuvreDistante('metron', '44467', { titre: 'Immortal X-Men #1' }),
			{ now: T0 }
		);
		const membreId = await membre(db);
		await consignerDepuisLeCatalogue(db, {
			membreId,
			oeuvreId,
			etagere: 'termine',
			adaptateurs: [],
			now: T0
		});

		const trouvees = await chercherDansLeCatalogue(db, {
			requete: 'Immortal X-Men',
			adaptateurs: [adaptateurFactice({ resultats: [numeroUn, numeroDeux] })]
		});

		expect(trouvees.resultats.map((r) => r.consignee)).toEqual([true, false]);
	});

	it('n’écrit rien : une recherche ne persiste aucune œuvre', async () => {
		const avant = await db.select().from(works);

		await chercherDansLeCatalogue(db, {
			requete: 'Immortal X-Men',
			adaptateurs: [adaptateurFactice({ resultats: [numeroUn, numeroDeux] })]
		});

		expect(await db.select().from(works)).toEqual(avant);
		expect(await db.select().from(entities)).toEqual([]);
	});

	it('une requête vide n’interroge personne', async () => {
		const source = adaptateurFactice({ resultats: [numeroUn] });

		expect(await chercherDansLeCatalogue(db, { requete: '  ', adaptateurs: [source] })).toEqual({
			resultats: [],
			degradations: [],
			depuisLeCache: false
		});
		expect(source.appels).toEqual([]);
	});
});

describe('répartition du plafond de résultats', () => {
	it('donne à chaque liste sa part, et rend le reliquat aux plus longues', () => {
		// Chaque liste garde son bloc contigu : l'ordre de pertinence d'une source
		// est une information, et l'entrelacer la détruirait.
		expect(repartir([['a1', 'a2', 'a3', 'a4'], ['b1']], 4)).toEqual(['a1', 'a2', 'a3', 'b1']);
	});

	it('une liste vide ne consomme rien', () => {
		expect(repartir([['a1', 'a2', 'a3'], []], 3)).toEqual(['a1', 'a2', 'a3']);
	});

	it('une source bavarde n’efface pas les autres — mesuré contre les vraies API', async () => {
		// Metron rend cent numéros pour « Iron Man » ; les concaténer puis couper au
		// plafond ferait disparaître tous les films, sans que rien ne le signale.
		const beaucoup = Array.from({ length: 100 }, (_, index) =>
			oeuvreDistante('metron', `n${index}`, { titre: `Iron Man #${index}` })
		);
		const unFilm = oeuvreDistante('tmdb', 'film:1726', { titre: 'Iron Man', type: 'film' });

		const trouvees = await chercherDansLeCatalogue(db, {
			requete: 'Iron Man',
			adaptateurs: [
				adaptateurFactice({ nom: 'metron', resultats: beaucoup }),
				adaptateurFactice({ nom: 'tmdb', resultats: [unFilm] })
			],
			limite: 25
		});

		expect(trouvees.resultats).toHaveLength(25);
		expect(trouvees.resultats.some((r) => r.type === 'film')).toBe(true);
	});
});

describe('cache des réponses de recherche', () => {
	it('une recherche répétée dans la fenêtre ne redéclenche pas d’appel amont', async () => {
		const source = adaptateurFactice({ resultats: [numeroUn] });
		const cache = creerCacheDeRecherche({ dureeMs: 60_000 });

		const premiere = await chercherDansLeCatalogue(db, {
			requete: 'Immortal X-Men',
			adaptateurs: [source],
			cache
		});
		const seconde = await chercherDansLeCatalogue(db, {
			requete: 'Immortal X-Men',
			adaptateurs: [source],
			cache
		});

		expect(source.appels).toHaveLength(1);
		expect(premiere.depuisLeCache).toBe(false);
		expect(seconde.depuisLeCache).toBe(true);
		expect(seconde.resultats).toEqual(premiere.resultats);
	});

	it('la casse et les espaces ne font pas deux recherches — c’est le facteur qui compte à vingt', async () => {
		const source = adaptateurFactice({ resultats: [numeroUn] });
		const cache = creerCacheDeRecherche();

		await chercherDansLeCatalogue(db, { requete: 'Immortal X-Men', adaptateurs: [source], cache });
		await chercherDansLeCatalogue(db, {
			requete: '  immortal  x-men',
			adaptateurs: [source],
			cache
		});

		expect(source.appels).toHaveLength(1);
	});

	it('le cache ne fige pas le local : une consignation entre deux recherches se voit', async () => {
		const source = adaptateurFactice({ resultats: [numeroUn] });
		const cache = creerCacheDeRecherche();

		await chercherDansLeCatalogue(db, { requete: 'Immortal X-Men', adaptateurs: [source], cache });

		const { oeuvreId } = await ingererOeuvre(db, ficheUn, { now: T0 });
		const membreId = await membre(db);
		await consignerDepuisLeCatalogue(db, {
			membreId,
			oeuvreId,
			etagere: 'termine',
			adaptateurs: [],
			now: T0
		});

		const apres = await chercherDansLeCatalogue(db, {
			requete: 'Immortal X-Men',
			adaptateurs: [source],
			cache
		});

		expect(source.appels).toHaveLength(1);
		expect(apres.resultats[0].consignee).toBe(true);
	});

	it('un échec n’est pas mémorisé : une panne passagère ne doit pas durer', async () => {
		const cache = creerCacheDeRecherche();
		const enPanne = adaptateurFactice({ echec: 'indisponible' });

		await chercherDansLeCatalogue(db, { requete: 'x', adaptateurs: [enPanne], cache });
		await chercherDansLeCatalogue(db, { requete: 'x', adaptateurs: [enPanne], cache });

		expect(enPanne.appels).toHaveLength(2);
	});
});

describe('dégradation', () => {
	it('une source indisponible n’empêche ni la page ni les autres sources', async () => {
		await ingererOeuvre(db, oeuvreDistante('metron', 'local', { titre: 'Immortal X-Men #0' }), {
			now: T0
		});

		const trouvees = await chercherDansLeCatalogue(db, {
			requete: 'Immortal X-Men',
			adaptateurs: [
				adaptateurFactice({ nom: 'metron', echec: 'indisponible' }),
				adaptateurFactice({ nom: 'tmdb', resultats: [] })
			]
		});

		expect(trouvees.degradations).toEqual([{ source: 'metron', motif: 'indisponible' }]);
		expect(trouvees.resultats.map((r) => r.titre)).toEqual(['Immortal X-Men #0']);
	});

	it('un quota atteint est rapporté comme quota, pas comme une panne', async () => {
		const trouvees = await chercherDansLeCatalogue(db, {
			requete: 'x',
			adaptateurs: [adaptateurFactice({ echec: 'quota' })]
		});

		expect(trouvees.degradations).toEqual([{ source: 'metron', motif: 'quota' }]);
	});
});

describe('parcours par facette (R46)', () => {
	it('rend les apparitions amont, y compris celles que personne n’a consignées', async () => {
		const source = adaptateurFactice({ parcours: [numeroUn, numeroDeux] });

		const trouvees = await parcourirLeCatalogue(db, {
			axe: 'personnage',
			reference: { source: 'metron', idExterne: '1391' },
			adaptateurs: [source]
		});

		expect(source.appels).toEqual([{ quoi: 'parcourir', argument: 'personnage:1391' }]);
		expect(trouvees.resultats.map((r) => r.connueDuGroupe)).toEqual([false, false]);
		expect(trouvees.resultats).toHaveLength(2);
	});

	it('fusionne avec les œuvres locales rattachées au même personnage', async () => {
		// Une œuvre locale que l'amont ne rend pas : elle doit tout de même sortir.
		await ingererOeuvre(
			db,
			oeuvreDistante('metron', 'ancienne', {
				titre: 'Un vieux numéro',
				personnages: [entite('metron', '1391', 'Abigail Brand')]
			}),
			{ now: T0 }
		);

		const trouvees = await parcourirLeCatalogue(db, {
			axe: 'personnage',
			reference: { source: 'metron', idExterne: '1391' },
			adaptateurs: [adaptateurFactice({ parcours: [numeroUn] })]
		});

		expect(trouvees.resultats.map((r) => r.titre)).toEqual([
			'Immortal X-Men (2022) #1',
			'Un vieux numéro'
		]);
	});

	it('n’interroge pas une source qui ne déclare pas l’axe', async () => {
		const sansPersonnages = adaptateurFactice({
			nom: 'tmdb',
			capacites: { parcoursParPersonnage: false },
			parcours: [numeroUn]
		});

		const trouvees = await parcourirLeCatalogue(db, {
			axe: 'personnage',
			reference: { source: 'tmdb', idExterne: 'personne:3223' },
			adaptateurs: [sansPersonnages]
		});

		expect(sansPersonnages.appels).toEqual([]);
		expect(trouvees.degradations).toEqual([]);
	});

	it('n’interroge pas une source qui ne porte pas la référence', async () => {
		const autre = adaptateurFactice({ nom: 'tmdb', parcours: [numeroUn] });

		await parcourirLeCatalogue(db, {
			axe: 'serie',
			reference: { source: 'metron', idExterne: '3231' },
			adaptateurs: [autre]
		});

		expect(autre.appels).toEqual([]);
	});
});

describe('ingestion depuis l’amont — le seul déclencheur d’écriture (KTD1)', () => {
	it('consigner une œuvre issue d’une recherche la persiste avec ses rattachements, en état complet', async () => {
		const membreId = await membre(db);
		const source = adaptateurFactice({ resultats: [numeroUn], fiches: { '44467': ficheUn } });

		const consignation = await consignerDepuisLeCatalogue(db, {
			membreId,
			reference: { source: 'metron', idExterne: '44467' },
			etagere: 'termine',
			adaptateurs: [source],
			now: T0
		});
		if (!consignation.ok) throw new Error(consignation.motif);

		expect(consignation.partielle).toBe(false);

		const oeuvre = await lireOeuvre(db, consignation.oeuvreId);
		expect(oeuvre).toMatchObject({
			titre: 'Immortal X-Men #1',
			serie: { nom: 'Immortal X-Men' },
			event: { nom: 'Destiny of X' },
			etatIngestion: 'complete'
		});
		expect(oeuvre?.personnages.map((p) => p.nom)).toEqual(['Abigail Brand', 'Mister Sinister']);
	});

	it('relit la fiche détaillée plutôt que d’ingérer le résultat de recherche', async () => {
		const source = adaptateurFactice({ resultats: [numeroUn], fiches: { '44467': ficheUn } });

		await ingererDepuisLAmont(db, {
			reference: { source: 'metron', idExterne: '44467' },
			adaptateurs: [source],
			now: T0
		});

		// Sans cet appel, l'œuvre entrerait sans personnages : un trou permanent
		// dans le graphe du membre, et rien pour le signaler.
		expect(source.appels).toEqual([{ quoi: 'lireOeuvre', argument: '44467' }]);
	});

	it('une source qui échoue sur les personnages marque l’œuvre partielle, et la laisse rejouable', async () => {
		const partielle = {
			...ficheUn,
			personnages: [],
			completude: { ...ficheUn.completude, personnages: 'indisponibles' as const }
		};
		const membreId = await membre(db);

		const consignation = await consignerDepuisLeCatalogue(db, {
			membreId,
			reference: { source: 'metron', idExterne: '44467' },
			etagere: 'termine',
			adaptateurs: [adaptateurFactice({ fiches: { '44467': partielle } })],
			now: T0
		});
		if (!consignation.ok) throw new Error(consignation.motif);

		// Le geste aboutit : le membre a lu ce numéro, et il le dit.
		expect(consignation.partielle).toBe(true);

		const oeuvre = await lireOeuvre(db, consignation.oeuvreId);
		expect(oeuvre?.etatIngestion).toBe('partielle');
	});

	it('une œuvre réellement sans crédits est complète, pas partielle', async () => {
		const sansCredits = oeuvreDistante('metron', 'vieux', {
			titre: 'Un numéro des années 60',
			completude: { personnages: 'absents', createurs: 'absents', contenu: 'sans objet' }
		});

		const ingeree = await ingererDepuisLAmont(db, {
			reference: { source: 'metron', idExterne: 'vieux' },
			adaptateurs: [adaptateurFactice({ fiches: { vieux: sansCredits } })],
			now: T0
		});
		if (!ingeree.ok) throw new Error(ingeree.motif);

		// C'est la distinction que tout le modèle existe pour porter : une lacune
		// acceptée du projet, et non un incident à rejouer.
		expect(ingeree.etat).toBe('complete');
	});

	it('un quota remonte comme quota, sans rien écrire', async () => {
		const refus = await ingererDepuisLAmont(db, {
			reference: { source: 'metron', idExterne: '44467' },
			adaptateurs: [adaptateurFactice({ echec: 'quota' })],
			now: T0
		});

		expect(refus).toEqual({ ok: false, motif: 'quota' });
		expect(await db.select().from(works)).toEqual([]);
	});

	it('une source non configurée le dit plutôt que de faire semblant', async () => {
		expect(
			await ingererDepuisLAmont(db, {
				reference: { source: 'tmdb', idExterne: 'film:1' },
				adaptateurs: [adaptateurFactice({ nom: 'metron' })],
				now: T0
			})
		).toEqual({ ok: false, motif: 'source inconnue' });
	});

	it('une œuvre déjà au catalogue n’est pas redemandée à la source', async () => {
		await ingererOeuvre(db, ficheUn, { now: T0 });
		const source = adaptateurFactice({ fiches: { '44467': ficheUn } });

		const relue = await oeuvreLocaleDe(db, {
			reference: { source: 'metron', idExterne: '44467' },
			adaptateurs: [source],
			now: T0
		});

		expect(relue).toMatchObject({ ok: true, creee: false });
		expect(source.appels).toEqual([]);
	});

	it('consigner deux fois la même référence ne crée pas deux œuvres', async () => {
		const membreId = await membre(db);
		const source = adaptateurFactice({ fiches: { '44467': ficheUn } });
		const consigner = () =>
			consignerDepuisLeCatalogue(db, {
				membreId,
				reference: { source: 'metron', idExterne: '44467' },
				etagere: 'en_cours',
				adaptateurs: [source],
				now: T0
			});

		await consigner();
		await consigner();

		expect(await db.select().from(works)).toHaveLength(1);
	});
});

describe('un titre porteur de balisage', () => {
	it('traverse la recherche et l’ingestion comme du texte, sans être ni exécuté ni nettoyé', async () => {
		const piege = '<img src=x onerror="alert(1)">';
		const distante = oeuvreDistante('metron', 'piege', { titre: piege });

		const trouvees = await chercherDansLeCatalogue(db, {
			requete: 'img',
			adaptateurs: [adaptateurFactice({ resultats: [distante] })]
		});
		expect(trouvees.resultats[0].titre).toBe(piege);

		const ingeree = await ingererDepuisLAmont(db, {
			reference: { source: 'metron', idExterne: 'piege' },
			adaptateurs: [adaptateurFactice({ fiches: { piege: distante } })],
			now: T0
		});
		if (!ingeree.ok) throw new Error(ingeree.motif);

		const [ligne] = await db.select().from(works).where(eq(works.id, ingeree.oeuvreId));
		expect(ligne.title).toBe(piege);
	});
});
