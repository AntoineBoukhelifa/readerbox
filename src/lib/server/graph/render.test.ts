import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import {
	entities,
	graphEdgeSupports,
	graphEdges,
	journalEntries,
	members,
	works,
	type Member
} from '../db/schema';
import { ingererOeuvre } from '../catalog/ingest';
import { corriger } from '../catalog/corrections';
import { T0, entite, oeuvreDistante } from '../catalog/testing';
import type { NomDeSource, TypeOeuvre } from '../catalog/sources/types';
import { consigner } from '../journal/entries';
import { deroulerCascades } from '../journal/cascade';
import { ajouterEntree, creerOrdre } from '../orders/orders';
import { deroulerGraphe } from './rematerialize';
import { grapheDuMembre } from './materialize';
import { ACCORD_DES_DIMENSIONS, ACCORD_DES_RELATIONS, ouvrirGraphe, ouvrirNoeud } from './query';
import {
	DIMENSIONS,
	MAX_DIMENSIONS_ACTIVES,
	BUDGET_DE_PAIRES,
	SEUIL_FILTRAGE_CLIENT,
	analyserDimensions,
	filtrer,
	mesurerVolume,
	projeter,
	restreindre,
	type AppuiDEntite,
	type GrapheRendu
} from '$lib/graph/rendu';

/**
 * Le rendu, le filtrage et la navigation du graphe (U10).
 *
 * Trois choses se vérifient ici, et elles ne se confondent pas :
 *
 * - **la projection** — le nœud est l'entité et jamais l'œuvre (R50), et deux
 *   entités ne se touchent que par une œuvre atteinte qui les crédite toutes les
 *   deux. C'est le point où R52 pourrait être perdue au rendu après avoir été
 *   garantie à l'écriture ;
 * - **le filtrage** — une dimension, deux, jamais trois (R49, AE11), et le même
 *   résultat que le filtre s'applique sur le serveur ou dans le navigateur ;
 * - **l'ouverture d'un nœud** — les trois volets de R53, dont celui qui ouvre
 *   sur ce que le membre n'a pas encore lu.
 *
 * Le harnais de route est celui de U6 et U7 : la base de test est injectée par
 * substitution de `getDb`, tout le reste des routes s'exécute tel quel.
 */
const contexte = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('$lib/server/db', async (importOriginal) => {
	const original = await importOriginal<typeof import('../db')>();
	return { ...original, getDb: () => contexte.db };
});

const { load: chargerGraphe, actions: actionsGraphe } =
	await import('../../../routes/graph/+page.server');

let db: Db;

beforeEach(() => {
	db = createTestDb();
	contexte.db = db;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface ChampsOeuvre {
	type?: TypeOeuvre;
	titre?: string;
	serie?: string;
	event?: string;
	personnages?: string[];
	date?: string;
	source?: NomDeSource;
}

async function membre(nom: string): Promise<Member> {
	const [ligne] = await db.insert(members).values({ displayName: nom, createdAt: T0 }).returning();
	return ligne;
}

async function oeuvre(idExterne: string, champs: ChampsOeuvre = {}): Promise<string> {
	const source = champs.source ?? 'metron';
	const { oeuvreId } = await ingererOeuvre(
		db,
		oeuvreDistante(source, idExterne, {
			type: champs.type ?? 'numero',
			titre: champs.titre ?? `Œuvre ${idExterne}`,
			...(champs.date ? { dateDeParution: champs.date } : {}),
			...(champs.serie ? { serie: entite(source, `serie-${champs.serie}`, champs.serie) } : {}),
			...(champs.event ? { event: entite(source, `event-${champs.event}`, champs.event) } : {}),
			personnages: (champs.personnages ?? []).map((nom) => entite(source, `perso-${nom}`, nom))
		}),
		{ now: T0 }
	);
	return oeuvreId;
}

/** Consigner sur « terminé » : le geste qui atteint (R1, R3), files vidées. */
async function atteindre(membreId: string, oeuvreId: string, now = T0): Promise<void> {
	const resultat = await consigner(db, { membreId, oeuvreId, etagere: 'termine', now });
	expect(resultat.ok).toBe(true);
	await deroulerCascades(db, { now });
	await deroulerGraphe(db, { now });
}

async function idDeLEntite(nom: string): Promise<string> {
	const [ligne] = await db.select({ id: entities.id }).from(entities).where(eq(entities.name, nom));
	return ligne.id;
}

/** Un événement de requête réduit à ce que la route lit. */
function evenement<T>(
	membreConnecte: Member | null,
	champs: Record<string, string> = {},
	requete = ''
): T {
	const corps = new FormData();
	for (const [nom, valeur] of Object.entries(champs)) corps.set(nom, valeur);

	return {
		params: {},
		url: new URL(`http://localhost/${requete}`),
		locals: { member: membreConnecte },
		platform: { env: { DB: {} } },
		request: new Request('http://localhost/', { method: 'POST', body: corps })
	} as unknown as T;
}

function utile<T>(charge: T): Exclude<T, void> {
	return charge as Exclude<T, void>;
}

const nomsDe = (graphe: GrapheRendu) => graphe.noeuds.map((noeud) => noeud.nom).sort();

/** Les arêtes en clair : « Untel — Untel », pour lire une assertion sans identifiants. */
function liens(graphe: GrapheRendu): string[] {
	const noms = new Map(graphe.noeuds.map((noeud) => [noeud.id, noeud.nom]));
	return graphe.aretes
		.map((arete) =>
			[noms.get(arete.source) ?? '?', noms.get(arete.cible) ?? '?'].sort().join(' — ')
		)
		.sort();
}

/**
 * Une scène à trois dimensions : deux numéros d'une même série, un event, et un
 * personnage partagé.
 */
async function scene() {
	const lecteur = await membre('Antoine');

	const un = await oeuvre('1', {
		titre: 'Amazing #1',
		serie: 'Amazing',
		event: 'Guerre civile',
		personnages: ['Spider-Man', 'Tornade'],
		date: '1963-03-01'
	});
	const deux = await oeuvre('2', {
		titre: 'Amazing #2',
		serie: 'Amazing',
		personnages: ['Spider-Man', 'Docteur Fatalis'],
		date: '1963-04-01'
	});

	await atteindre(lecteur.id, un);
	await atteindre(lecteur.id, deux);

	return { lecteur, un, deux };
}

// ---------------------------------------------------------------------------
// La projection (R50, R52)
// ---------------------------------------------------------------------------

describe('la projection du graphe matérialisé (R50, R52)', () => {
	it('R50 — deux œuvres atteintes partageant un personnage ne font qu’un nœud', async () => {
		const { lecteur } = await scene();

		const graphe = projeter(await grapheDuMembre(db, lecteur.id));
		const spider = graphe.noeuds.filter((noeud) => noeud.nom === 'Spider-Man');

		expect(spider).toHaveLength(1);
		// Et le nœud sait que deux œuvres l'ont établi : c'est ce qui fera son poids.
		expect(spider[0].oeuvres).toBe(2);
		// La série non plus n'est pas dédoublée par ses deux numéros.
		expect(graphe.noeuds.filter((noeud) => noeud.nom === 'Amazing')).toHaveLength(1);
	});

	it('R50 — aucune œuvre n’est un nœud, même quand elle porte tout le graphe', async () => {
		const { lecteur } = await scene();

		const graphe = projeter(await grapheDuMembre(db, lecteur.id));

		expect(nomsDe(graphe)).toEqual([
			'Amazing',
			'Docteur Fatalis',
			'Guerre civile',
			'Spider-Man',
			'Tornade'
		]);
	});

	it('deux entités ne se touchent que par une œuvre atteinte qui les crédite toutes les deux', async () => {
		const { lecteur } = await scene();

		const graphe = projeter(await grapheDuMembre(db, lecteur.id));

		// Tornade et Fatalis ne se sont jamais croisés : ils sont dans deux numéros
		// différents, et rien ne les relie même si les deux nœuds existent.
		expect(liens(graphe)).not.toContain('Docteur Fatalis — Tornade');
		expect(liens(graphe)).toContain('Docteur Fatalis — Spider-Man');
		expect(liens(graphe)).toContain('Spider-Man — Tornade');
	});

	it('le poids d’une arête compte les œuvres qui la portent', async () => {
		const { lecteur } = await scene();

		const graphe = projeter(await grapheDuMembre(db, lecteur.id));
		const noms = new Map(graphe.noeuds.map((noeud) => [noeud.nom, noeud.id]));
		const spiderSerie = graphe.aretes.find(
			(arete) =>
				[arete.source, arete.cible].includes(noms.get('Spider-Man') as string) &&
				[arete.source, arete.cible].includes(noms.get('Amazing') as string)
		);

		expect(spiderSerie?.poids).toBe(2);
	});

	it('R52 — une œuvre non atteinte ne relie pas deux nœuds déjà présents', async () => {
		const { lecteur } = await scene();

		// Le lien Tornade–Fatalis est établi par une œuvre que le lecteur consigne
		// sans l'atteindre. Les deux nœuds sont pourtant déjà là.
		const cachee = await oeuvre('3', {
			titre: 'La rencontre',
			personnages: ['Tornade', 'Docteur Fatalis']
		});
		await consigner(db, { membreId: lecteur.id, oeuvreId: cachee, etagere: 'en_cours', now: T0 });
		await deroulerGraphe(db, { now: T0 });

		const graphe = projeter(await grapheDuMembre(db, lecteur.id));

		expect(nomsDe(graphe)).toContain('Tornade');
		expect(nomsDe(graphe)).toContain('Docteur Fatalis');
		expect(liens(graphe)).not.toContain('Docteur Fatalis — Tornade');
	});

	it('le graphe d’un membre ne contient rien de celui d’un autre', async () => {
		const { lecteur } = await scene();
		const voisin = await membre('Camille');
		const sienne = await oeuvre('9', { titre: 'Ailleurs', personnages: ['Namor'] });
		await atteindre(voisin.id, sienne);

		const graphe = projeter(await grapheDuMembre(db, lecteur.id));

		expect(nomsDe(graphe)).not.toContain('Namor');
	});
});

// ---------------------------------------------------------------------------
// Le filtrage (R49, AE11)
// ---------------------------------------------------------------------------

describe('le filtrage par dimension (R49, AE11)', () => {
	it('AE11 — n’activer qu’un type n’affiche que les arêtes de ce type', async () => {
		const { lecteur } = await scene();

		const charge = utile(await chargerGraphe(evenement(lecteur, {}, 'graph?dimension=personnage')));
		const affiche = filtrer(charge.graphe, charge.dimensions);

		expect(charge.dimensions).toEqual(['personnage']);
		expect(nomsDe(affiche)).toEqual(['Docteur Fatalis', 'Spider-Man', 'Tornade']);
		expect(liens(affiche)).toEqual(['Docteur Fatalis — Spider-Man', 'Spider-Man — Tornade']);
	});

	it('activer deux types affiche les deux, et les liens qui vont de l’un à l’autre', async () => {
		const { lecteur } = await scene();

		const charge = utile(
			await chargerGraphe(evenement(lecteur, {}, 'graph?dimension=personnage&dimension=serie'))
		);
		const affiche = filtrer(charge.graphe, charge.dimensions);

		expect(charge.dimensions).toEqual(['personnage', 'serie']);
		expect(nomsDe(affiche)).toEqual(['Amazing', 'Docteur Fatalis', 'Spider-Man', 'Tornade']);
		expect(liens(affiche)).toContain('Amazing — Spider-Man');
		// L'event n'est pas actif : ni son nœud ni ses liens n'apparaissent.
		expect(nomsDe(affiche)).not.toContain('Guerre civile');
	});

	it('en activer un troisième est refusé, et la surface le dit', async () => {
		const { lecteur } = await scene();

		const charge = utile(
			await chargerGraphe(
				evenement(lecteur, {}, 'graph?dimension=personnage&dimension=serie&dimension=event')
			)
		);

		expect(charge.dimensions).toHaveLength(MAX_DIMENSIONS_ACTIVES);
		expect(charge.message).toMatch(/deux dimensions/i);
		expect(nomsDe(filtrer(charge.graphe, charge.dimensions))).not.toContain('Guerre civile');
	});

	it('décocher tout est refusé plutôt que de rendre un écran vide trompeur', () => {
		const choix = analyserDimensions(['sans-rapport']);

		expect(choix.refus).toBe('aucune dimension');
		expect(choix.dimensions.length).toBeGreaterThan(0);
	});

	it('une demande sans dimension prend le défaut, sans rien refuser', () => {
		expect(analyserDimensions([])).toEqual({
			dimensions: ['personnage', 'serie'],
			refus: null
		});
	});

	it('l’ordre des dimensions est celui du produit, pas celui de l’URL', () => {
		expect(analyserDimensions(['serie', 'personnage']).dimensions).toEqual(['personnage', 'serie']);
	});

	it('filtrer sur le serveur et filtrer dans le navigateur donnent le même graphe', async () => {
		const { lecteur } = await scene();
		const appuis = await grapheDuMembre(db, lecteur.id);

		for (const dimensions of [['personnage'], ['serie'], ['personnage', 'event']] as const) {
			// Ce que fait le serveur au-dessus du seuil : restreindre puis projeter.
			const cotéServeur = projeter(restreindre(appuis, dimensions));
			// Ce que fait le navigateur en dessous : projeter tout, puis filtrer.
			const cotéClient = filtrer(projeter(appuis), dimensions);

			expect(cotéServeur).toEqual(cotéClient);
		}
	});

	it('le filtre est idempotent : la surface peut l’appliquer sans savoir qui a déjà filtré', async () => {
		const { lecteur } = await scene();
		const graphe = filtrer(projeter(await grapheDuMembre(db, lecteur.id)), ['personnage']);

		expect(filtrer(graphe, ['personnage'])).toEqual(graphe);
	});

	it('les deux listes de dimensions restent d’accord', () => {
		expect([...ACCORD_DES_DIMENSIONS].sort()).toEqual([...ACCORD_DES_RELATIONS].sort());
		expect([...DIMENSIONS].sort()).toEqual([...ACCORD_DES_RELATIONS].sort());
	});
});

// ---------------------------------------------------------------------------
// L'état d'accueil
// ---------------------------------------------------------------------------

describe('le graphe vide d’un nouveau membre', () => {
	it('rend l’état d’accueil, pas une erreur', async () => {
		const nouveau = await membre('Dominique');

		const charge = utile(await chargerGraphe(evenement(nouveau, {}, 'graph')));

		expect(charge.volume.noeuds).toBe(0);
		expect(charge.graphe).toEqual({ noeuds: [], aretes: [], tronque: false });
		expect(charge.message).toBe(null);
	});

	it('propose un ordre du groupe à suivre, quand il en existe un', async () => {
		const nouveau = await membre('Dominique');
		const auteur = await membre('Camille');
		const creation = await creerOrdre(db, {
			membreId: auteur.id,
			titre: 'Par où entrer',
			now: T0
		});
		expect(creation.ok).toBe(true);

		const charge = utile(await chargerGraphe(evenement(nouveau, {}, 'graph')));

		expect(charge.suggestion).toMatchObject({ titre: 'Par où entrer' });
	});

	it('ne propose rien quand personne n’a écrit d’ordre', async () => {
		const nouveau = await membre('Dominique');

		const charge = utile(await chargerGraphe(evenement(nouveau, {}, 'graph')));

		expect(charge.suggestion).toBe(null);
	});

	it('un membre qui a lu n’est pas renvoyé à l’état d’accueil', async () => {
		const { lecteur } = await scene();

		const charge = utile(await chargerGraphe(evenement(lecteur, {}, 'graph')));

		expect(charge.volume.noeuds).toBeGreaterThan(0);
		expect(charge.suggestion).toBe(null);
	});
});

// ---------------------------------------------------------------------------
// R53 — l'ouverture d'un nœud
// ---------------------------------------------------------------------------

describe('ouvrir un nœud (R53)', () => {
	/** La scène de F6, plus un ordre qui couvre et une apparition non atteinte. */
	async function sceneDeNoeud() {
		const { lecteur, un, deux } = await scene();
		const auteur = await membre('Camille');

		const creation = await creerOrdre(db, { membreId: auteur.id, titre: 'Par où entrer', now: T0 });
		if (!creation.ok) throw new Error(creation.motif);
		await ajouterEntree(db, {
			membreId: auteur.id,
			ordreId: creation.ordreId,
			oeuvreId: un,
			now: T0
		});
		const hors = await oeuvre('hors', { titre: 'Hors sujet', personnages: ['Namor'] });
		await ajouterEntree(db, {
			membreId: auteur.id,
			ordreId: creation.ordreId,
			oeuvreId: hors,
			now: T0
		});

		// Une apparition que le lecteur n'a pas atteinte : c'est le troisième volet.
		const aVenir = await oeuvre('4', {
			titre: 'Amazing #4',
			serie: 'Amazing',
			personnages: ['Spider-Man'],
			date: '1963-06-01'
		});

		return {
			lecteur,
			un,
			deux,
			aVenir,
			ordreId: creation.ordreId,
			spider: await idDeLEntite('Spider-Man')
		};
	}

	it('R53 — rend les œuvres atteintes, les ordres qui les couvrent, et les apparitions non atteintes', async () => {
		const { lecteur, spider, aVenir } = await sceneDeNoeud();

		const charge = utile(await chargerGraphe(evenement(lecteur, {}, `graph?noeud=${spider}`)));
		const noeud = charge.noeud;

		expect(noeud?.nom).toBe('Spider-Man');
		expect(noeud?.oeuvres.map((o: { titre: string }) => o.titre)).toEqual([
			'Amazing #1',
			'Amazing #2'
		]);
		expect(noeud?.ordres).toMatchObject([
			{ titre: 'Par où entrer', auteur: 'Camille', couvertes: 1, nombreDEntrees: 2 }
		]);
		expect(noeud?.apparitions).toMatchObject([
			{ id: aVenir, titre: 'Amazing #4', consignee: false }
		]);
	});

	it('les apparitions ne contiennent jamais une œuvre déjà atteinte', async () => {
		const { lecteur, spider, aVenir } = await sceneDeNoeud();
		await atteindre(lecteur.id, aVenir, T0 + 1);

		const noeud = await ouvrirNoeud(db, lecteur.id, spider, await grapheDuMembre(db, lecteur.id));

		expect(noeud?.apparitions).toEqual([]);
		expect(noeud?.oeuvres.map((o) => o.titre)).toContain('Amazing #4');
	});

	it('une apparition posée sur une étagère sans être atteinte reste proposée, et le dit', async () => {
		const { lecteur, spider, aVenir } = await sceneDeNoeud();
		await consigner(db, { membreId: lecteur.id, oeuvreId: aVenir, etagere: 'en_cours', now: T0 });

		const noeud = await ouvrirNoeud(db, lecteur.id, spider, await grapheDuMembre(db, lecteur.id));

		expect(noeud?.apparitions).toMatchObject([{ titre: 'Amazing #4', consignee: true }]);
	});

	it('les apparitions suivent les corrections de fiche (R47, R39)', async () => {
		const { lecteur, spider } = await sceneDeNoeud();
		const oubliee = await oeuvre('5', { titre: 'Le numéro oublié' });
		const correcteur = await membre('Camille');

		const resultat = await corriger(db, {
			oeuvreId: oubliee,
			membreId: correcteur.id,
			correction: { champ: 'personnages', ajoutes: [spider], retires: [] },
			now: T0
		});
		expect(resultat.ok).toBe(true);

		const noeud = await ouvrirNoeud(db, lecteur.id, spider, await grapheDuMembre(db, lecteur.id));

		expect(noeud?.apparitions.map((a) => a.titre)).toContain('Le numéro oublié');
	});

	it('un personnage retiré d’une fiche sort des apparitions', async () => {
		const { lecteur, spider, aVenir } = await sceneDeNoeud();
		const correcteur = await membre('Camille');

		await corriger(db, {
			oeuvreId: aVenir,
			membreId: correcteur.id,
			correction: { champ: 'personnages', ajoutes: [], retires: [spider] },
			now: T0
		});

		const noeud = await ouvrirNoeud(db, lecteur.id, spider, await grapheDuMembre(db, lecteur.id));

		expect(noeud?.apparitions).toEqual([]);
	});

	it('un nœud absent du graphe du membre n’ouvre rien', async () => {
		const { lecteur } = await scene();
		const voisin = await membre('Camille');
		const sienne = await oeuvre('9', { titre: 'Ailleurs', personnages: ['Namor'] });
		await atteindre(voisin.id, sienne);
		const namor = await idDeLEntite('Namor');

		const charge = utile(await chargerGraphe(evenement(lecteur, {}, `graph?noeud=${namor}`)));

		expect(charge.noeud).toBe(null);
	});

	it('une entité inventée n’ouvre rien non plus', async () => {
		const { lecteur } = await scene();

		const charge = utile(await chargerGraphe(evenement(lecteur, {}, 'graph?noeud=inexistante')));

		expect(charge.noeud).toBe(null);
	});

	it('un ordre dont l’auteur est parti reste couvrant, sans son nom (R38)', async () => {
		const { lecteur, spider } = await sceneDeNoeud();
		await db
			.update(members)
			.set({ leftAt: T0 + 1 })
			.where(eq(members.displayName, 'Camille'));

		const noeud = await ouvrirNoeud(db, lecteur.id, spider, await grapheDuMembre(db, lecteur.id));

		expect(noeud?.ordres).toMatchObject([{ titre: 'Par où entrer', auteur: null }]);
	});
});

// ---------------------------------------------------------------------------
// Le geste que le graphe existe pour provoquer
// ---------------------------------------------------------------------------

describe('consigner depuis un nœud', () => {
	it('un membre consigne une œuvre qu’il n’avait pas atteinte, et son graphe s’étend ensuite', async () => {
		const { lecteur } = await scene();
		const spider = await idDeLEntite('Spider-Man');
		const aVenir = await oeuvre('4', {
			titre: 'Amazing #4',
			serie: 'Amazing',
			personnages: ['Spider-Man', 'Sentry']
		});

		const resultat = await actionsGraphe.consigner(
			evenement(lecteur, { oeuvre: aVenir, etagere: 'a_decouvrir' }, `graph?noeud=${spider}`)
		);

		expect(resultat).toMatchObject({ fait: true });

		// R42 — la provenance est le catalogue : ni un membre ni un ordre.
		const entree = await db.query.journalEntries.findFirst({
			where: eq(journalEntries.workId, aVenir)
		});
		expect(entree?.provenance).toBe('catalogue');

		// R51 — tant qu'elle n'est pas atteinte, elle n'ajoute rien au graphe.
		await deroulerGraphe(db, { now: T0 });
		expect(nomsDe(projeter(await grapheDuMembre(db, lecteur.id)))).not.toContain('Sentry');

		// Une fois lue, le nœud apparaît.
		await atteindre(lecteur.id, aVenir, T0 + 1);
		expect(nomsDe(projeter(await grapheDuMembre(db, lecteur.id)))).toContain('Sentry');
	});

	it('refuse une œuvre inconnue', async () => {
		const { lecteur } = await scene();

		const resultat = await actionsGraphe.consigner(
			evenement(lecteur, { oeuvre: 'inexistante', etagere: 'a_decouvrir' })
		);

		expect(resultat).toMatchObject({ status: 404 });
	});

	it('refuse une étagère inconnue', async () => {
		const { lecteur } = await scene();

		const resultat = await actionsGraphe.consigner(
			evenement(lecteur, { oeuvre: 'peu importe', etagere: 'inventée' })
		);

		expect(resultat).toMatchObject({ status: 400 });
	});

	it('refuse sans session', async () => {
		const resultat = await actionsGraphe.consigner(evenement(null, { oeuvre: 'x' }));

		expect(resultat).toMatchObject({ status: 401 });
	});
});

// ---------------------------------------------------------------------------
// Le graphe est celui de la session
// ---------------------------------------------------------------------------

describe('un membre n’obtient pas le graphe d’un autre', () => {
	it('aucun paramètre d’URL ne change de membre', async () => {
		const { lecteur } = await scene();
		const voisin = await membre('Camille');
		const sienne = await oeuvre('9', { titre: 'Ailleurs', personnages: ['Namor'] });
		await atteindre(voisin.id, sienne);
		const namor = await idDeLEntite('Namor');

		// Tout ce qu'un membre peut forger, posé d'un coup dans la requête.
		const charge = utile(
			await chargerGraphe(
				evenement(
					lecteur,
					{},
					`graph?membre=${voisin.id}&membreId=${voisin.id}&id=${voisin.id}&noeud=${namor}`
				)
			)
		);

		expect(nomsDe(charge.graphe)).not.toContain('Namor');
		expect(nomsDe(charge.graphe)).toContain('Spider-Man');
		expect(charge.noeud).toBe(null);
	});

	it('refuse la page sans session', async () => {
		await expect(chargerGraphe(evenement(null, {}, 'graph'))).rejects.toMatchObject({
			status: 401
		});
	});
});

// ---------------------------------------------------------------------------
// Charge : mille nœuds, cinq mille arêtes
// ---------------------------------------------------------------------------

/**
 * Le seuil de bascule du filtrage, mesuré plutôt que deviné.
 *
 * Le graphe est écrit directement dans les tables de U9 : passer par une
 * centaine d'ingestions et de consignations mesurerait la matérialisation, qui
 * n'est pas ce qui se joue ici. La forme est celle qu'une centaine d'œuvres
 * atteintes produit — cinq entités créditées par œuvre — étendue jusqu'au
 * scénario de charge du plan.
 */
async function grapheSynthetique(
	membreId: string,
	options: { entites: number; oeuvres: number; parOeuvre: number }
): Promise<void> {
	const entiteIds: string[] = [];
	for (let debut = 0; debut < options.entites; debut += 200) {
		const lot = Array.from({ length: Math.min(200, options.entites - debut) }, (_, index) => ({
			type: 'personnage' as const,
			name: `Entité ${debut + index}`,
			createdAt: T0
		}));
		const inserees = await db.insert(entities).values(lot).returning({ id: entities.id });
		entiteIds.push(...inserees.map((ligne) => ligne.id));
	}

	const oeuvreIds: string[] = [];
	for (let debut = 0; debut < options.oeuvres; debut += 200) {
		const lot = Array.from({ length: Math.min(200, options.oeuvres - debut) }, (_, index) => ({
			type: 'numero' as const,
			title: `Numéro ${debut + index}`,
			ingestionState: 'complete' as const,
			createdAt: T0,
			updatedAt: T0
		}));
		const inserees = await db.insert(works).values(lot).returning({ id: works.id });
		oeuvreIds.push(...inserees.map((ligne) => ligne.id));
	}

	const areteIds: string[] = [];
	for (let debut = 0; debut < entiteIds.length; debut += 200) {
		const lot = entiteIds.slice(debut, debut + 200).map((entityId) => ({
			memberId: membreId,
			relation: 'personnage' as const,
			entityId,
			createdAt: T0
		}));
		const inserees = await db.insert(graphEdges).values(lot).returning({ id: graphEdges.id });
		areteIds.push(...inserees.map((ligne) => ligne.id));
	}

	/**
	 * Chaque œuvre crédite `parOeuvre` entités. Les deux premières sont assignées
	 * en balayage — c'est ce qui garantit que toute entité est créditée au moins
	 * une fois, donc que le graphe compte bien le nombre de nœuds annoncé — et les
	 * suivantes sont tirées par un générateur déterministe, pour que les paires ne
	 * se répètent pas d'une œuvre à l'autre. Un décalage constant donnerait cinq
	 * mille paires dont un tiers de doublons, donc un graphe plus petit que celui
	 * qu'on croit mesurer.
	 */
	const appuis: { edgeId: string; workId: string; createdAt: number }[] = [];
	for (let i = 0; i < oeuvreIds.length; i += 1) {
		const choisies = new Set<number>([(i * 2) % areteIds.length, (i * 2 + 1) % areteIds.length]);
		let graine = (i * 7919 + 12345) % 2147483647;
		while (choisies.size < options.parOeuvre) {
			graine = (graine * 48271) % 2147483647;
			choisies.add(graine % areteIds.length);
		}
		for (const index of choisies) {
			appuis.push({ edgeId: areteIds[index], workId: oeuvreIds[i], createdAt: T0 });
		}
	}
	for (let debut = 0; debut < appuis.length; debut += 200) {
		await db.insert(graphEdgeSupports).values(appuis.slice(debut, debut + 200));
	}
}

describe('scénario de charge', () => {
	it('mille nœuds et cinq mille arêtes restent manipulables, et le seuil est mesuré', async () => {
		const lourd = await membre('Antoine');
		await grapheSynthetique(lourd.id, { entites: 1000, oeuvres: 500, parOeuvre: 5 });

		const depart = performance.now();
		const vue = await ouvrirGraphe(db, lourd.id, { dimensions: ['personnage'] });
		const millisecondes = performance.now() - depart;

		// La part de calcul pur, séparée de la lecture : c'est elle qui est comparable
		// aux 10 ms de temps processeur d'une requête Cloudflare (KTD2).
		const appuis = await grapheDuMembre(db, lourd.id);
		const avantProjection = performance.now();
		projeter(appuis);
		const projection = performance.now() - avantProjection;

		const poids = JSON.stringify(vue.graphe).length;

		expect(vue.graphe.noeuds).toHaveLength(1000);
		expect(vue.graphe.aretes.length).toBeGreaterThan(4000);
		expect(vue.graphe.tronque).toBe(false);

		console.log(
			`[U10] ${vue.graphe.noeuds.length} nœuds, ${vue.graphe.aretes.length} arêtes : ` +
				`${millisecondes.toFixed(1)} ms de bout en bout, dont ${projection.toFixed(1)} ms de ` +
				`projection, pour ${(poids / 1024).toFixed(0)} Ko de charge utile ` +
				`(${Math.round(poids / vue.graphe.aretes.length)} octets par arête).`
		);

		// La mesure sert de garde-fou, pas de chronomètre : une régression d'un
		// ordre de grandeur échoue, une machine lente ne fait pas échouer.
		expect(millisecondes).toBeLessThan(2000);
	});

	it('le filtrage passe au serveur au-delà du seuil, et rien d’autre ne change', async () => {
		const lourd = await membre('Antoine');
		await grapheSynthetique(lourd.id, { entites: 1000, oeuvres: 500, parOeuvre: 5 });

		const vue = await ouvrirGraphe(db, lourd.id, { dimensions: ['personnage'] });

		expect(vue.volume.aretesEstimees).toBeGreaterThan(SEUIL_FILTRAGE_CLIENT);
		expect(vue.filtrageClient).toBe(false);
		// Le filtre reste applicable côté surface, et ne retire rien de plus.
		expect(filtrer(vue.graphe, ['personnage'])).toEqual(vue.graphe);
	});

	it('un graphe ordinaire reste filtré dans le navigateur', async () => {
		const { lecteur } = await scene();

		const vue = await ouvrirGraphe(db, lecteur.id, { dimensions: ['personnage'] });

		expect(vue.filtrageClient).toBe(true);
		// La charge utile porte alors les trois dimensions, prêtes à être cochées.
		expect(nomsDe(vue.graphe)).toContain('Guerre civile');
	});

	it('le majorant du volume ne coûte pas la projection', () => {
		const appuis: AppuiDEntite[] = [
			{ relation: 'personnage', entiteId: 'a', nom: 'A', appuis: ['o1'] },
			{ relation: 'personnage', entiteId: 'b', nom: 'B', appuis: ['o1'] },
			{ relation: 'personnage', entiteId: 'c', nom: 'C', appuis: ['o1', 'o2'] },
			{ relation: 'serie', entiteId: 'd', nom: 'D', appuis: ['o2'] }
		];

		// o1 crédite trois entités (3 paires), o2 en crédite deux (1 paire).
		expect(mesurerVolume(appuis)).toEqual({ noeuds: 4, appuis: 5, aretesEstimees: 4 });
		expect(projeter(appuis).aretes).toHaveLength(4);
	});

	it('une œuvre trop dense pour le budget est écartée entière, et le graphe le dit', () => {
		// Une œuvre créditant assez d'entités pour dépasser le budget à elle seule,
		// et une deuxième, minuscule, qui doit continuer de compter.
		const entites = 200;
		const appuis: AppuiDEntite[] = Array.from({ length: entites }, (_, index) => ({
			relation: 'personnage' as const,
			entiteId: `e${index}`,
			nom: `E${index}`,
			appuis: ['dense']
		}));
		appuis[0].appuis = ['dense', 'legere'];
		appuis[1].appuis = ['dense', 'legere'];

		expect(mesurerVolume(appuis).aretesEstimees).toBeGreaterThan(BUDGET_DE_PAIRES);

		const graphe = projeter(appuis);

		expect(graphe.tronque).toBe(true);
		// Les deux cents nœuds restent : c'est l'adjacence qui est amputée, pas ce
		// que les œuvres atteintes ont fait apparaître (R51).
		expect(graphe.noeuds).toHaveLength(entites);
		expect(graphe.aretes).toEqual([{ source: 'e0', cible: 'e1', poids: 1 }]);
	});

	it('un graphe qui tient dans le budget n’est jamais marqué tronqué', () => {
		const appuis: AppuiDEntite[] = Array.from({ length: 40 }, (_, index) => ({
			relation: 'personnage' as const,
			entiteId: `e${index}`,
			nom: `E${index}`,
			appuis: ['o1']
		}));

		const graphe = projeter(appuis);

		expect(graphe.tronque).toBe(false);
		expect(graphe.aretes).toHaveLength((40 * 39) / 2);
	});
});
