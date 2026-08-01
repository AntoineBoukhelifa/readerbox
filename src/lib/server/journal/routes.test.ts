import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDb } from '../db/testing';
import type { Db } from '../db';
import { journalEntries, members, type Member } from '../db/schema';
import { ingererOeuvre } from '../catalog/ingest';
import { T0, oeuvreDistante } from '../catalog/testing';
import type { TypeOeuvre } from '../catalog/sources/types';
import { appliquerAppui, lireConsignation } from './entries';
import { lireFil } from '../feed/events';
import { ajouterEntree, creerOrdre } from '../orders/orders';

/**
 * La surface de consignation, éprouvée sur ce qu'elle écrit.
 *
 * Toute la mécanique existe depuis U4 ; ce fichier ne la reteste pas — c'est le
 * travail de `entries.test.ts` — mais vérifie que la page la **rend jouable** et
 * qu'elle ne rouvre rien de ce que U4 avait fermé :
 *
 * - **l'autorisation par le couple membre-œuvre.** Aucune action ne lit
 *   d'identifiant de membre, d'entrée ni d'avis : il n'y a rien à forger, et
 *   c'est ce qui se voit ici et nulle part ailleurs ;
 * - **la provenance de R42.** Elle vient d'un paramètre d'URL, donc d'une valeur
 *   que le membre contrôle. Elle n'est retenue que si elle énonce un fait
 *   vérifiable : l'ordre existe et contient l'œuvre ;
 * - **chaque geste passe par `entries.ts`**, ce qui se constate au fil du groupe :
 *   une action qui écrirait en base depuis la route ne produirait aucun
 *   événement.
 *
 * Même harnais qu'en U6 et U7 : la base de test est injectée par substitution de
 * `getDb`, tout le reste des routes s'exécute tel quel.
 */
const contexte = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('$lib/server/db', async (importOriginal) => {
	const original = await importOriginal<typeof import('../db')>();
	return { ...original, getDb: () => contexte.db };
});

const { load: chargerOeuvre, actions: actionsOeuvre } =
	await import('../../../routes/work/[id]/+page.server');

let db: Db;

beforeEach(() => {
	db = createTestDb();
	contexte.db = db;
});

// ---------------------------------------------------------------------------
// Le harnais
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

/** Un événement de requête réduit à ce que la route lit. */
function evenement<T>(
	membreConnecte: Member | null,
	params: Record<string, string>,
	champs: Record<string, string> = {},
	requete = ''
): T {
	const corps = new FormData();
	for (const [nom, valeur] of Object.entries(champs)) corps.set(nom, valeur);

	return {
		params,
		url: new URL(`http://localhost/${requete}`),
		locals: { member: membreConnecte },
		platform: { env: { DB: {} } },
		request: new Request('http://localhost/', { method: 'POST', body: corps })
	} as unknown as T;
}

function utile<T>(charge: T): Exclude<T, void> {
	return charge as Exclude<T, void>;
}

/** La ligne brute, pour voir ce qui est réellement stocké. */
async function ligneDe(membreId: string, oeuvreId: string) {
	return db.query.journalEntries.findFirst({
		where: and(eq(journalEntries.memberId, membreId), eq(journalEntries.workId, oeuvreId))
	});
}

/** Un ordre qui contient l'œuvre donnée, pour la provenance de R42. */
async function ordreContenant(auteur: Member, oeuvreId: string): Promise<string> {
	const creation = await creerOrdre(db, { membreId: auteur.id, titre: 'Par où entrer', now: T0 });
	if (!creation.ok) throw new Error(creation.motif);
	await ajouterEntree(db, {
		membreId: auteur.id,
		ordreId: creation.ordreId,
		oeuvreId,
		now: T0
	});
	return creation.ordreId;
}

// ---------------------------------------------------------------------------
// Les étagères (R1, R3)
// ---------------------------------------------------------------------------

describe('poser l’œuvre sur une étagère depuis la page (R1)', () => {
	it('les trois étagères se posent, et seule « terminé » atteint l’œuvre', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');

		for (const [etagere, atteinte] of [
			['a_decouvrir', false],
			['en_cours', false],
			['termine', true]
		] as const) {
			await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere }));

			const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
			expect(charge.moi).toMatchObject({ consignee: true, etagere, abandonnee: false, atteinte });
		}
	});

	it('reconsigner déplace l’étagère au lieu de créer une seconde entrée', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');

		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'termine' }));

		const entrees = await db.query.journalEntries.findMany({
			where: eq(journalEntries.memberId, lecteur.id)
		});
		expect(entrees).toHaveLength(1);
		expect(entrees[0].shelf).toBe('termine');
	});

	it('une étagère inventée est refusée, et rien n’est consigné', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');

		const resultat = await actionsOeuvre.consigner(
			evenement(lecteur, { id: oeuvreId }, { etagere: 'abandonne' })
		);

		expect(resultat).toMatchObject({ status: 400 });
		expect(await ligneDe(lecteur.id, oeuvreId)).toBeUndefined();
	});

	it('une œuvre inconnue est un refus typé, pas une page en erreur', async () => {
		const lecteur = await membre('Camille');

		const resultat = await actionsOeuvre.consigner(
			evenement(lecteur, { id: 'forgée' }, { etagere: 'en_cours' })
		);

		expect(resultat).toMatchObject({ status: 404 });
	});
});

// ---------------------------------------------------------------------------
// L'abandon et la reprise (R2, R35)
// ---------------------------------------------------------------------------

describe('abandonner puis reprendre (R2, R35)', () => {
	it('l’abandon atteint l’œuvre sans exiger de note, la reprise la remet en cours', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));

		await actionsOeuvre.abandonner(evenement(lecteur, { id: oeuvreId }));
		let charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi).toMatchObject({ abandonnee: true, atteinte: true, etagere: 'en_cours' });

		await actionsOeuvre.reprendre(evenement(lecteur, { id: oeuvreId }));
		charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi).toMatchObject({ abandonnee: false, atteinte: false, etagere: 'en_cours' });
	});

	it('reposer une étagère lève l’abandon : ce n’est pas une quatrième étagère', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));
		await actionsOeuvre.abandonner(evenement(lecteur, { id: oeuvreId }));

		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'termine' }));

		const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi).toMatchObject({ abandonnee: false, etagere: 'termine', atteinte: true });
	});

	it('abandonner ce qu’on n’a pas consigné est refusé et le dit', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');

		const resultat = await actionsOeuvre.abandonner(evenement(lecteur, { id: oeuvreId }));

		expect(resultat).toMatchObject({
			status: 404,
			data: { message: 'Pose d’abord cette œuvre sur une étagère.' }
		});
	});
});

// ---------------------------------------------------------------------------
// Le retrait (R33)
// ---------------------------------------------------------------------------

describe('retirer la consignation (R33)', () => {
	it('emporte la note et l’avis, et le dit', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'termine' }));
		await actionsOeuvre.noter(evenement(lecteur, { id: oeuvreId }, { note: '4.5' }));
		await actionsOeuvre.ecrireAvis(evenement(lecteur, { id: oeuvreId }, { texte: 'Très bien.' }));

		const resultat = await actionsOeuvre.retirer(evenement(lecteur, { id: oeuvreId }));

		expect(resultat).toMatchObject({
			fait: true,
			message: 'Consignation retirée, avec ta note et ton avis.'
		});
		expect(await ligneDe(lecteur.id, oeuvreId)).toBeUndefined();

		const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi).toMatchObject({ consignee: false, note: null, avis: null });
		expect(charge.avis).toEqual([]);
		expect(charge.agregat).toEqual({ noteMoyenne: null, nombreDeNotes: 0, nombreDAvis: 0 });
	});

	it('R34 — l’entrée que soutient un recueil survit au retrait, et le message le dit', async () => {
		const lecteur = await membre('Camille');
		const omnibus = await oeuvre('omnibus', 'recueil');
		const numero = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(lecteur, { id: omnibus }, { etagere: 'en_cours' }));
		await appliquerAppui(db, {
			membreId: lecteur.id,
			oeuvreId: numero,
			contenantId: omnibus,
			now: T0
		});

		// Le membre fait sienne l'entrée dérivée, puis se ravise.
		await actionsOeuvre.consigner(evenement(lecteur, { id: numero }, { etagere: 'termine' }));
		expect(utile(await chargerOeuvre(evenement(lecteur, { id: numero }))).moi.recueils).toBe(1);

		const resultat = await actionsOeuvre.retirer(evenement(lecteur, { id: numero }));

		expect(resultat).toMatchObject({ fait: true });
		expect((resultat as { message: string }).message).toContain('reste dans ton journal');
		expect(await ligneDe(lecteur.id, numero)).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// La position (R23, R24)
// ---------------------------------------------------------------------------

describe('déclarer sa position (R23)', () => {
	it('une saisie en pages est stockée en fraction', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('roman', 'roman');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));

		await actionsOeuvre.position(
			evenement(lecteur, { id: oeuvreId }, { unite: 'page', valeur: '120', longueur: '400' })
		);

		const ligne = await ligneDe(lecteur.id, oeuvreId);
		expect(ligne?.declaredPosition).toBeCloseTo(0.3);
		expect(ligne?.totalLength).toBe(400);

		const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi.position).toBeCloseTo(0.3);
	});

	it('la longueur déjà connue n’est pas à retaper à chaque page tournée', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('roman', 'roman');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));
		await actionsOeuvre.position(
			evenement(lecteur, { id: oeuvreId }, { unite: 'page', valeur: '100', longueur: '400' })
		);

		await actionsOeuvre.position(
			evenement(lecteur, { id: oeuvreId }, { unite: 'page', valeur: '200' })
		);

		expect((await ligneDe(lecteur.id, oeuvreId))?.declaredPosition).toBeCloseTo(0.5);
	});

	it('une virgule est un nombre : c’est ce que produit un clavier français', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('roman', 'roman');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));

		await actionsOeuvre.position(
			evenement(lecteur, { id: oeuvreId }, { unite: 'pourcentage', valeur: '42,5' })
		);

		expect((await ligneDe(lecteur.id, oeuvreId))?.declaredPosition).toBeCloseTo(0.425);
	});

	it('une page sans longueur connue est refusée, jamais devinée', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('roman', 'roman');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));

		const resultat = await actionsOeuvre.position(
			evenement(lecteur, { id: oeuvreId }, { unite: 'page', valeur: '120' })
		);

		expect(resultat).toMatchObject({
			status: 400,
			data: { message: 'Pour saisir une page, dis aussi combien de pages compte ton édition.' }
		});
		expect((await ligneDe(lecteur.id, oeuvreId))?.declaredPosition).toBe(null);
	});

	it('déclarer une position sur une œuvre « à découvrir » la passe en cours', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('roman', 'roman');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'a_decouvrir' }));

		await actionsOeuvre.position(
			evenement(lecteur, { id: oeuvreId }, { unite: 'pourcentage', valeur: '10' })
		);

		const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi).toMatchObject({ etagere: 'en_cours', atteinte: false });
	});
});

// ---------------------------------------------------------------------------
// La note (R4, R37)
// ---------------------------------------------------------------------------

describe('noter, renoter, retirer sa note (R4, R37)', () => {
	it('la note se pose, se remplace et se retire sans toucher la consignation', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'termine' }));

		await actionsOeuvre.noter(evenement(lecteur, { id: oeuvreId }, { note: '3.5' }));
		expect(utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId }))).moi.note).toBe(3.5);

		await actionsOeuvre.noter(evenement(lecteur, { id: oeuvreId }, { note: '5' }));
		let charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi.note).toBe(5);
		expect(charge.agregat).toMatchObject({ noteMoyenne: 5, nombreDeNotes: 1 });

		await actionsOeuvre.retirerNote(evenement(lecteur, { id: oeuvreId }));
		charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi).toMatchObject({ note: null, consignee: true, etagere: 'termine' });
		expect(charge.agregat).toMatchObject({ noteMoyenne: null, nombreDeNotes: 0 });
	});

	it('une note hors des demi-étoiles est refusée et le dit', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'termine' }));

		for (const note of ['0', '4.3', '6', 'excellent']) {
			const resultat = await actionsOeuvre.noter(evenement(lecteur, { id: oeuvreId }, { note }));
			expect(resultat).toMatchObject({
				status: 400,
				data: { message: 'Une note va de 0,5 à 5 étoiles, par demi-étoiles.' }
			});
		}

		expect((await ligneDe(lecteur.id, oeuvreId))?.rating).toBe(null);
	});
});

// ---------------------------------------------------------------------------
// L'avis (R5, R25, R37)
// ---------------------------------------------------------------------------

describe('écrire, modifier et supprimer son avis (R5, R37)', () => {
	it('l’avis s’écrit, se modifie et se supprime sans perdre la note', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'termine' }));
		await actionsOeuvre.noter(evenement(lecteur, { id: oeuvreId }, { note: '4' }));

		await actionsOeuvre.ecrireAvis(evenement(lecteur, { id: oeuvreId }, { texte: 'Un mot.' }));
		let charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi.avis?.texte).toBe('Un mot.');

		await actionsOeuvre.modifierAvis(
			evenement(lecteur, { id: oeuvreId }, { texte: 'Un mot, corrigé.' })
		);
		charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi.avis?.texte).toBe('Un mot, corrigé.');
		expect(charge.agregat.nombreDAvis).toBe(1);

		await actionsOeuvre.supprimerAvis(evenement(lecteur, { id: oeuvreId }));
		charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi.avis).toBe(null);
		expect(charge.moi.note).toBe(4);
		expect(charge.agregat).toMatchObject({ nombreDAvis: 0, nombreDeNotes: 1 });
	});

	it('un avis vide est refusé et la saisie n’est pas perdue', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'termine' }));

		const resultat = await actionsOeuvre.ecrireAvis(
			evenement(lecteur, { id: oeuvreId }, { texte: '   ' })
		);

		expect(resultat).toMatchObject({
			status: 400,
			data: { message: 'Un avis vide n’est pas un avis.', texte: '   ' }
		});
	});

	it('modifier un avis qu’on n’a pas écrit est « introuvable », pas une erreur serveur', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'termine' }));

		const resultat = await actionsOeuvre.modifierAvis(
			evenement(lecteur, { id: oeuvreId }, { texte: 'Rien à modifier.' })
		);

		expect(resultat).toMatchObject({ status: 404 });
	});
});

describe('R25 — la position obligatoire avant de publier', () => {
	it('sans position, l’avis sur une œuvre longue non atteinte est refusé, et le refus s’explique', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('omnibus', 'recueil');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));

		const resultat = await actionsOeuvre.ecrireAvis(
			evenement(lecteur, { id: oeuvreId }, { texte: 'Le premier tiers est mou.' })
		);

		expect(resultat).toMatchObject({ status: 400 });
		const donnees = (resultat as { data: { message: string; texte: string } }).data;
		expect(donnees.message).toContain('dis d’abord où tu en es');
		expect(donnees.message).toContain('position strictement positive');
		// La saisie revient avec le refus : R25 se rencontre en écrivant.
		expect(donnees.texte).toBe('Le premier tiers est mou.');

		const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi.publicationPossible).toBe(false);
		expect(charge.moi.avis).toBe(null);
	});

	it('une position strictement positive ouvre la publication', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('omnibus', 'recueil');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));

		await actionsOeuvre.position(
			evenement(lecteur, { id: oeuvreId }, { unite: 'pourcentage', valeur: '30' })
		);
		const resultat = await actionsOeuvre.ecrireAvis(
			evenement(lecteur, { id: oeuvreId }, { texte: 'Le premier tiers est mou.' })
		);

		expect(resultat).toEqual({ fait: true });
		const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.moi.publicationPossible).toBe(true);
		expect(charge.moi.avis?.texte).toBe('Le premier tiers est mou.');
	});

	it('une position nulle ne suffit pas : tout lecteur est au moins à zéro', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('omnibus', 'recueil');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));
		await actionsOeuvre.position(
			evenement(lecteur, { id: oeuvreId }, { unite: 'pourcentage', valeur: '0' })
		);

		const resultat = await actionsOeuvre.ecrireAvis(
			evenement(lecteur, { id: oeuvreId }, { texte: 'Rien vu encore.' })
		);

		expect(resultat).toMatchObject({ status: 400 });
	});

	it('une œuvre courte n’exige rien : R25 ne parle que des œuvres longues', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));

		const resultat = await actionsOeuvre.ecrireAvis(
			evenement(lecteur, { id: oeuvreId }, { texte: 'Un numéro sans surprise.' })
		);

		expect(resultat).toEqual({ fait: true });
	});

	it('une œuvre longue atteinte n’exige rien non plus', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('omnibus', 'recueil');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'termine' }));

		const resultat = await actionsOeuvre.ecrireAvis(
			evenement(lecteur, { id: oeuvreId }, { texte: 'Tout lu.' })
		);

		expect(resultat).toEqual({ fait: true });
	});
});

// ---------------------------------------------------------------------------
// La provenance (R42)
// ---------------------------------------------------------------------------

describe('la provenance d’un ordre (R42)', () => {
	it('arriver depuis un ordre enregistre l’ordre comme provenance', async () => {
		const auteur = await membre('Camille');
		const lecteur = await membre('Antoine');
		const oeuvreId = await oeuvre('1');
		const ordreId = await ordreContenant(auteur, oeuvreId);

		const charge = utile(
			await chargerOeuvre(evenement(lecteur, { id: oeuvreId }, {}, `?depuis=${ordreId}`))
		);
		expect(charge.provenance).toEqual({ ordreId, titre: 'Par où entrer', enregistree: false });

		await actionsOeuvre.consigner(
			evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours', depuis: ordreId })
		);

		const consignation = await lireConsignation(db, lecteur.id, oeuvreId);
		expect(consignation?.provenance).toEqual({ type: 'ordre', ordreId });

		// Une fois inscrite, la provenance se lit sans que l'URL la répète.
		const apres = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(apres.provenance).toEqual({ ordreId, titre: 'Par où entrer', enregistree: true });
	});

	it('arriver sans ordre consigne depuis le catalogue', async () => {
		const lecteur = await membre('Antoine');
		const oeuvreId = await oeuvre('1');

		const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.provenance).toBe(null);

		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));

		const consignation = await lireConsignation(db, lecteur.id, oeuvreId);
		expect(consignation?.provenance).toEqual({ type: 'catalogue' });
	});

	it('un ordre qui ne contient pas l’œuvre ne peut pas s’en attribuer la provenance', async () => {
		const auteur = await membre('Camille');
		const lecteur = await membre('Antoine');
		const dedans = await oeuvre('1');
		const dehors = await oeuvre('2');
		const ordreId = await ordreContenant(auteur, dedans);

		// L'ordre existe, il est simplement étranger à cette œuvre-là.
		const charge = utile(
			await chargerOeuvre(evenement(lecteur, { id: dehors }, {}, `?depuis=${ordreId}`))
		);
		expect(charge.provenance).toBe(null);

		await actionsOeuvre.consigner(
			evenement(lecteur, { id: dehors }, { etagere: 'en_cours', depuis: ordreId })
		);

		expect((await lireConsignation(db, lecteur.id, dehors))?.provenance).toEqual({
			type: 'catalogue'
		});
	});

	it('un ordre inventé retombe sur le catalogue plutôt que d’échouer', async () => {
		const lecteur = await membre('Antoine');
		const oeuvreId = await oeuvre('1');

		const resultat = await actionsOeuvre.consigner(
			evenement(lecteur, { id: oeuvreId }, { etagere: 'termine', depuis: 'forgé' })
		);

		expect(resultat).toEqual({ fait: true });
		expect((await lireConsignation(db, lecteur.id, oeuvreId))?.provenance).toEqual({
			type: 'catalogue'
		});
	});

	it('la provenance ne se réécrit pas : elle est celle de la première consignation', async () => {
		const auteur = await membre('Camille');
		const lecteur = await membre('Antoine');
		const oeuvreId = await oeuvre('1');
		const ordreId = await ordreContenant(auteur, oeuvreId);

		await actionsOeuvre.consigner(
			evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours', depuis: ordreId })
		);
		// Le membre revient plus tard depuis le catalogue, et termine.
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'termine' }));

		expect((await lireConsignation(db, lecteur.id, oeuvreId))?.provenance).toEqual({
			type: 'ordre',
			ordreId
		});
	});

	it('la provenance enregistrée l’emporte sur celle qu’annonce l’URL', async () => {
		const auteur = await membre('Camille');
		const lecteur = await membre('Antoine');
		const oeuvreId = await oeuvre('1');
		const premier = await ordreContenant(auteur, oeuvreId);
		const second = await ordreContenant(auteur, oeuvreId);

		await actionsOeuvre.consigner(
			evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours', depuis: premier })
		);

		// Le membre revient par un autre ordre : la page annonce ce qui est inscrit,
		// pas ce qu'il vient de cliquer — la provenance ne se réécrit pas.
		const charge = utile(
			await chargerOeuvre(evenement(lecteur, { id: oeuvreId }, {}, `?depuis=${second}`))
		);
		expect(charge.provenance).toMatchObject({ ordreId: premier, enregistree: true });
	});

	it('la provenance ne désigne jamais un membre : la page n’a pas de champ pour ça', async () => {
		const recommandeur = await membre('Camille');
		const lecteur = await membre('Antoine');
		const oeuvreId = await oeuvre('1');

		// Tout ce qu'un membre peut forger est posté ; aucune action ne le lit.
		await actionsOeuvre.consigner(
			evenement(
				lecteur,
				{ id: oeuvreId },
				{
					etagere: 'termine',
					provenance: 'membre',
					membre: recommandeur.id,
					provenanceMemberId: recommandeur.id
				}
			)
		);

		expect((await lireConsignation(db, lecteur.id, oeuvreId))?.provenance).toEqual({
			type: 'catalogue'
		});
	});
});

// ---------------------------------------------------------------------------
// L'autorisation (le couple membre-œuvre, jamais un identifiant)
// ---------------------------------------------------------------------------

describe('un membre n’agit que sur sa propre consignation', () => {
	it('aucun champ forgé ne fait porter le geste sur un autre', async () => {
		const camille = await membre('Camille');
		const antoine = await membre('Antoine');
		const oeuvreId = await oeuvre('1');

		await actionsOeuvre.consigner(evenement(camille, { id: oeuvreId }, { etagere: 'termine' }));
		await actionsOeuvre.noter(evenement(camille, { id: oeuvreId }, { note: '5' }));
		await actionsOeuvre.ecrireAvis(evenement(camille, { id: oeuvreId }, { texte: 'Le mien.' }));

		const avisDeCamille = (await lireConsignation(db, camille.id, oeuvreId))?.avis;
		const entreeDeCamille = (await lireConsignation(db, camille.id, oeuvreId))?.entreeId;

		// Antoine poste tout ce qu'il peut forger : identifiants de membre,
		// d'entrée et d'avis compris.
		const forge = {
			membre: camille.id,
			membreId: camille.id,
			entree: entreeDeCamille ?? '',
			entreeId: entreeDeCamille ?? '',
			avis: avisDeCamille?.id ?? '',
			avisId: avisDeCamille?.id ?? ''
		};

		await actionsOeuvre.retirer(evenement(antoine, { id: oeuvreId }, forge));
		await actionsOeuvre.abandonner(evenement(antoine, { id: oeuvreId }, forge));
		await actionsOeuvre.noter(evenement(antoine, { id: oeuvreId }, { ...forge, note: '0.5' }));
		await actionsOeuvre.modifierAvis(
			evenement(antoine, { id: oeuvreId }, { ...forge, texte: 'Détourné.' })
		);
		await actionsOeuvre.supprimerAvis(evenement(antoine, { id: oeuvreId }, forge));
		await actionsOeuvre.position(
			evenement(antoine, { id: oeuvreId }, { ...forge, unite: 'pourcentage', valeur: '99' })
		);

		const apres = await lireConsignation(db, camille.id, oeuvreId);
		expect(apres).toMatchObject({
			etagere: 'termine',
			abandonnee: false,
			note: 5
		});
		expect(apres?.avis?.texte).toBe('Le mien.');
		// Et Antoine, lui, n'a toujours rien consigné.
		expect(await lireConsignation(db, antoine.id, oeuvreId)).toBe(null);
	});

	it('refuse tout geste sans session', async () => {
		const oeuvreId = await oeuvre('1');

		for (const action of [
			actionsOeuvre.consigner,
			actionsOeuvre.abandonner,
			actionsOeuvre.reprendre,
			actionsOeuvre.retirer,
			actionsOeuvre.position,
			actionsOeuvre.noter,
			actionsOeuvre.retirerNote,
			actionsOeuvre.ecrireAvis,
			actionsOeuvre.modifierAvis,
			actionsOeuvre.supprimerAvis
		]) {
			expect(await action(evenement(null, { id: oeuvreId }, { etagere: 'termine' }))).toMatchObject(
				{ status: 401 }
			);
		}
	});
});

// ---------------------------------------------------------------------------
// Le fil (R41) — la preuve que tout passe par `entries.ts`
// ---------------------------------------------------------------------------

describe('les gestes de la page produisent les événements du fil (R41)', () => {
	it('consignation, avancement, abandon, note et avis', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('roman', 'roman');

		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'a_decouvrir' }));
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));
		await actionsOeuvre.position(
			evenement(lecteur, { id: oeuvreId }, { unite: 'pourcentage', valeur: '40' })
		);
		await actionsOeuvre.noter(evenement(lecteur, { id: oeuvreId }, { note: '4' }));
		await actionsOeuvre.ecrireAvis(evenement(lecteur, { id: oeuvreId }, { texte: 'À mi-chemin.' }));
		await actionsOeuvre.abandonner(evenement(lecteur, { id: oeuvreId }));

		const types = (await lireFil(db)).map((evenementDuFil) => evenementDuFil.type);
		expect(types).toContain('consignation');
		expect(types).toContain('avancement');
		expect(types).toContain('abandon');
		expect(types).toContain('note');
		expect(types).toContain('avis');
		// Le fil n'a pas de colonne de texte : l'avis y existe sans s'y lire.
		expect(JSON.stringify(await lireFil(db))).not.toContain('À mi-chemin');
	});

	it('retirer la consignation retire du fil ce qu’elle y avait mis (R33)', async () => {
		const lecteur = await membre('Camille');
		const oeuvreId = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'termine' }));
		await actionsOeuvre.noter(evenement(lecteur, { id: oeuvreId }, { note: '4' }));
		await actionsOeuvre.ecrireAvis(evenement(lecteur, { id: oeuvreId }, { texte: 'Un mot.' }));
		expect(await lireFil(db)).not.toHaveLength(0);

		await actionsOeuvre.retirer(evenement(lecteur, { id: oeuvreId }));

		expect(await lireFil(db)).toEqual([]);
	});

	it('R42 — le fil dit d’où venait la consignation', async () => {
		const auteur = await membre('Camille');
		const lecteur = await membre('Antoine');
		const oeuvreId = await oeuvre('1');
		const ordreId = await ordreContenant(auteur, oeuvreId);

		await actionsOeuvre.consigner(
			evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours', depuis: ordreId })
		);

		const consignations = (await lireFil(db)).filter(
			(evenementDuFil) => evenementDuFil.type === 'consignation'
		);
		expect(consignations[0].provenance).toMatchObject({ type: 'ordre', ordreId });
	});
});

// ---------------------------------------------------------------------------
// Le masquage n'a pas bougé
// ---------------------------------------------------------------------------

describe('les gestes ne rouvrent rien du masquage (R27)', () => {
	it('l’avis d’un autre reste masqué jusqu’à ce que la page l’ait fait atteindre', async () => {
		const auteur = await membre('Camille');
		const lecteur = await membre('Antoine');
		const oeuvreId = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(auteur, { id: oeuvreId }, { etagere: 'termine' }));
		await actionsOeuvre.ecrireAvis(
			evenement(auteur, { id: oeuvreId }, { texte: 'Le vilain est son père.' })
		);

		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));
		let charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.avis[0]).toMatchObject({ masque: true, texte: null, mien: false });
		expect(JSON.stringify(charge)).not.toContain('son père');

		// C'est le geste de la page — et lui seul — qui ouvre le texte.
		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'termine' }));
		charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.avis[0]).toMatchObject({ masque: false, texte: 'Le vilain est son père.' });
	});

	it('reprendre une œuvre abandonnée referme les avis du groupe (R35)', async () => {
		const auteur = await membre('Camille');
		const lecteur = await membre('Antoine');
		const oeuvreId = await oeuvre('1');
		await actionsOeuvre.consigner(evenement(auteur, { id: oeuvreId }, { etagere: 'termine' }));
		await actionsOeuvre.ecrireAvis(
			evenement(auteur, { id: oeuvreId }, { texte: 'Le vilain est son père.' })
		);

		await actionsOeuvre.consigner(evenement(lecteur, { id: oeuvreId }, { etagere: 'en_cours' }));
		await actionsOeuvre.abandonner(evenement(lecteur, { id: oeuvreId }));
		expect(utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId }))).avis[0].masque).toBe(
			false
		);

		await actionsOeuvre.reprendre(evenement(lecteur, { id: oeuvreId }));

		const charge = utile(await chargerOeuvre(evenement(lecteur, { id: oeuvreId })));
		expect(charge.avis[0]).toMatchObject({ masque: true, texte: null });
		expect(JSON.stringify(charge)).not.toContain('son père');
	});
});
