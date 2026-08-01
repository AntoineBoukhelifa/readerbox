import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import {
	entities,
	graphEdgeSupports,
	graphEdges,
	graphRematerializations,
	journalEntries,
	reachCrossings,
	workCharacters,
	workSources,
	works
} from '../db/schema';
import { ingererOeuvre } from '../catalog/ingest';
import { corriger, type OeuvreLocale } from '../catalog/corrections';
import { estEnAttente } from '../catalog/rematerialisation';
import { T0, entite, membre, oeuvreDistante, reference } from '../catalog/testing';
import type { NomDeSource, TypeOeuvre } from '../catalog/sources/types';
import { abandonner, consigner, reprendre, retirer } from '../journal/entries';
import { deroulerCascades } from '../journal/cascade';
import { estAtteinte, type Etagere } from '../journal/atteinte';
import {
	FILTRE_SQL_NON_ATTEINTE,
	grapheDuMembre,
	liensEtablis,
	rejouerAppuis,
	type AreteDuGraphe
} from './materialize';
import {
	deroulerGraphe,
	grapheAttendu,
	materialiserGraphe,
	rattraperGraphe,
	recalculerGraphe
} from './rematerialize';

/**
 * Le graphe matérialisé par membre (U9).
 *
 * Deux choses se vérifient ici et elles ne se confondent pas. La première est la
 * **règle de dérivation** de KTD4 : une œuvre atteinte établit un lien vers
 * chacun de ses personnages crédités, un vers sa série, un vers son event — et
 * jamais de co-apparition entre personnages, dont le coût serait quadratique par
 * membre. La seconde est la **règle d'appui** : une arête conserve la liste des
 * œuvres qui l'établissent et ne disparaît qu'en perdant la dernière. C'est le
 * mécanisme des origines de consignation de U5 sous un autre nom, avec le même
 * piège — supprimer trop tôt.
 *
 * Le fil rouge est R52, la contrainte la plus subtile du produit : une arête ne
 * doit pas apparaître si le lien qu'elle porte n'est établi que par une œuvre non
 * atteinte, **même lorsque ses deux nœuds figurent déjà dans le graphe par
 * ailleurs**. Un graphe qui révélerait de tels liens serait l'outil de spoiler le
 * plus efficace jamais construit sur cet univers.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ChampsOeuvre {
	type?: TypeOeuvre;
	titre?: string;
	serie?: string;
	event?: string;
	personnages?: string[];
	contenu?: string[];
	source?: NomDeSource;
}

/** Une œuvre du catalogue, ingérée comme un adaptateur le ferait. */
async function oeuvre(db: Db, idExterne: string, champs: ChampsOeuvre = {}): Promise<string> {
	const source = champs.source ?? 'metron';
	const { oeuvreId } = await ingererOeuvre(
		db,
		oeuvreDistante(source, idExterne, {
			type: champs.type ?? 'numero',
			titre: champs.titre ?? `Œuvre ${idExterne}`,
			...(champs.serie ? { serie: entite(source, `serie-${champs.serie}`, champs.serie) } : {}),
			...(champs.event ? { event: entite(source, `event-${champs.event}`, champs.event) } : {}),
			...(champs.contenu ? { contenu: champs.contenu.map((id) => reference(source, id)) } : {}),
			personnages: (champs.personnages ?? []).map((nom) => entite(source, `perso-${nom}`, nom))
		}),
		{ now: T0 }
	);
	return oeuvreId;
}

/** Une entité que rien n'a encore créditée — ce qu'une correction désignera. */
async function entiteNue(db: Db, nom: string): Promise<string> {
	const [ligne] = await db
		.insert(entities)
		.values({ type: 'personnage', name: nom, createdAt: T0 })
		.returning({ id: entities.id });
	return ligne.id;
}

async function idDeLEntite(db: Db, nom: string): Promise<string> {
	const [ligne] = await db.select({ id: entities.id }).from(entities).where(eq(entities.name, nom));
	return ligne.id;
}

/** Consigner sur « terminé » : le geste qui atteint (R1, R3). */
async function atteindre(db: Db, membreId: string, oeuvreId: string, now = T0): Promise<void> {
	const resultat = await consigner(db, { membreId, oeuvreId, etagere: 'termine', now });
	expect(resultat.ok).toBe(true);
}

/** Le graphe, une fois les deux files de U9 vidées. */
async function graphe(db: Db, membreId: string): Promise<AreteDuGraphe[]> {
	await deroulerCascades(db, { now: T0 });
	await deroulerGraphe(db, { now: T0 });
	return grapheDuMembre(db, membreId);
}

/** Les noms des nœuds du graphe, dans l'ordre canonique. */
function noms(aretes: AreteDuGraphe[]): string[] {
	return aretes.map((arete) => arete.nom);
}

function arete(aretes: AreteDuGraphe[], nom: string): AreteDuGraphe | undefined {
	return aretes.find((a) => a.nom === nom);
}

/** Une œuvre locale plausible, pour éprouver la règle pure sans base. */
function oeuvreLocale(champs: Partial<OeuvreLocale> = {}): OeuvreLocale {
	return {
		id: 'o1',
		type: 'numero',
		titre: 'Sans titre',
		dateDeParution: null,
		serie: null,
		numeroDansLaSerie: null,
		event: null,
		couvertureUrl: null,
		personnages: [],
		createurs: [],
		contenu: [],
		etatIngestion: 'complete',
		identifiants: [],
		...champs
	};
}

// ---------------------------------------------------------------------------
// KTD4 — la règle de dérivation, sans base
// ---------------------------------------------------------------------------

describe('KTD4 — la règle de dérivation', () => {
	it('un numéro à vingt crédits produit vingt liens de personnage, pas cent quatre-vingt-dix', () => {
		const personnages = Array.from({ length: 20 }, (_, i) => ({
			entityId: `p${i}`,
			nom: `Personnage ${i}`
		}));

		const liens = liensEtablis(oeuvreLocale({ personnages }));

		expect(liens.filter((l) => l.relation === 'personnage')).toHaveLength(20);
		// La co-apparition deux à deux en aurait produit 190 de plus, par membre.
		expect(liens).toHaveLength(20);
	});

	it('les trois familles, et rien d autre : ni créateur, ni contenu de recueil', () => {
		const liens = liensEtablis(
			oeuvreLocale({
				serie: { entityId: 's1', nom: 'Uncanny X-Men' },
				event: { entityId: 'e1', nom: 'Inferno' },
				personnages: [{ entityId: 'p1', nom: 'Diablo' }],
				createurs: [{ entityId: 'c1', nom: 'Chris Claremont', role: 'scénario' }],
				contenu: [{ oeuvreId: 'o2', reference: null, rang: 0 }]
			})
		);

		expect(liens).toEqual([
			{ relation: 'serie', entiteId: 's1' },
			{ relation: 'event', entiteId: 'e1' },
			{ relation: 'personnage', entiteId: 'p1' }
		]);
	});

	it('une œuvre sans personnage, sans série et sans event n établit rien', () => {
		expect(liensEtablis(oeuvreLocale())).toEqual([]);
	});

	it('une œuvre absente du catalogue n établit rien non plus', () => {
		expect(liensEtablis(null)).toEqual([]);
	});

	it('le même personnage crédité deux fois ne fait qu un seul lien', () => {
		const liens = liensEtablis(
			oeuvreLocale({
				personnages: [
					{ entityId: 'p1', nom: 'Tornade' },
					{ entityId: 'p1', nom: 'Tornade' }
				]
			})
		);
		expect(liens).toEqual([{ relation: 'personnage', entiteId: 'p1' }]);
	});
});

// ---------------------------------------------------------------------------
// R51 — rien n'apparaît avant qu'une œuvre atteinte ne l'établisse
// ---------------------------------------------------------------------------

describe('R51 — le graphe naît des œuvres atteintes', () => {
	it('couvre AE9. un personnage n apparaît pas tant qu aucune œuvre atteinte ne le fait apparaître', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 'Daredevil', personnages: ['Elektra'] });

		// Consignée, pas atteinte : c'est le cas le plus fréquent du produit.
		await consigner(db, { membreId: antoine, oeuvreId: numero, etagere: 'a_decouvrir', now: T0 });
		expect(await graphe(db, antoine)).toEqual([]);

		// Toujours pas : « en cours » n'est pas « atteint ».
		await consigner(db, { membreId: antoine, oeuvreId: numero, etagere: 'en_cours', now: T0 });
		expect(await graphe(db, antoine)).toEqual([]);

		await atteindre(db, antoine, numero);
		expect(noms(await graphe(db, antoine))).toEqual(['Elektra', 'Daredevil']);
	});

	it('un membre sans aucune œuvre atteinte a un graphe vide, pas une erreur', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		expect(await graphe(db, antoine)).toEqual([]);
	});

	it('une œuvre atteinte sans personnage, sans série ni event ne pose aucun appui', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const roman = await oeuvre(db, '1', { type: 'roman', titre: 'Wolverine: Weapon X' });

		await atteindre(db, antoine, roman);

		expect(await graphe(db, antoine)).toEqual([]);
		// L'absence d'arête n'est pas l'absence d'atteinte : la consignation existe.
		expect(await db.select().from(journalEntries)).toHaveLength(1);
	});

	it('l abandon fait apparaître le graphe autant que le fait de terminer (R2, R3)', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 'Hulk', personnages: ['Hulk'] });

		await consigner(db, { membreId: antoine, oeuvreId: numero, etagere: 'en_cours', now: T0 });
		await abandonner(db, { membreId: antoine, oeuvreId: numero, now: T0 });

		expect(noms(await graphe(db, antoine))).toEqual(['Hulk', 'Hulk']);
	});

	it('les nœuds sont agrégés à l entité, jamais à l œuvre (R50)', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const un = await oeuvre(db, '1', { serie: 'Amazing Spider-Man', personnages: ['Spider-Man'] });
		const deux = await oeuvre(db, '2', {
			serie: 'Amazing Spider-Man',
			personnages: ['Spider-Man']
		});

		await atteindre(db, antoine, un);
		await atteindre(db, antoine, deux);

		const resultat = await graphe(db, antoine);
		// Deux numéros, deux nœuds — pas quatre.
		expect(noms(resultat)).toEqual(['Spider-Man', 'Amazing Spider-Man']);
		expect(arete(resultat, 'Spider-Man')?.appuis).toEqual([un, deux].sort());
	});
});

// ---------------------------------------------------------------------------
// R52 — une œuvre non atteinte ne relie rien
// ---------------------------------------------------------------------------

describe('R52 — le masquage rendu en image', () => {
	it('couvre AE10. deux nœuds présents par ailleurs ne sont pas reliés par une œuvre non atteinte', async () => {
		const db = createTestDb();
		const antoine = await membre(db);

		// Fatalis et Namor entrent dans le graphe par deux œuvres sans rapport.
		const unNumeroDeFatalis = await oeuvre(db, '1', {
			serie: 'Fantastic Four',
			personnages: ['Fatalis']
		});
		const unNumeroDeNamor = await oeuvre(db, '2', {
			serie: 'Sub-Mariner',
			personnages: ['Namor']
		});
		// Et une troisième œuvre, non atteinte, est la seule à établir leur lien.
		const leCrossover = await oeuvre(db, '3', {
			serie: 'Fantastic Four',
			personnages: ['Fatalis', 'Namor']
		});

		await atteindre(db, antoine, unNumeroDeFatalis);
		await atteindre(db, antoine, unNumeroDeNamor);
		await consigner(db, {
			membreId: antoine,
			oeuvreId: leCrossover,
			etagere: 'a_decouvrir',
			now: T0
		});

		const resultat = await graphe(db, antoine);

		// Les deux nœuds sont bien là — c'est toute la difficulté de R52.
		expect(arete(resultat, 'Fatalis')).toBeDefined();
		expect(arete(resultat, 'Namor')).toBeDefined();

		// Mais aucune œuvre ne les porte ensemble : c'est le partage d'un appui qui
		// fait le lien (KTD4), et le crossover n'apporte d'appui à personne.
		const communs = (arete(resultat, 'Fatalis')?.appuis ?? []).filter((id) =>
			(arete(resultat, 'Namor')?.appuis ?? []).includes(id)
		);
		expect(communs).toEqual([]);
		expect(resultat.flatMap((a) => a.appuis)).not.toContain(leCrossover);
	});

	it('une arête sans appui n existe pas : la lecture joint les appuis', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 'Thor', personnages: ['Loki'] });
		await atteindre(db, antoine, numero);
		await deroulerGraphe(db, { now: T0 });

		// On simule le pire défaut possible : une arête orpheline restée en base.
		await db.delete(graphEdgeSupports);

		expect(await grapheDuMembre(db, antoine)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// R33, R35 — le retrait et la reprise rétractent le graphe
// ---------------------------------------------------------------------------

describe('R33, R35 — la rétraction', () => {
	it('couvre AE14. retirer une consignation qui soutenait un nœud unique le fait disparaître', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', {
			serie: 'Moon Knight',
			event: 'Infinity',
			personnages: ['Moon Knight']
		});

		await atteindre(db, antoine, numero);
		expect(noms(await graphe(db, antoine))).toEqual(['Infinity', 'Moon Knight', 'Moon Knight']);

		await retirer(db, { membreId: antoine, oeuvreId: numero, now: T0 });

		expect(await graphe(db, antoine)).toEqual([]);
		// Rien ne survit sans appui, jusque dans les tables.
		expect(await db.select().from(graphEdges)).toEqual([]);
		expect(await db.select().from(graphEdgeSupports)).toEqual([]);
	});

	it('une arête soutenue par deux œuvres atteintes survit au retrait de l une', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const un = await oeuvre(db, '1', { serie: 'New Mutants', personnages: ['Magik'] });
		const deux = await oeuvre(db, '2', { serie: 'Uncanny X-Men', personnages: ['Magik'] });

		await atteindre(db, antoine, un);
		await atteindre(db, antoine, deux);
		expect(arete(await graphe(db, antoine), 'Magik')?.appuis).toEqual([un, deux].sort());

		await retirer(db, { membreId: antoine, oeuvreId: un, now: T0 });

		const resultat = await graphe(db, antoine);
		// Magik reste : le second numéro l'établit encore. La série du premier, elle,
		// n'avait qu'un appui et s'en va.
		expect(arete(resultat, 'Magik')?.appuis).toEqual([deux]);
		expect(arete(resultat, 'New Mutants')).toBeUndefined();
		expect(arete(resultat, 'Uncanny X-Men')?.appuis).toEqual([deux]);
	});

	it('couvre R35. reprendre une œuvre abandonnée retire ses appuis du graphe', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 'Punisher', personnages: ['Le Punisher'] });

		await consigner(db, { membreId: antoine, oeuvreId: numero, etagere: 'en_cours', now: T0 });
		await abandonner(db, { membreId: antoine, oeuvreId: numero, now: T0 });
		expect(await graphe(db, antoine)).toHaveLength(2);

		await reprendre(db, { membreId: antoine, oeuvreId: numero, now: T0 });

		expect(await graphe(db, antoine)).toEqual([]);
	});

	it('le graphe d un membre ne bouge pas quand un autre retire sa consignation', async () => {
		const db = createTestDb();
		const antoine = await membre(db, 'Antoine');
		const bea = await membre(db, 'Béa');
		const numero = await oeuvre(db, '1', { serie: 'Ms. Marvel', personnages: ['Kamala Khan'] });

		await atteindre(db, antoine, numero);
		await atteindre(db, bea, numero);
		await deroulerGraphe(db, { now: T0 });

		await retirer(db, { membreId: antoine, oeuvreId: numero, now: T0 });

		expect(await graphe(db, antoine)).toEqual([]);
		expect(noms(await graphe(db, bea))).toEqual(['Kamala Khan', 'Ms. Marvel']);
	});

	it('une œuvre atteinte puis supprimée du catalogue ne laisse ni arête ni appui', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 'Alias', personnages: ['Jessica Jones'] });

		await atteindre(db, antoine, numero);
		expect(await graphe(db, antoine)).toHaveLength(2);

		// Le retrait de la consignation est ce qui libère l'œuvre : les clés
		// étrangères garantissent qu'on ne peut pas la supprimer autrement.
		await retirer(db, { membreId: antoine, oeuvreId: numero, now: T0 });
		await deroulerGraphe(db, { now: T0 });
		await db.delete(reachCrossings).where(eq(reachCrossings.workId, numero));
		await db.delete(graphRematerializations).where(eq(graphRematerializations.workId, numero));
		await db.delete(workCharacters).where(eq(workCharacters.workId, numero));
		await db.delete(workSources).where(eq(workSources.workId, numero));
		await db.delete(works).where(eq(works.id, numero));

		expect(await grapheDuMembre(db, antoine)).toEqual([]);
		expect(await recalculerGraphe(db, antoine, { now: T0 })).toEqual({ rejeux: 0, corrections: 0 });
	});
});

// ---------------------------------------------------------------------------
// Second déclencheur — les modifications de catalogue
// ---------------------------------------------------------------------------

describe('KTD4, second déclencheur — les rattachements qui changent', () => {
	it('une correction ajoutant un personnage à une œuvre déjà atteinte fait apparaître l arête, pour tous les membres concernés', async () => {
		const db = createTestDb();
		const antoine = await membre(db, 'Antoine');
		const bea = await membre(db, 'Béa');
		const claire = await membre(db, 'Claire');
		const numero = await oeuvre(db, '1', { serie: 'Doctor Strange', personnages: ['Strange'] });

		await atteindre(db, antoine, numero);
		await atteindre(db, bea, numero);
		// Claire l'a seulement mise de côté : rien ne doit apparaître chez elle.
		await consigner(db, { membreId: claire, oeuvreId: numero, etagere: 'a_decouvrir', now: T0 });
		await deroulerGraphe(db, { now: T0 });

		const wong = await entiteNue(db, 'Wong');
		const correction = await corriger(db, {
			oeuvreId: numero,
			membreId: antoine,
			correction: { champ: 'personnages', ajoutes: [wong], retires: [] },
			now: T0 + 1
		});
		expect(correction).toEqual({
			ok: true,
			correctionId: expect.any(String),
			rattachementsModifies: true
		});
		expect(await estEnAttente(db, numero)).toBe(true);

		await deroulerGraphe(db, { now: T0 + 2 });

		// Sans ce second déclencheur, Wong n'apparaîtrait jamais nulle part :
		// aucun état de lecture ne bougera plus jamais sur cette œuvre.
		expect(noms(await grapheDuMembre(db, antoine))).toEqual(['Strange', 'Wong', 'Doctor Strange']);
		expect(noms(await grapheDuMembre(db, bea))).toEqual(['Strange', 'Wong', 'Doctor Strange']);
		expect(await grapheDuMembre(db, claire)).toEqual([]);
		expect(await estEnAttente(db, numero)).toBe(false);
	});

	it('une correction qui retire un personnage retire l arête correspondante', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', {
			serie: 'Avengers',
			personnages: ['Vif-Argent', 'Vision']
		});

		await atteindre(db, antoine, numero);
		expect(await graphe(db, antoine)).toHaveLength(3);

		await corriger(db, {
			oeuvreId: numero,
			membreId: antoine,
			correction: {
				champ: 'personnages',
				ajoutes: [],
				retires: [await idDeLEntite(db, 'Vif-Argent')]
			},
			now: T0 + 1
		});
		await deroulerGraphe(db, { now: T0 + 2 });

		expect(noms(await grapheDuMembre(db, antoine))).toEqual(['Vision', 'Avengers']);
	});

	it('une ré-ingestion qui perd les personnages les retire aussi du graphe (R39)', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 'Nova', personnages: ['Nova', 'Gamora'] });

		await atteindre(db, antoine, numero);
		expect(await graphe(db, antoine)).toHaveLength(3);

		// La source affirme maintenant qu'il n'y a pas de personnage — ce qui n'est
		// pas la même chose que ne pas avoir répondu.
		await ingererOeuvre(
			db,
			oeuvreDistante('metron', '1', {
				titre: 'Œuvre 1',
				serie: entite('metron', 'serie-Nova', 'Nova'),
				personnages: [],
				completude: { personnages: 'absents' }
			}),
			{ now: T0 + 1 }
		);
		await deroulerGraphe(db, { now: T0 + 2 });

		expect(noms(await grapheDuMembre(db, antoine))).toEqual(['Nova']);
	});

	it('une correction sur une œuvre que personne n a atteinte ne fait rien apparaître', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 'Cable', personnages: ['Cable'] });
		await consigner(db, { membreId: antoine, oeuvreId: numero, etagere: 'en_cours', now: T0 });

		const domino = await entiteNue(db, 'Domino');
		await corriger(db, {
			oeuvreId: numero,
			membreId: antoine,
			correction: { champ: 'personnages', ajoutes: [domino], retires: [] },
			now: T0 + 1
		});
		await deroulerGraphe(db, { now: T0 + 2 });

		expect(await grapheDuMembre(db, antoine)).toEqual([]);
	});

	it('un titre corrigé ne demande aucune re-matérialisation : ce n est pas un rattachement', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 'Blade', personnages: ['Blade'] });
		await atteindre(db, antoine, numero);
		await deroulerGraphe(db, { now: T0 });

		const resultat = await corriger(db, {
			oeuvreId: numero,
			membreId: antoine,
			correction: { champ: 'titre', valeur: 'Blade #1' },
			now: T0 + 1
		});

		expect(resultat).toEqual({
			ok: true,
			correctionId: expect.any(String),
			rattachementsModifies: false
		});
		expect(await estEnAttente(db, numero)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// La cascade de recueil (U5) vue par le graphe
// ---------------------------------------------------------------------------

describe('la cascade de recueil alimente le graphe', () => {
	it('ajoute les appuis de tous les numéros atteints, pas ceux du recueil seul', async () => {
		const db = createTestDb();
		const antoine = await membre(db);

		const un = await oeuvre(db, 'n1', { serie: 'Daredevil', personnages: ['Elektra'] });
		const deux = await oeuvre(db, 'n2', { serie: 'Daredevil', personnages: ['Le Caïd'] });
		const trois = await oeuvre(db, 'n3', { serie: 'Daredevil', personnages: ['Bullseye'] });
		const omnibus = await oeuvre(db, 'r1', {
			type: 'recueil',
			titre: 'Daredevil par Miller',
			serie: 'Daredevil Omnibus',
			contenu: ['n1', 'n2', 'n3']
		});

		await atteindre(db, antoine, omnibus);
		const resultat = await graphe(db, antoine);

		expect(noms(resultat)).toEqual([
			'Bullseye',
			'Elektra',
			'Le Caïd',
			'Daredevil',
			'Daredevil Omnibus'
		]);
		// La série des numéros est établie par les trois, pas par le recueil.
		expect(arete(resultat, 'Daredevil')?.appuis).toEqual([un, deux, trois].sort());
		expect(arete(resultat, 'Daredevil Omnibus')?.appuis).toEqual([omnibus]);
	});

	it('retirer le recueil retire les appuis de ses numéros dérivés', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		await oeuvre(db, 'n1', { serie: 'Daredevil', personnages: ['Elektra'] });
		const omnibus = await oeuvre(db, 'r1', {
			type: 'recueil',
			titre: 'Omnibus',
			contenu: ['n1']
		});

		await atteindre(db, antoine, omnibus);
		expect(await graphe(db, antoine)).toHaveLength(2);

		await retirer(db, { membreId: antoine, oeuvreId: omnibus, now: T0 });

		expect(await graphe(db, antoine)).toEqual([]);
	});

	it('un numéro consigné directement survit au retrait du recueil qui le couvrait (R34)', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, 'n1', { serie: 'Daredevil', personnages: ['Elektra'] });
		const omnibus = await oeuvre(db, 'r1', {
			type: 'recueil',
			titre: 'Omnibus',
			contenu: ['n1']
		});

		await atteindre(db, antoine, numero);
		await atteindre(db, antoine, omnibus);
		expect(await graphe(db, antoine)).toHaveLength(2);

		await retirer(db, { membreId: antoine, oeuvreId: omnibus, now: T0 });

		// Le numéro reste atteint pour lui-même : ses appuis restent.
		expect(arete(await graphe(db, antoine), 'Elektra')?.appuis).toEqual([numero]);
	});
});

// ---------------------------------------------------------------------------
// KTD2 — le fractionnement et l'idempotence
// ---------------------------------------------------------------------------

describe('KTD2 — le fractionnement', () => {
	it('un budget borne le nombre de rejeux, et la file se vide au passage suivant', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		for (const i of [1, 2, 3, 4, 5]) {
			const numero = await oeuvre(db, `n${i}`, {
				serie: `Série ${i}`,
				personnages: [`Perso ${i}`]
			});
			await atteindre(db, antoine, numero);
		}

		const premier = await materialiserGraphe(db, { budget: 2, now: T0 });
		expect(premier.franchissements).toBe(2);
		expect(premier.restantes).toBeGreaterThan(0);
		expect(await grapheDuMembre(db, antoine)).toHaveLength(4);

		const suite = await deroulerGraphe(db, { budget: 2, now: T0 });
		expect(suite.restantes).toBe(0);
		expect(await grapheDuMembre(db, antoine)).toHaveLength(10);
	});

	it('rejouer un franchissement déjà traité n écrit rien', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 'Iron Man', personnages: ['Iron Man'] });
		await atteindre(db, antoine, numero);
		await deroulerGraphe(db, { now: T0 });

		const rejeu = await rejouerAppuis(db, { membreId: antoine, oeuvreId: numero, now: T0 });

		expect(rejeu).toEqual({ poses: 0, retires: 0, aretesCreees: 0, aretesSupprimees: 0 });
	});

	it('une file interrompue à mi-parcours reprend sans double effet', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const un = await oeuvre(db, 'n1', { serie: 'X-Force', personnages: ['Deadpool'] });
		const deux = await oeuvre(db, 'n2', { serie: 'X-Force', personnages: ['Deadpool'] });

		await atteindre(db, antoine, un);
		await atteindre(db, antoine, deux);

		// Un seul élément traité, puis tout le reste : le résultat est celui d'une
		// exécution d'un seul tenant.
		await materialiserGraphe(db, { budget: 1, now: T0 });
		await deroulerGraphe(db, { now: T0 });

		const resultat = await grapheDuMembre(db, antoine);
		expect(arete(resultat, 'Deadpool')?.appuis).toEqual([un, deux].sort());
		expect(await db.select().from(graphEdges)).toHaveLength(2);
	});

	it('une consignation typique écrit un nombre de lignes linéaire dans le nombre de crédits', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const personnages = Array.from({ length: 20 }, (_, i) => `Personnage ${i}`);
		const numero = await oeuvre(db, '1', { serie: 'Avengers', event: 'Secret Wars', personnages });

		await atteindre(db, antoine, numero);
		await deroulerGraphe(db, { now: T0 });

		// 20 personnages + 1 série + 1 event, et autant d'appuis. Pas 190 arêtes.
		expect(await db.select().from(graphEdges)).toHaveLength(22);
		expect(await db.select().from(graphEdgeSupports)).toHaveLength(22);
	});
});

// ---------------------------------------------------------------------------
// Le rattrapage
// ---------------------------------------------------------------------------

describe('le rattrapage du Cron Trigger', () => {
	it('le filtre SQL du rattrapage et le prédicat d atteinte disent la même chose', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 'Hawkeye', personnages: ['Œil-de-Faucon'] });

		const etats: { etagere: Etagere; abandonnee: boolean }[] = [
			{ etagere: 'a_decouvrir', abandonnee: false },
			{ etagere: 'en_cours', abandonnee: false },
			{ etagere: 'termine', abandonnee: false },
			{ etagere: 'en_cours', abandonnee: true }
		];

		await atteindre(db, antoine, numero);
		await deroulerGraphe(db, { now: T0 });

		for (const etat of etats) {
			await db
				.update(journalEntries)
				.set({ shelf: etat.etagere, abandonedAt: etat.abandonnee ? T0 : null })
				.where(eq(journalEntries.memberId, antoine));

			const vuParLeSql = await db
				.selectDistinct({ membreId: graphEdges.memberId })
				.from(graphEdgeSupports)
				.innerJoin(graphEdges, eq(graphEdges.id, graphEdgeSupports.edgeId))
				.leftJoin(journalEntries, eq(journalEntries.memberId, graphEdges.memberId))
				.where(FILTRE_SQL_NON_ATTEINTE);

			expect(vuParLeSql.length > 0).toBe(!estAtteinte(etat));
		}
	});

	it('un appui resté en place alors que l œuvre n est plus atteinte est retiré', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 'Ghost Rider', personnages: ['Ghost Rider'] });

		await atteindre(db, antoine, numero);
		await deroulerGraphe(db, { now: T0 });

		// L'entrée redevient « en cours » sans que le graphe l'apprenne : c'est la
		// divergence dangereuse, celle qui laisse voir une arête que R52 interdit.
		await db
			.update(journalEntries)
			.set({ shelf: 'en_cours', abandonedAt: null })
			.where(eq(journalEntries.memberId, antoine));
		expect(await grapheDuMembre(db, antoine)).toHaveLength(2);

		expect(await rattraperGraphe(db, { now: T0 + 1 })).toEqual({ rejoues: 1 });
		expect(await grapheDuMembre(db, antoine)).toEqual([]);
	});

	it('un graphe déjà juste ne coûte aucune écriture au rattrapage', async () => {
		const db = createTestDb();
		const antoine = await membre(db);
		const numero = await oeuvre(db, '1', { serie: 'Runaways', personnages: ['Nico'] });
		await atteindre(db, antoine, numero);
		await deroulerGraphe(db, { now: T0 });

		expect(await rattraperGraphe(db, { now: T0 + 1 })).toEqual({ rejoues: 0 });
		expect(await recalculerGraphe(db, antoine, { now: T0 + 1 })).toEqual({
			rejeux: 1,
			corrections: 0
		});
	});
});

// ---------------------------------------------------------------------------
// L'oracle
// ---------------------------------------------------------------------------

describe('le graphe matérialisé et le recalcul complet coïncident', () => {
	it('après une centaine d opérations mêlant consignation, retrait, abandon, reprise et correction de fiche', async () => {
		const db = createTestDb();

		const membres = [
			await membre(db, 'Antoine'),
			await membre(db, 'Béa'),
			await membre(db, 'Claire')
		];

		// Un petit catalogue qui se recouvre : des numéros partageant séries,
		// events et personnages, plus un recueil pour que la cascade s'en mêle.
		const oeuvres: string[] = [];
		for (let i = 0; i < 12; i += 1) {
			oeuvres.push(
				await oeuvre(db, `n${i}`, {
					serie: `Série ${i % 3}`,
					...(i % 4 === 0 ? { event: `Event ${i % 2}` } : {}),
					personnages: [`Perso ${i % 5}`, `Perso ${(i + 1) % 7}`]
				})
			);
		}
		oeuvres.push(
			await oeuvre(db, 'r0', {
				type: 'recueil',
				titre: 'Recueil',
				serie: 'Série recueil',
				contenu: ['n0', 'n1', 'n2']
			})
		);
		const personnagesLibres = [await entiteNue(db, 'Libre A'), await entiteNue(db, 'Libre B')];

		// Un générateur déterministe : un test d'intégration qui échoue une fois
		// sur dix ne se corrige pas, il se désactive.
		let graine = 42;
		const tirer = (n: number) => {
			graine = (graine * 1103515245 + 12345) % 2147483648;
			return Math.floor((graine / 2147483648) * n);
		};

		for (let operation = 0; operation < 100; operation += 1) {
			const membreId = membres[tirer(membres.length)];
			const oeuvreId = oeuvres[tirer(oeuvres.length)];
			const maintenant = T0 + operation;

			switch (tirer(6)) {
				case 0:
					await consigner(db, { membreId, oeuvreId, etagere: 'termine', now: maintenant });
					break;
				case 1:
					await consigner(db, { membreId, oeuvreId, etagere: 'en_cours', now: maintenant });
					break;
				case 2:
					await abandonner(db, { membreId, oeuvreId, now: maintenant });
					break;
				case 3:
					await reprendre(db, { membreId, oeuvreId, now: maintenant });
					break;
				case 4:
					await retirer(db, { membreId, oeuvreId, now: maintenant });
					break;
				case 5: {
					const personnage = personnagesLibres[tirer(personnagesLibres.length)];
					await corriger(db, {
						oeuvreId,
						membreId,
						correction:
							tirer(2) === 0
								? { champ: 'personnages', ajoutes: [personnage], retires: [] }
								: { champ: 'personnages', ajoutes: [], retires: [personnage] },
						now: maintenant
					});
					break;
				}
			}

			// Le Cron passe de temps en temps, pas après chaque geste : c'est bien
			// une file en retard qu'on veut éprouver.
			if (operation % 7 === 0) {
				await deroulerCascades(db, { now: maintenant });
				await deroulerGraphe(db, { now: maintenant });
			}
		}

		await deroulerCascades(db, { now: T0 + 1000 });
		await deroulerGraphe(db, { now: T0 + 1000 });
		await rattraperGraphe(db, { now: T0 + 1000 });

		let arretesTotales = 0;
		for (const membreId of membres) {
			const materialise = await grapheDuMembre(db, membreId);
			expect(materialise).toEqual(await grapheAttendu(db, membreId));
			// Un recalcul complet n'a plus rien à corriger.
			expect((await recalculerGraphe(db, membreId, { now: T0 + 1001 })).corrections).toBe(0);
			arretesTotales += materialise.length;
		}

		// Le scénario a bien produit un graphe : comparer deux ensembles vides ne
		// prouverait rien.
		expect(arretesTotales).toBeGreaterThan(0);

		// Et aucune arête ne survit sans appui, jusque dans les tables.
		const appuyees = new Set(
			(await db.select({ id: graphEdgeSupports.edgeId }).from(graphEdgeSupports)).map((l) => l.id)
		);
		const toutes = await db.select({ id: graphEdges.id }).from(graphEdges);
		expect(toutes.filter((a) => !appuyees.has(a.id))).toEqual([]);
	});
});
