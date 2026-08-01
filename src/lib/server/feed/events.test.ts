import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import { feedEvents, members, works, type Member } from '../db/schema';
import type { TypeOeuvre } from '../catalog/sources/types';
import { ingererOeuvre } from '../catalog/ingest';
import { T0, oeuvreDistante, reference } from '../catalog/testing';
import {
	abandonner,
	consigner,
	declarerPosition,
	ecrireAvis,
	noter,
	reprendre,
	retirer,
	supprimerAvis
} from '../journal/entries';
import { franchissementEnAttente } from '../journal/frontiere';
import { deroulerCascades } from '../journal/cascade';
import { creerOrdre, forker, suivre, supprimerOrdre } from '../orders/orders';
import { createSession, markMemberAsLeft, resolveSession } from '../auth/sessions';
import { createInvitation } from '../auth/invitations';
import { lireFil, notificationsDe, marquerNotificationsLues, transition } from './events';

/**
 * Le fil du groupe (R41), le masquage des titres (R32), la provenance (R42), la
 * notification de recommandation (R43) et le départ d'un membre (R38).
 *
 * Deux choses valent d'être dites avant les tests eux-mêmes.
 *
 * **Le fil n'est pas la file de franchissement.** `journal/frontiere.ts` ne garde
 * qu'une ligne en attente par couple membre-œuvre et l'écrase à chaque geste ;
 * c'est ce qu'il faut au graphe et c'est l'inverse de ce qu'il faut à un fil. Le
 * test « deux transitions successives » compare les deux directement, parce que
 * c'est la confusion qui coûterait le plus cher.
 *
 * **Le titre n'obéit pas à la règle des textes.** R32 est plus étroit que R27 :
 * un titre n'est masqué que pour un membre qui a placé l'œuvre sur « à
 * découvrir ». Confondre les deux rendrait le fil illisible — cinquante mille
 * titres non atteints — ou le rendrait bavard.
 */

const contexte = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('$lib/server/db', async (importOriginal) => {
	const original = await importOriginal<typeof import('../db')>();
	return { ...original, getDb: () => contexte.db };
});

const { load: chargerFil, actions: actionsFil } = await import('../../../routes/feed/+page.server');
const { load: chargerOeuvre } = await import('../../../routes/work/[id]/+page.server');
const { load: chargerOrdre } = await import('../../../routes/order/[id]/+page.server');

let db: Db;

beforeEach(() => {
	db = createTestDb();
	contexte.db = db;
});

// ---------------------------------------------------------------------------
// Harnais
// ---------------------------------------------------------------------------

async function membre(nom: string): Promise<Member> {
	const [ligne] = await db.insert(members).values({ displayName: nom, createdAt: T0 }).returning();
	return ligne;
}

async function oeuvre(idExterne: string, type: TypeOeuvre = 'numero'): Promise<string> {
	const { oeuvreId } = await ingererOeuvre(
		db,
		oeuvreDistante('metron', idExterne, { titre: `Œuvre ${idExterne}`, type }),
		{ now: T0 }
	);
	return oeuvreId;
}

/** Un recueil et les numéros qu'il contient, tous ingérés. */
async function recueil(
	idExterne: string,
	contenu: string[]
): Promise<{ id: string; numeros: string[] }> {
	const numeros: string[] = [];
	for (const id of contenu) numeros.push(await oeuvre(id));

	const { oeuvreId } = await ingererOeuvre(
		db,
		oeuvreDistante('metron', idExterne, {
			type: 'recueil',
			titre: `Recueil ${idExterne}`,
			contenu: contenu.map((id) => reference('metron', id))
		}),
		{ now: T0 }
	);
	return { id: oeuvreId, numeros };
}

/** Un événement de requête réduit à ce que les routes lisent. */
function evenement<T>(
	membreConnecte: Member | null,
	params: Record<string, string> = {},
	champs: Record<string, string> = {}
): T {
	const corps = new FormData();
	for (const [nom, valeur] of Object.entries(champs)) corps.set(nom, valeur);

	return {
		params,
		url: new URL('http://localhost/'),
		locals: { member: membreConnecte },
		platform: { env: { DB: {} } },
		request: new Request('http://localhost/', { method: 'POST', body: corps })
	} as unknown as T;
}

function utile<T>(charge: T): Exclude<T, void> {
	return charge as Exclude<T, void>;
}

/**
 * Une ligne du fil telle que la surface l'envoie.
 *
 * `load` tire son type de son propre retour, ce qui ne survit pas à l'import
 * dynamique du harnais : on redit ici la forme qu'on inspecte, et c'est aussi
 * une façon de la fixer.
 */
interface LigneAffichee {
	id: string;
	type: string;
	acteur: string;
	oeuvre: { id: string | null; libelle: string; masque: boolean };
	provenance: { libelle: string; ordreId: string | null } | null;
}

function lignes(charge: unknown): LigneAffichee[] {
	return (charge as { evenements: LigneAffichee[] }).evenements;
}

/** Toutes les chaînes d'une charge utile, quelle que soit leur profondeur. */
function chaines(valeur: unknown, vues = new Set<unknown>()): string[] {
	if (typeof valeur === 'string') return [valeur];
	if (valeur === null || typeof valeur !== 'object') return [];
	if (vues.has(valeur)) return [];
	vues.add(valeur);

	if (Array.isArray(valeur)) return valeur.flatMap((element) => chaines(element, vues));
	if (valeur instanceof Map) {
		return [...valeur.entries()].flatMap(([cle, val]) => [
			...chaines(cle, vues),
			...chaines(val, vues)
		]);
	}
	if (valeur instanceof Set) return [...valeur].flatMap((element) => chaines(element, vues));

	return Object.entries(valeur).flatMap(([cle, val]) => [cle, ...chaines(val, vues)]);
}

// ---------------------------------------------------------------------------
// La transition, en fonction pure
// ---------------------------------------------------------------------------

describe('ce qu’une transition produit (R41)', () => {
	const pose = (etagere: 'a_decouvrir' | 'en_cours' | 'termine') => ({
		etagere,
		abandonnee: false,
		positionDeclaree: null,
		origine: 'directe' as const
	});

	it('une première consignation est une consignation', () => {
		expect(transition(null, pose('a_decouvrir'))).toEqual({
			type: 'consignation',
			etagere: 'a_decouvrir',
			position: null
		});
	});

	it('un déplacement d’étagère est un avancement qui porte l’étagère atteinte', () => {
		expect(transition(pose('a_decouvrir'), pose('termine'))).toEqual({
			type: 'avancement',
			etagere: 'termine',
			position: null
		});
	});

	it('R35 — la reprise est un avancement, pas un type de plus', () => {
		const abandonnee = { ...pose('en_cours'), abandonnee: true };
		expect(transition(abandonnee, pose('en_cours'))).toEqual({
			type: 'avancement',
			etagere: 'en_cours',
			position: null
		});
	});

	it('une position déclarée seule est un avancement qui porte la position', () => {
		expect(transition(pose('en_cours'), { ...pose('en_cours'), positionDeclaree: 0.3 })).toEqual({
			type: 'avancement',
			etagere: null,
			position: 0.3
		});
	});

	it('un état inchangé ne produit rien', () => {
		expect(transition(pose('en_cours'), pose('en_cours'))).toBeNull();
	});

	it('un retrait ne produit rien : il rétracte au lieu d’ajouter', () => {
		expect(transition(pose('termine'), null)).toBeNull();
	});

	it('une entrée dérivée ne produit rien : le recueil parle pour ses numéros', () => {
		const derivee = { ...pose('termine'), origine: 'derivee' as const };
		expect(transition(null, derivee)).toBeNull();
		expect(transition(pose('en_cours'), derivee)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// R41 — le fil est vivant
// ---------------------------------------------------------------------------

describe('le fil (R41)', () => {
	it('recueille les sept sortes de gestes que R41 nomme', async () => {
		const camille = await membre('Camille');
		const numero = await oeuvre('1');
		const roman = await oeuvre('2', 'roman');

		await consigner(db, { membreId: camille.id, oeuvreId: numero, etagere: 'termine', now: T0 });
		await noter(db, { membreId: camille.id, oeuvreId: numero, note: 4, now: T0 + 1 });
		await ecrireAvis(db, {
			membreId: camille.id,
			oeuvreId: numero,
			texte: 'Excellent.',
			now: T0 + 2
		});
		await consigner(db, {
			membreId: camille.id,
			oeuvreId: roman,
			etagere: 'en_cours',
			now: T0 + 3
		});
		await abandonner(db, { membreId: camille.id, oeuvreId: roman, now: T0 + 4 });
		const ordre = await creerOrdre(db, {
			membreId: camille.id,
			titre: 'Par où entrer',
			now: T0 + 5
		});
		if (!ordre.ok) throw new Error('ordre refusé à tort');
		await suivre(db, { membreId: camille.id, ordreId: ordre.ordreId, now: T0 + 6 });

		const fil = await lireFil(db);

		expect(fil.map((e) => e.type)).toEqual([
			'ordre_suivi',
			'ordre_cree',
			'abandon',
			'consignation',
			'avis',
			'note',
			'consignation'
		]);
	});

	it('deux transitions successives sur la même œuvre font deux lignes, là où la file de franchissement n’en garde qu’une', async () => {
		const camille = await membre('Camille');
		const numero = await oeuvre('1');

		await consigner(db, { membreId: camille.id, oeuvreId: numero, etagere: 'en_cours', now: T0 });
		await consigner(db, {
			membreId: camille.id,
			oeuvreId: numero,
			etagere: 'termine',
			now: T0 + 1
		});

		const fil = await lireFil(db);
		expect(fil).toHaveLength(2);
		expect(fil.map((e) => e.etagere)).toEqual(['termine', 'en_cours']);

		// La même histoire, vue par la file du graphe : un seul état, le dernier.
		const enAttente = await franchissementEnAttente(db, camille.id, numero);
		expect(enAttente?.direction).toBe('atteinte');
	});

	it('R35 — reprendre une œuvre terminée s’inscrit au fil comme un avancement', async () => {
		const camille = await membre('Camille');
		const numero = await oeuvre('1');

		await consigner(db, { membreId: camille.id, oeuvreId: numero, etagere: 'termine', now: T0 });
		await reprendre(db, { membreId: camille.id, oeuvreId: numero, now: T0 + 1 });

		const fil = await lireFil(db);
		expect(fil[0]).toMatchObject({ type: 'avancement', etagere: 'en_cours' });
	});

	it('R23 — déclarer une position s’inscrit au fil avec la position', async () => {
		const camille = await membre('Camille');
		const roman = await oeuvre('1', 'roman');

		await consigner(db, { membreId: camille.id, oeuvreId: roman, etagere: 'en_cours', now: T0 });
		await declarerPosition(db, {
			membreId: camille.id,
			oeuvreId: roman,
			saisie: { unite: 'pourcentage', valeur: 30 },
			now: T0 + 1
		});

		const fil = await lireFil(db);
		expect(fil[0]).toMatchObject({ type: 'avancement', position: 0.3 });
	});

	it('renoter remplace la ligne au lieu d’en ajouter une', async () => {
		const camille = await membre('Camille');
		const numero = await oeuvre('1');

		await consigner(db, { membreId: camille.id, oeuvreId: numero, etagere: 'termine', now: T0 });
		await noter(db, { membreId: camille.id, oeuvreId: numero, note: 4, now: T0 + 1 });
		await noter(db, { membreId: camille.id, oeuvreId: numero, note: 5, now: T0 + 2 });

		const notes = (await lireFil(db)).filter((ligne) => ligne.type === 'note');
		expect(notes).toHaveLength(1);
		expect(notes[0].note).toBe(5);
	});

	it('retirer la note l’efface du fil plutôt que d’annoncer qu’elle a été retirée', async () => {
		const camille = await membre('Camille');
		const numero = await oeuvre('1');

		await consigner(db, { membreId: camille.id, oeuvreId: numero, etagere: 'termine', now: T0 });
		await noter(db, { membreId: camille.id, oeuvreId: numero, note: 4, now: T0 + 1 });
		await noter(db, { membreId: camille.id, oeuvreId: numero, note: null, now: T0 + 2 });

		const fil = await lireFil(db);
		expect(fil.map((e) => e.type)).toEqual(['consignation']);
	});

	it('R37 — supprimer son avis le retire du fil', async () => {
		const camille = await membre('Camille');
		const numero = await oeuvre('1');

		await consigner(db, { membreId: camille.id, oeuvreId: numero, etagere: 'termine', now: T0 });
		const ecrit = await ecrireAvis(db, {
			membreId: camille.id,
			oeuvreId: numero,
			texte: 'Un mot.',
			now: T0 + 1
		});
		if (!ecrit.ok) throw new Error('avis refusé à tort');

		await supprimerAvis(db, { membreId: camille.id, avisId: ecrit.avisId });

		const fil = await lireFil(db);
		expect(fil.map((e) => e.type)).toEqual(['consignation']);
	});

	it('R17 — un fork est un ordre créé, pas un huitième type d’événement', async () => {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const ordre = await creerOrdre(db, { membreId: camille.id, titre: 'Le mien', now: T0 });
		if (!ordre.ok) throw new Error('ordre refusé à tort');

		await forker(db, { membreId: antoine.id, ordreId: ordre.ordreId, now: T0 + 1 });

		const fil = await lireFil(db);
		expect(fil.map((e) => e.type)).toEqual(['ordre_cree', 'ordre_cree']);
	});

	it('suivre deux fois le même ordre n’écrit qu’une ligne', async () => {
		const camille = await membre('Camille');
		const ordre = await creerOrdre(db, { membreId: camille.id, titre: 'Le mien', now: T0 });
		if (!ordre.ok) throw new Error('ordre refusé à tort');

		await suivre(db, { membreId: camille.id, ordreId: ordre.ordreId, now: T0 + 1 });
		await suivre(db, { membreId: camille.id, ordreId: ordre.ordreId, now: T0 + 2 });

		const fil = await lireFil(db);
		expect(fil.filter((e) => e.type === 'ordre_suivi')).toHaveLength(1);
	});

	it('un ordre supprimé quitte le fil', async () => {
		const camille = await membre('Camille');
		const ordre = await creerOrdre(db, { membreId: camille.id, titre: 'Le mien', now: T0 });
		if (!ordre.ok) throw new Error('ordre refusé à tort');

		await supprimerOrdre(db, { membreId: camille.id, ordreId: ordre.ordreId });

		expect(await lireFil(db)).toEqual([]);
	});

	it('une cascade de recueil n’écrit qu’un événement, celui du recueil', async () => {
		const camille = await membre('Camille');
		const omnibus = await recueil('omni', ['1', '2', '3']);

		await consigner(db, {
			membreId: camille.id,
			oeuvreId: omnibus.id,
			etagere: 'termine',
			now: T0
		});
		await deroulerCascades(db, { now: T0 + 1 });

		const fil = await lireFil(db);
		expect(fil).toHaveLength(1);
		expect(fil[0]).toMatchObject({ type: 'consignation', etagere: 'termine' });
		expect(fil[0].oeuvre?.id).toBe(omnibus.id);
	});

	it('un fil vide est une liste vide, pas une erreur', async () => {
		expect(await lireFil(db)).toEqual([]);
	});

	it('un événement sur une œuvre disparue du catalogue se lit encore', async () => {
		// Ce qu'une fusion de doublons laisse derrière elle : l'événement a bien eu
		// lieu, l'œuvre n'existe plus. Le fil ne doit ni échouer ni faire un trou.
		const camille = await membre('Camille');
		await db.insert(feedEvents).values({
			memberId: camille.id,
			type: 'consignation',
			workId: 'oeuvre-fusionnee',
			shelf: 'termine',
			createdAt: T0
		});

		const fil = await lireFil(db);
		expect(fil).toHaveLength(1);
		expect(fil[0].oeuvre).toBeNull();

		const charge = utile(await chargerFil(evenement(camille)));
		expect(lignes(charge)[0].oeuvre).toEqual({
			id: null,
			libelle: 'une œuvre',
			masque: false
		});
	});
});

// ---------------------------------------------------------------------------
// R32 — le titre dans le fil
// ---------------------------------------------------------------------------

describe('le masquage des titres (R32, AE13)', () => {
	/** Camille termine une œuvre qu'Antoine a posée sur « à découvrir ». */
	async function scene() {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const numero = await oeuvre('1');

		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: numero,
			etagere: 'a_decouvrir',
			now: T0
		});
		await consigner(db, {
			membreId: camille.id,
			oeuvreId: numero,
			etagere: 'termine',
			now: T0 + 1
		});

		return { camille, antoine, numero };
	}

	it('AE13 — le titre est remplacé par le type de l’œuvre pour qui l’a mise en « à découvrir »', async () => {
		const { antoine } = await scene();

		const charge = utile(await chargerFil(evenement(antoine)));
		const evenementDeCamille = lignes(charge).find((e) => e.acteur === 'Camille');

		expect(evenementDeCamille?.oeuvre).toMatchObject({
			libelle: 'un numéro de comic',
			masque: true
		});
	});

	it('le titre masqué n’est nulle part dans la charge utile brute', async () => {
		// Antoine reçoit le numéro par la cascade d'un recueil qu'il veut découvrir :
		// il l'a donc en « à découvrir » sans avoir produit d'événement dessus, et le
		// seul événement du fil qui le concerne est celui de Camille.
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		// Deux numéros, dont un seul sera atteint : la remontée de R9 n'a donc pas
		// lieu, et le seul événement masquable du fil est celui de Camille.
		const omnibus = await recueil('omni', ['1', '2']);

		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: omnibus.id,
			etagere: 'a_decouvrir',
			now: T0
		});
		await deroulerCascades(db, { now: T0 + 1 });
		await consigner(db, {
			membreId: camille.id,
			oeuvreId: omnibus.numeros[0],
			etagere: 'termine',
			now: T0 + 2
		});

		const charge = utile(await chargerFil(evenement(antoine)));

		expect(lignes(charge).find((e) => e.acteur === 'Camille')?.oeuvre).toMatchObject({
			libelle: 'un numéro de comic',
			masque: true
		});
		expect(chaines(charge)).not.toContain('Œuvre 1');
		expect(JSON.stringify(charge)).not.toContain('Œuvre 1');
	});

	it('le même événement affiche son titre pour un membre qui n’a pas l’œuvre en « à découvrir »', async () => {
		const { numero } = await scene();
		const lea = await membre('Léa');

		const charge = utile(await chargerFil(evenement(lea)));
		const evenementDeCamille = lignes(charge).find((e) => e.acteur === 'Camille');

		expect(evenementDeCamille?.oeuvre).toEqual({
			id: numero,
			libelle: 'Œuvre 1',
			masque: false
		});
	});

	it('un membre voit toujours le titre de ses propres événements', async () => {
		const { antoine } = await scene();

		const charge = utile(await chargerFil(evenement(antoine)));
		const sien = lignes(charge).find((e) => e.acteur === 'Antoine');

		expect(sien?.oeuvre).toMatchObject({ libelle: 'Œuvre 1', masque: false });
	});

	it('une œuvre atteinte cesse d’être protégée, même restée en « à découvrir »', async () => {
		const { antoine, numero } = await scene();
		// Abandonner sans changer d'étagère : l'œuvre est atteinte (R3).
		await abandonner(db, { membreId: antoine.id, oeuvreId: numero, now: T0 + 2 });

		const charge = utile(await chargerFil(evenement(antoine)));
		const evenementDeCamille = lignes(charge).find((e) => e.acteur === 'Camille');

		expect(evenementDeCamille?.oeuvre).toMatchObject({ libelle: 'Œuvre 1', masque: false });
	});

	it('chaque type d’œuvre a son libellé de remplacement', async () => {
		const antoine = await membre('Antoine');
		const camille = await membre('Camille');
		const film = await oeuvre('film', 'film');
		const roman = await oeuvre('roman', 'roman');

		for (const id of [film, roman]) {
			await consigner(db, { membreId: antoine.id, oeuvreId: id, etagere: 'a_decouvrir', now: T0 });
			await consigner(db, { membreId: camille.id, oeuvreId: id, etagere: 'termine', now: T0 + 1 });
		}

		const charge = utile(await chargerFil(evenement(antoine)));
		const libelles = lignes(charge)
			.filter((e) => e.acteur === 'Camille')
			.map((e) => e.oeuvre.libelle);

		expect(libelles).toEqual(expect.arrayContaining(['un film', 'un roman']));
	});
});

// ---------------------------------------------------------------------------
// L'avis, dans le fil
// ---------------------------------------------------------------------------

describe('le texte d’un avis n’entre jamais dans le fil', () => {
	const SPOILER = 'Le vilain est en réalité son père.';

	it('ni pour un lecteur qui n’a pas atteint l’œuvre, ni dans la charge utile brute', async () => {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const numero = await oeuvre('1');

		await consigner(db, { membreId: camille.id, oeuvreId: numero, etagere: 'termine', now: T0 });
		await ecrireAvis(db, { membreId: camille.id, oeuvreId: numero, texte: SPOILER, now: T0 + 1 });

		const charge = utile(await chargerFil(evenement(antoine)));

		expect(lignes(charge)[0].type).toBe('avis');
		expect(chaines(charge)).not.toContain(SPOILER);
		expect(JSON.stringify(charge)).not.toContain('son père');
	});

	it('ni même pour un lecteur qui a atteint l’œuvre : le fil n’est pas la page de l’œuvre', async () => {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const numero = await oeuvre('1');

		await consigner(db, { membreId: camille.id, oeuvreId: numero, etagere: 'termine', now: T0 });
		await ecrireAvis(db, { membreId: camille.id, oeuvreId: numero, texte: SPOILER, now: T0 + 1 });
		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: numero,
			etagere: 'termine',
			now: T0 + 2
		});

		const charge = utile(await chargerFil(evenement(antoine)));
		expect(JSON.stringify(charge)).not.toContain('son père');

		// Sur la page de l'œuvre, en revanche, R27 le lui ouvre.
		const surLOeuvre = utile(await chargerOeuvre(evenement(antoine, { id: numero })));
		expect(surLOeuvre.avis[0].texte).toBe(SPOILER);
	});

	it('refuse le fil sans session', async () => {
		await expect(chargerFil(evenement(null))).rejects.toMatchObject({ status: 401 });
	});
});

// ---------------------------------------------------------------------------
// R42, R43 — la provenance et sa conséquence
// ---------------------------------------------------------------------------

describe('provenance et recommandation suivie (R42, R43)', () => {
	it('R42 — la consignation affiche d’où elle vient', async () => {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const numero = await oeuvre('1');

		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: numero,
			etagere: 'a_decouvrir',
			provenance: { type: 'membre', membreId: camille.id },
			now: T0
		});

		const charge = utile(await chargerFil(evenement(antoine)));
		expect(lignes(charge)[0].provenance?.libelle).toBe('sur la recommandation de Camille');
	});

	it('R43 — atteindre une œuvre venue d’un autre membre le notifie', async () => {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const numero = await oeuvre('1');

		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: numero,
			etagere: 'a_decouvrir',
			provenance: { type: 'membre', membreId: camille.id },
			now: T0
		});

		// La simple consignation n'informe personne : R43 parle d'atteinte.
		expect(await notificationsDe(db, camille.id)).toEqual([]);

		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: numero,
			etagere: 'termine',
			now: T0 + 1
		});

		const recues = await notificationsDe(db, camille.id);
		expect(recues).toHaveLength(1);
		expect(recues[0]).toMatchObject({
			acteur: { id: antoine.id, nom: 'Antoine' },
			nombreDOeuvres: 1
		});
		expect(recues[0].oeuvre?.id).toBe(numero);
	});

	it('R43 — une provenance de catalogue ou d’ordre n’informe personne', async () => {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const numero = await oeuvre('1');

		await consigner(db, { membreId: antoine.id, oeuvreId: numero, etagere: 'termine', now: T0 });

		expect(await notificationsDe(db, camille.id)).toEqual([]);
		expect(await notificationsDe(db, antoine.id)).toEqual([]);
	});

	it('R43 — une cascade de recueil produit une notification agrégée, pas une par numéro', async () => {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const omnibus = await recueil('omni', ['1', '2', '3', '4', '5']);

		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: omnibus.id,
			etagere: 'termine',
			provenance: { type: 'membre', membreId: camille.id },
			now: T0
		});
		await deroulerCascades(db, { now: T0 + 1 });

		const recues = await notificationsDe(db, camille.id);
		expect(recues).toHaveLength(1);
		expect(recues[0].oeuvre?.id).toBe(omnibus.id);
		// Le recueil, plus ses cinq numéros : un compteur, pas six messages.
		expect(recues[0].nombreDOeuvres).toBe(6);
	});

	it('une notification lue cesse d’agréger, et la suivante repart à un', async () => {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const numero = await oeuvre('1');

		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: numero,
			etagere: 'termine',
			provenance: { type: 'membre', membreId: camille.id },
			now: T0
		});
		await marquerNotificationsLues(db, camille.id, T0 + 1);
		expect(await notificationsDe(db, camille.id)).toEqual([]);

		await reprendre(db, { membreId: antoine.id, oeuvreId: numero, now: T0 + 2 });
		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: numero,
			etagere: 'termine',
			now: T0 + 3
		});

		const recues = await notificationsDe(db, camille.id);
		expect(recues).toHaveLength(1);
		expect(recues[0].nombreDOeuvres).toBe(1);
	});

	it('personne n’est informé de s’être suivi soi-même', async () => {
		const camille = await membre('Camille');
		const numero = await oeuvre('1');

		await consigner(db, {
			membreId: camille.id,
			oeuvreId: numero,
			etagere: 'termine',
			provenance: { type: 'membre', membreId: camille.id },
			now: T0
		});

		expect(await notificationsDe(db, camille.id)).toEqual([]);
	});

	it('un membre ne vide que sa propre liste', async () => {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const numero = await oeuvre('1');

		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: numero,
			etagere: 'termine',
			provenance: { type: 'membre', membreId: camille.id },
			now: T0
		});

		// Antoine poste tout ce qu'il peut forger : seule sa session compte.
		await actionsFil.lu(evenement(antoine, {}, { membre: camille.id }));

		expect(await notificationsDe(db, camille.id)).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// R33 — le retrait rétracte
// ---------------------------------------------------------------------------

describe('retirer une consignation rétracte le fil (R33)', () => {
	it('emporte tout ce que le couple membre-œuvre y avait mis', async () => {
		const camille = await membre('Camille');
		const numero = await oeuvre('1');

		await consigner(db, { membreId: camille.id, oeuvreId: numero, etagere: 'en_cours', now: T0 });
		await consigner(db, {
			membreId: camille.id,
			oeuvreId: numero,
			etagere: 'termine',
			now: T0 + 1
		});
		await noter(db, { membreId: camille.id, oeuvreId: numero, note: 5, now: T0 + 2 });
		await ecrireAvis(db, { membreId: camille.id, oeuvreId: numero, texte: 'Bien.', now: T0 + 3 });
		expect(await lireFil(db)).toHaveLength(4);

		await retirer(db, { membreId: camille.id, oeuvreId: numero, now: T0 + 4 });

		expect(await lireFil(db)).toEqual([]);
	});

	it('ne touche pas au fil des autres membres sur la même œuvre', async () => {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const numero = await oeuvre('1');

		await consigner(db, { membreId: camille.id, oeuvreId: numero, etagere: 'termine', now: T0 });
		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: numero,
			etagere: 'termine',
			now: T0 + 1
		});

		await retirer(db, { membreId: camille.id, oeuvreId: numero, now: T0 + 2 });

		const fil = await lireFil(db);
		expect(fil).toHaveLength(1);
		expect(fil[0].acteur.id).toBe(antoine.id);
	});
});

// ---------------------------------------------------------------------------
// R38 — le départ d'un membre
// ---------------------------------------------------------------------------

describe('le départ d’un membre (R38)', () => {
	/** Camille écrit, note, crée un ordre, puis quitte le groupe. */
	async function partante() {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const numero = await oeuvre('1');

		await consigner(db, { membreId: camille.id, oeuvreId: numero, etagere: 'termine', now: T0 });
		await noter(db, { membreId: camille.id, oeuvreId: numero, note: 4.5, now: T0 + 1 });
		await ecrireAvis(db, {
			membreId: camille.id,
			oeuvreId: numero,
			texte: 'Un souvenir.',
			now: T0 + 2
		});
		const ordre = await creerOrdre(db, {
			membreId: camille.id,
			titre: 'Par où entrer',
			now: T0 + 3
		});
		if (!ordre.ok) throw new Error('ordre refusé à tort');

		const session = await createSession(db, camille.id, { now: T0 });
		await markMemberAsLeft(db, camille.id, T0 + 10);

		return { camille, antoine, numero, ordreId: ordre.ordreId, session };
	}

	it('ses sessions sont refusées immédiatement', async () => {
		const { session } = await partante();
		expect(await resolveSession(db, session, T0 + 11)).toBeNull();
	});

	it('il ne peut plus émettre d’invitation', async () => {
		const { camille } = await partante();
		expect(await createInvitation(db, { createdBy: camille.id, now: T0 + 11 })).toEqual({
			ok: false,
			motif: 'membre parti'
		});
	});

	it('ses avis restent visibles et anonymisés', async () => {
		const { antoine, numero } = await partante();
		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: numero,
			etagere: 'termine',
			now: T0 + 11
		});

		const charge = utile(await chargerOeuvre(evenement(antoine, { id: numero })));

		expect(charge.avis[0]).toMatchObject({ texte: 'Un souvenir.', note: 4.5 });
		expect(charge.avis[0].auteur.nom).toBe('Un membre parti');
		expect(chaines(charge)).not.toContain('Camille');
	});

	it('ses ordres restent en place et suivables', async () => {
		const { antoine, ordreId } = await partante();

		expect(await suivre(db, { membreId: antoine.id, ordreId, now: T0 + 11 })).toEqual({ ok: true });

		const charge = utile(await chargerOrdre(evenement(antoine, { id: ordreId })));
		expect(charge.ordre.auteur).toMatchObject({ nom: 'un membre parti', parti: true });
		expect(charge.ordre.suivi).toBe(true);
	});

	it('le fil ne le nomme plus, y compris dans ses événements passés', async () => {
		const { antoine } = await partante();

		const fil = await lireFil(db);
		expect(fil.every((e) => e.acteur.nom === null)).toBe(true);

		const charge = utile(await chargerFil(evenement(antoine)));
		expect(lignes(charge).every((e) => e.acteur === 'Un membre parti')).toBe(true);
		expect(chaines(charge)).not.toContain('Camille');
	});

	it('un événement produit par un membre parti pendant qu’un autre lit ne fait pas échouer le fil', async () => {
		const { antoine, numero } = await partante();

		// L'événement existait déjà, le départ vient de le rendre anonyme, et un
		// autre membre continue d'agir sur la même œuvre.
		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: numero,
			etagere: 'termine',
			now: T0 + 11
		});

		const charge = utile(await chargerFil(evenement(antoine)));
		const acteurs = lignes(charge).map((e) => e.acteur);

		expect(acteurs).toContain('Antoine');
		expect(acteurs).toContain('Un membre parti');
	});

	it('sa recommandation continue de le désigner sans le nommer', async () => {
		const { camille, antoine, numero } = await partante();
		const autre = await oeuvre('2');

		await consigner(db, {
			membreId: antoine.id,
			oeuvreId: autre,
			etagere: 'a_decouvrir',
			provenance: { type: 'membre', membreId: camille.id },
			now: T0 + 11
		});
		expect(numero).toBeDefined();

		const charge = utile(await chargerFil(evenement(antoine)));
		expect(lignes(charge)[0].provenance?.libelle).toBe('sur la recommandation de un membre parti');
		expect(chaines(charge)).not.toContain('Camille');
	});
});

// ---------------------------------------------------------------------------
// Le harnais
// ---------------------------------------------------------------------------

describe('le harnais', () => {
	it('la base injectée est bien celle des routes', async () => {
		const camille = await membre('Camille');
		const relu = await db.query.members.findFirst({ where: eq(members.id, camille.id) });
		expect(relu?.displayName).toBe('Camille');

		const compte = await db.select({ id: works.id }).from(works);
		expect(compte).toEqual([]);
	});
});
